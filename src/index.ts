import type { Env, AccountRow } from "./types";
import {
  ApiError,
  boundedInt,
  constantEqual,
  errorResponse,
  json,
  now,
  readJson,
  sha256,
  token,
  uid,
} from "./util";
import { normalize } from "./api";
import { MODELS } from "./gemini/models";
import { validateCookie } from "./gemini/client";
export { GeminiAccount } from "./account";
export function accountStub(env: Env, id: string) {
  const location = env.ACCOUNT_LOCATION_HINT;
  const options =
    location && location !== "auto"
      ? { locationHint: location as DurableObjectLocationHint }
      : undefined;
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id), options);
}
async function internal(
  env: Env,
  id: string,
  path: string,
  body?: unknown,
  headers: HeadersInit = {},
) {
  return accountStub(env, id).fetch(
    new Request("https://account.internal" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function authenticate(request: Request, env: Env, admin = false) {
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 24)
    throw new ApiError(
      503,
      "not_configured",
      "Configure ADMIN_KEY (at least 24 characters) before using this service",
    );
  const supplied = token(request);
  if (!supplied || supplied.length > 512)
    throw new ApiError(401, "unauthorized", "A valid Bearer token is required");
  if (admin) {
    if (!(await constantEqual(supplied, env.ADMIN_KEY)))
      throw new ApiError(401, "unauthorized", "Invalid admin token");
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw new ApiError(
        403,
        "origin_denied",
        "Cross-origin admin requests are not allowed",
      );
    return "admin";
  }
  if (env.API_KEY && (await constantEqual(supplied, env.API_KEY)))
    return "key_" + (await sha256(supplied)).slice(0, 32);
  const hash = await sha256(supplied);
  const row = await env.DB.prepare(
    "SELECT id FROM api_keys WHERE hash=? AND enabled=1",
  )
    .bind(hash)
    .first<{ id: string }>();
  if (!row) throw new ApiError(401, "unauthorized", "Invalid API key");
  return row.id;
}
function splitId(id: string, prefix: string) {
  const m = new RegExp(`^(acc_[a-f0-9]{32})\\.(${prefix}_[a-f0-9]{32})$`).exec(
    id,
  );
  if (!m) throw new ApiError(400, "invalid_id", "Invalid resource identifier");
  return [m[1], m[2]];
}
async function adminRoute(request: Request, env: Env, path: string) {
  await authenticate(request, env, true);
  const method = request.method;
  if (path === "/admin/accounts" && method === "GET")
    return json({
      data: (
        await env.DB.prepare("SELECT * FROM accounts ORDER BY created_at").all()
      ).results,
    });
  if (path === "/admin/accounts" && method === "POST") {
    const b = await readJson(request, 40000);
    validateCookie(b.cookie);
    const id = uid("acc_");
    const result = await env.DB.prepare(
      "INSERT INTO accounts (id,label,created_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM accounts) < ?",
    )
      .bind(
        id,
        String(b.label || "Gemini account").slice(0, 80),
        now(),
        boundedInt(env.MAX_ACCOUNTS, 5, 1, 20),
      )
      .run();
    if (!result.meta.changes)
      throw new ApiError(409, "account_limit", "Account pool is full");
    const r = await internal(env, id, "/configure", { ...b, accountId: id });
    if (!r.ok) {
      await env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
      return r;
    }
    return json({ id, label: b.label || "Gemini account" }, 201);
  }
  const match =
    /^\/admin\/accounts\/(acc_[a-f0-9]{32})(?:\/(status|refresh|models))?$/.exec(
      path,
    );
  if (match) {
    const [, id, action] = match;
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE id=?")
      .bind(id)
      .first();
    if (!account) throw new ApiError(404, "not_found", "Account not found");
    if (method === "GET" && action === "status")
      return internal(env, id, "/status");
    if (method === "POST" && action === "refresh")
      return internal(env, id, "/refresh", {});
    if (method === "GET" && action === "models")
      return internal(env, id, "/models");
    if (method === "PUT" && !action) {
      const b = await readJson(request, 40000);
      if (b.cookie !== undefined) {
        validateCookie(b.cookie);
        const r = await internal(env, id, "/configure", {
          ...b,
          accountId: id,
        });
        if (!r.ok) return r;
      }
      if (b.label !== undefined)
        await env.DB.prepare("UPDATE accounts SET label=? WHERE id=?")
          .bind(String(b.label).slice(0, 80), id)
          .run();
      if (b.enabled !== undefined) {
        if (typeof b.enabled !== "boolean")
          throw new ApiError(400, "invalid_request", "enabled must be boolean");
        const r = await internal(env, id, "/enabled", { enabled: b.enabled });
        if (!r.ok) return r;
        await env.DB.prepare("UPDATE accounts SET enabled=? WHERE id=?")
          .bind(b.enabled ? 1 : 0, id)
          .run();
      }
      return json({ ok: true });
    }
    if (method === "DELETE" && !action) {
      const r = await internal(env, id, "/delete", {});
      if (!r.ok) return r;
      await env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
  }
  if (path === "/admin/keys" && method === "GET")
    return json({
      data: (
        await env.DB.prepare(
          "SELECT id,name,created_at,enabled FROM api_keys ORDER BY created_at DESC",
        ).all()
      ).results,
    });
  if (path === "/admin/keys" && method === "POST") {
    const b = await readJson(request);
    const secret = uid("sk-") + uid(),
      id = uid("key_");
    await env.DB.prepare(
      "INSERT INTO api_keys (id,name,hash,created_at) VALUES (?,?,?,?)",
    )
      .bind(
        id,
        String(b.name || "API client").slice(0, 80),
        await sha256(secret),
        now(),
      )
      .run();
    return json({ id, key: secret, note: "Shown once. Store securely." }, 201);
  }
  const key = /^\/admin\/keys\/(key_[a-f0-9]{32})$/.exec(path);
  if (key && method === "DELETE") {
    await env.DB.prepare("DELETE FROM api_keys WHERE id=?").bind(key[1]).run();
    return json({ ok: true });
  }
  if (path === "/admin/requests" && method === "GET") {
    const url = new URL(request.url),
      before = boundedInt(
        url.searchParams.get("before") || undefined,
        now() + 1,
        0,
        now() + 1,
      );
    return json({
      data: (
        await env.DB.prepare(
          "SELECT * FROM requests WHERE created_at < ? ORDER BY created_at DESC LIMIT 100",
        )
          .bind(before)
          .all()
      ).results,
    });
  }
  if (path === "/admin/stats" && method === "GET") {
    const stats = await env.DB.prepare(
      "SELECT COUNT(*) AS requests, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) AS failures, AVG(duration_ms) AS avg_duration_ms FROM requests WHERE created_at>=?",
    )
      .bind(now() - 86400)
      .first();
    return json({
      last_24h: stats,
      daily: (
        await env.DB.prepare(
          "SELECT * FROM daily_stats ORDER BY day DESC LIMIT 30",
        ).all()
      ).results,
    });
  }
  if (path === "/admin/config" && method === "GET")
    return json({
      version: "3.0.0",
      runtime: "Cloudflare Workers + SQLite Durable Objects + D1",
      external_proxy: false,
      browser_required_at_runtime: false,
      r2_required: false,
      default_model: env.DEFAULT_MODEL || "gemini-3.6-flash",
      account_limit: boundedInt(env.MAX_ACCOUNTS, 5, 1, 20),
      rate_per_account: 6,
      remote_files: false,
      reasoning_export: false,
      model_catalog:
        "Protocol IDs from zexadev/gemini-web2api-go; not a guarantee of account entitlement",
      limitations: [
        "No Chrome TLS impersonation",
        "Cloudflare data-center IPs may be refused by Google",
        "Cookie refresh is best-effort; device-bound sessions need re-import",
        "No Google official API key is used",
        "Free tier limits apply; media may need a paid Gemini account",
      ],
    });
  throw new ApiError(404, "not_found", "Admin route not found");
}
async function apiRoute(request: Request, env: Env, path: string) {
  const owner = await authenticate(request, env);
  const method = request.method;
  if (path === "/v1/models" && method === "GET")
    return json({
      object: "list",
      data: MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "gemini-web",
        requires_login: true,
        experimental: !!m.tool,
      })),
    });
  const file = /^\/v1\/files\/([^/]+)\/content$/.exec(path),
    video = /^\/v1\/videos\/([^/]+)(\/content)?$/.exec(path);
  if ((file || video) && method === "GET") {
    const id = (file || video)![1],
      [account, resource] = splitId(id, file ? "file" : "video");
    return internal(
      env,
      account,
      (file ? "/files/" : "/videos/") + resource + (video?.[2] || ""),
      undefined,
      {
        "x-owner": owner,
        ...(request.headers.has("range")
          ? { range: request.headers.get("range")! }
          : {}),
      },
    );
  }
  const endpoints: Record<string, string> = {
    "/v1/chat/completions": "chat",
    "/v1/responses": "responses",
    "/v1/images/generations": "images",
    "/v1/videos": "videos",
  };
  let endpoint = endpoints[path];
  const google =
    /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(
      path,
    );
  if (google) endpoint = "google";
  if (!endpoint || method !== "POST")
    throw new ApiError(404, "not_found", "API route not found");
  let body = await readJson(
    request,
    boundedInt(env.MAX_REQUEST_BYTES, 1048576, 4096, 1048576),
  );
  if (google) {
    if (google[2] === "streamGenerateContent")
      throw new ApiError(
        400,
        "unsupported_stream",
        "Use /v1/chat/completions for streaming",
      );
    if (body.generationConfig || body.safetySettings)
      throw new ApiError(
        400,
        "unsupported_options",
        "generationConfig and safetySettings are not supported by this basic adapter",
      );
    if (
      !Array.isArray(body.contents) ||
      body.contents.some(
        (c: any) =>
          !c ||
          !Array.isArray(c.parts) ||
          c.parts.some((p: any) => !p || typeof p !== "object"),
      )
    )
      throw new ApiError(
        400,
        "invalid_request",
        "contents must contain messages with valid parts",
      );
    if (
      body.systemInstruction &&
      (!Array.isArray(body.systemInstruction.parts) ||
        body.systemInstruction.parts.some(
          (p: any) => !p || typeof p.text !== "string",
        ))
    )
      throw new ApiError(
        400,
        "invalid_request",
        "systemInstruction must contain text parts",
      );
    if (body.tools)
      throw new ApiError(
        400,
        "unsupported_tools",
        "Use OpenAI function tools on /v1/chat/completions",
      );
    body = {
      model: google[1],
      messages: [
        ...(body.systemInstruction
          ? [
              {
                role: "system",
                content: (body.systemInstruction.parts || [])
                  .map((p: any) => p.text || "")
                  .join("\n"),
              },
            ]
          : []),
        ...(body.contents || []).map((c: any) => ({
          role: c.role === "model" ? "assistant" : "user",
          content: (c.parts || []).map((p: any) =>
            p.text !== undefined
              ? { type: "text", text: p.text }
              : p.inlineData
                ? {
                    type: "input_file",
                    file_data: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
                  }
                : { type: "unsupported" },
          ),
        })),
      ],
    };
  }
  if (endpoint === "images" || endpoint === "videos") {
    if (typeof body.prompt !== "string" || !body.prompt.trim())
      throw new ApiError(400, "invalid_prompt", "prompt is required");
    for (const option of [
      "size",
      "quality",
      "style",
      "output_format",
      "seconds",
      "input_reference",
      "stream",
    ])
      if (body[option] !== undefined)
        throw new ApiError(
          400,
          "unsupported_options",
          `${option} is not supported by this media adapter`,
        );
    if (body.n !== undefined && body.n !== 1)
      throw new ApiError(400, "unsupported_n", "Only n=1 is supported");
    if (body.response_format && body.response_format !== "url")
      throw new ApiError(
        400,
        "unsupported_format",
        "Only authenticated URL output is supported",
      );
    body = {
      model:
        body.model || (endpoint === "images" ? "gemini-image" : "gemini-video"),
      messages: [{ role: "user", content: body.prompt }],
    };
    if (
      body.model !== (endpoint === "images" ? "gemini-image" : "gemini-video")
    )
      throw new ApiError(400, "invalid_model", "Use the matching media model");
  }
  let pinned = "",
    session = body.session_id || request.headers.get("x-session-id");
  if (session) {
    [pinned, session] = splitId(session, "s");
  }
  const input = normalize(
    body,
    endpoint === "google" ? "chat" : endpoint,
    owner,
    env.DEFAULT_MODEL || "gemini-3.6-flash",
    session,
  );
  input.resume = !!session;
  input.session = session || uid("s_");
  const query = pinned
    ? env.DB.prepare(
        "SELECT * FROM accounts WHERE id=? AND enabled=1 AND cooldown_until<=?",
      ).bind(pinned, now())
    : env.DB.prepare(
        "SELECT * FROM accounts WHERE enabled=1 AND cooldown_until<=? ORDER BY last_used ASC LIMIT 20",
      ).bind(now());
  const accounts = (await query.all<AccountRow>()).results;
  if (!accounts.length)
    throw new ApiError(
      503,
      "no_available_account",
      "Import/enable an account or wait for its cooldown",
    );
  for (const account of accounts) {
    await env.DB.prepare("UPDATE accounts SET last_used=? WHERE id=?")
      .bind(now(), account.id)
      .run();
    const response = await accountStub(env, account.id).fetch(
      new Request(
        "https://account.internal" +
          (endpoint === "videos" ? "/videos" : "/generate"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-public-origin": new URL(request.url).origin,
          },
          body: JSON.stringify(input),
          signal: request.signal,
        },
      ),
    );
    if (response.status === 429 && !pinned) {
      const payload = (await response.clone().json()) as any;
      if (
        ["account_busy", "account_rate_limit", "video_busy"].includes(
          payload.error?.code,
        )
      ) {
        await response.body?.cancel();
        continue;
      }
    }
    if (google && response.ok) {
      const result = (await response.json()) as any;
      return json(
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: result.choices[0].message.content }],
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
          modelVersion: result.gemini.actual_model || body.model,
        },
        200,
        { "X-Session-Id": response.headers.get("X-Session-Id") || "" },
      );
    }
    return response;
  }
  throw new ApiError(429, "pool_busy", "All accounts are busy or rate limited");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      const path = new URL(request.url).pathname;
      if (path === "/healthz")
        response = json({
          status: "ok",
          version: "3.0.0",
          upstream_verified: false,
        });
      else if (path.startsWith("/admin/"))
        response = await adminRoute(request, env, path);
      else if (path.startsWith("/v1/") || path.startsWith("/v1beta/"))
        response = await apiRoute(request, env, path);
      else response = await env.ASSETS.fetch(request);
    } catch (e) {
      response = errorResponse(e);
    }
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
