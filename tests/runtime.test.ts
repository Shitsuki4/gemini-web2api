import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { seal, unseal } from "../src/util";
let mf: Miniflare;
let account = "";
let calls = 0;
let maintenanceCalls = 0;
let rejectRotation = false;
let rejectPage = false;
let lastPrompt = "";
let lastPayload: any[] = [];
let rejectUpstream = false;
let returnMedia = false;
let returnTool = false;
let upstreamGate: Promise<void> | undefined;
let upstreamStarted: (() => Promise<void>) | undefined;
// Synchronize on actual mock-upstream entry, not runner scheduling speed.
function holdUpstream(startDelay = 0) {
  let release!: () => void;
  upstreamGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  upstreamStarted = async () => {
    if (startDelay)
      await new Promise((resolve) => setTimeout(resolve, startDelay));
    entered();
  };
  return {
    async waitUntilStarted() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          started,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("Mock upstream did not start within 5 seconds"),
                ),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release() {
      upstreamStarted = undefined;
      upstreamGate = undefined;
      release();
    },
  };
}
const admin = "admin_" + "a".repeat(48),
  apiKey = "sk-" + "b".repeat(48);
const headers = (key = apiKey) => ({
  "Content-Type": "application/json",
  Authorization: "Bearer " + key,
});
async function req(
  path: string,
  body?: any,
  key = apiKey,
  method = body === undefined ? "GET" : "POST",
) {
  return mf.dispatchFetch("https://gateway.test" + path, {
    method,
    headers: headers(key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function wire(text: string) {
  const inner: any[] = Array(43).fill(null);
  inner[1] = ["c_runtime", "r_runtime"];
  inner[4] = [["rc_runtime", [text]]];
  if (returnMedia)
    inner[10] = [
      "https://lh3.googleusercontent.com/gg/fake",
      "https://contribution.usercontent.google.com/download?c=" +
        btoa("response_data"),
    ];
  inner[42] = ["fbb127bbb056c959", null, null, "3.6 Flash", true];
  return (
    JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify(inner)]]) + "\n"
  );
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["tests/harness.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:sockets"],
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-01",
    durableObjects: {
      ACCOUNTS: { className: "TestAccount", useSQLite: true },
    },
    d1Databases: { DB: "db" },
    bindings: {
      UPSTREAM_TRANSPORT: "fetch",
      ACCOUNT_QUEUE_WAIT_MS: "1000",
      ADMIN_KEY: admin,
      API_KEY: apiKey,
      ENCRYPTION_KEY: btoa("k".repeat(32)),
      ACCOUNT_LOCATION_HINT: "auto",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/RotateCookies") {
        maintenanceCalls++;
        if (rejectRotation)
          return new Response("unauthorized", { status: 401 });
        const ticket = (await request.text()).startsWith("[000,");
        return new Response("[]", {
          headers: {
            "set-cookie": `${ticket ? "__Secure-1PSIDTS" : "SIDCC"}=PRIVATE_RENEWED; Domain=.google.com; Path=/; Secure`,
          },
        });
      }
      if (url.pathname === "/RotateCookiesPage")
        return new Response("init('123456789123',658.0,0.0,0.0,600.0)");
      if (["/app", "/spark"].includes(url.pathname) && rejectPage)
        return new Response(null, {
          status: 302,
          headers: { location: "https://accounts.google.com/ServiceLogin" },
        });
      if (["/app", "/spark"].includes(url.pathname))
        return new Response(
          '"SNlM0e":"xsrf_test","cfb2h":"boq_test","qKIAYe":"push_test","Ylro7b":"pctx_test"',
        );
      if (url.pathname.includes("StreamGenerate")) {
        // Capture the owner gate before the test releases it.
        const gate = upstreamGate;
        if (upstreamStarted) await upstreamStarted();
        calls++;
        if (gate) await gate;
        if (rejectUpstream) return new Response("blocked", { status: 429 });
        const b = new URLSearchParams(await request.text());
        lastPayload = JSON.parse(JSON.parse(b.get("f.req")!)[1]);
        lastPrompt = lastPayload[0][0];
        if (lastPayload[49] === 40) {
          const event = (obj: any) =>
            JSON.stringify([
              [
                "wrb.fr",
                "StreamGenerate",
                JSON.stringify([
                  null,
                  ["c_runtime", "r_runtime"],
                  { 44: true, ...obj },
                ]),
              ],
            ]) + "\n";
          return new Response(
            event({ 7: ["PRIVATE_SPARK_PLAN"] }) +
              wire("SPARK_OK") +
              event({ 26: "PRIVATE_SPARK_CURSOR" }) +
              event({ 46: ["c_runtime", ""] }),
          );
        }
        if (returnTool)
          return new Response(
            wire(
              JSON.stringify({
                tool_calls: [
                  { name: "get_weather", arguments: { city: "Shanghai" } },
                ],
              }),
            ),
          );
        return new Response(
          ")]}'\n42\n" + wire("Hello") + wire("Hello runtime"),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.includes("batchexecute"))
        return new Response(wire("history"));
      if (url.hostname === "lh3.googleusercontent.com")
        return new Response("IMAGE_BYTES", {
          headers: { "content-type": "image/png" },
        });
      return new Response("not mocked", { status: 404 });
    },
  });
  const db = await mf.getD1Database("DB");
  const schema = (
    await readFile("migrations/0001_initial.sql", "utf8")
  ).replace(/^\uFEFF/, "");
  for (const s of schema
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean))
    await db.prepare(s).run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
describe("actual workerd + SQLite DO + D1 integration", () => {
  it("fails closed without authentication", async () => {
    const r = await mf.dispatchFetch("https://gateway.test/v1/models");
    expect(r.status).toBe(401);
  });
  it("serves unauthenticated CORS preflight without touching Google or accounts", async () => {
    const before = calls,
      maintained = maintenanceCalls;
    for (const path of [
      "/v1/chat/completions",
      "/v1beta/models/x:generateContent",
      "/v1/files/test/content",
    ]) {
      const r = await mf.dispatchFetch("https://gateway.test" + path, {
        method: "OPTIONS",
        headers: {
          Origin: "https://client.test",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization,content-type,x-stainless-lang",
        },
      });
      expect(r.status).toBe(204);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(r.headers.get("Access-Control-Allow-Headers")).toContain(
        "authorization",
      );
      expect(r.headers.get("Access-Control-Allow-Headers")).toContain(
        "x-gemini-session-id",
      );
    }
    expect(calls).toBe(before);
    expect(maintenanceCalls).toBe(maintained);
  });
  it("exposes both success and authentication errors to cross-origin API clients", async () => {
    for (const key of [apiKey, "invalid"]) {
      const r = await mf.dispatchFetch("https://gateway.test/v1/models", {
        headers: { ...headers(key), Origin: "https://client.test" },
      });
      expect(r.status).toBe(key === apiKey ? 200 : 401);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(r.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      if (key !== apiKey)
        expect(((await r.json()) as any).error.code).toBe("unauthorized");
    }
  });
  it("keeps admin preflight private and rejects cross-origin authenticated admin writes", async () => {
    for (const method of ["OPTIONS", "POST"]) {
      const r = await mf.dispatchFetch("https://gateway.test/admin/keys", {
        method,
        headers: { ...headers(admin), Origin: "https://client.test" },
        ...(method === "POST" ? { body: '{"name":"blocked"}' } : {}),
      });
      expect(r.status).toBe(403);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(((await r.json()) as any).error.code).toBe("origin_denied");
    }
    const health = await mf.dispatchFetch("https://gateway.test/healthz");
    expect(health.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("returns readable CORS errors for invalid preflight instead of bypassing authentication", async () => {
    const r = await mf.dispatchFetch("https://gateway.test/v1/models", {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.test",
        "Access-Control-Request-Headers": "authorization: secret",
      },
    });
    expect(r.status).toBe(400);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(((await r.json()) as any).error.code).toBe("invalid_cors_headers");
  });
  it("keeps the Worker and static-asset CSP aligned for blob media previews", async () => {
    const r = await mf.dispatchFetch("https://gateway.test/v1/models");
    const staticHeaders = await readFile("public/_headers", "utf8");
    const csp = staticHeaders.match(/Content-Security-Policy: (.+)/)![1].trim();
    expect(r.headers.get("content-security-policy")).toBe(csp);
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });
  it("separates admin and inference credentials", async () => {
    expect((await req("/admin/accounts")).status).toBe(401);
    expect((await req("/v1/models", undefined, admin)).status).toBe(401);
  });
  it("creates an encrypted account and lists only metadata", async () => {
    const r = await req(
      "/admin/accounts",
      {
        label: "test account",
        cookie: "__Secure-1PSID=PRIVATE_COOKIE",
        xsrf: "x",
        bl: "boq_test",
      },
      admin,
    );
    expect(r.status).toBe(201);
    account = ((await r.json()) as any).id;
    const list = await (await req("/admin/accounts", undefined, admin)).text();
    expect(list).toContain("test account");
    expect(list).not.toContain("PRIVATE_COOKIE");
    const state = (await (
      await req(`/admin/accounts/${account}/status`, undefined, admin)
    ).json()) as any;
    expect(state.configured).toBe(true);
  });
  it("creates and revokes independent API keys", async () => {
    const create = (await (
      await req("/admin/keys", { name: "client" }, admin)
    ).json()) as any;
    expect(create.key).toMatch(/^sk-/);
    expect((await req("/v1/models", undefined, create.key)).status).toBe(200);
    const list = await (await req("/admin/keys", undefined, admin)).text();
    expect(list).not.toContain(create.key);
    await req("/admin/keys/" + create.id, undefined, admin, "DELETE");
    expect((await req("/v1/models", undefined, create.key)).status).toBe(401);
  });
  it("generates, persists metadata, and isolates sessions by API key", async () => {
    const r = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.choices[0].message.content).toBe("Hello runtime");
    expect(body.gemini.actual_model).toBe("3.6 Flash");
    const session = r.headers.get("x-session-id");
    expect(session).toMatch(/^acc_.*\.s_/);
    const other = (await (
      await req("/admin/keys", { name: "other" }, admin)
    ).json()) as any;
    const wrong = await req(
      "/v1/chat/completions",
      {
        model: "gemini-3.6-flash",
        session_id: session,
        messages: [{ role: "user", content: "steal" }],
      },
      other.key,
    );
    expect(wrong.status).toBe(404);
    const next = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      session_id: session,
      messages: [{ role: "user", content: "only new turn" }],
    });
    expect(next.status).toBe(200);
    await next.text();
    expect(lastPrompt).toContain("only new turn");
    expect(lastPrompt).not.toContain("PRIVATE_PROMPT");
    const logs = await (await req("/admin/requests", undefined, admin)).text();
    expect(logs).not.toContain("PRIVATE_PROMPT");
    expect(logs).not.toContain("Hello runtime");
  });
  it("streams true cumulative deltas and terminal DONE", async () => {
    const r = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const s = await r.text();
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-Session-Id",
    );
    expect(s).toContain('"content":"Hello"');
    expect(s).toContain('"content":" runtime"');
    expect(s).toContain("data: [DONE]");
    expect(s).not.toContain("PRIVATE_COOKIE");
  });
  it("emits a complete Responses lifecycle", async () => {
    const r = await req("/v1/responses", {
      model: "gemini-3.6-flash",
      input: "hello",
      stream: true,
    });
    const s = await r.text();
    for (const type of [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
      expect(s).toContain("event: " + type);
  });
  it("never turns an upstream rejection into a successful answer", async () => {
    rejectUpstream = true;
    const r = await req("/v1/chat/completions", {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "fail" }],
    });
    expect(r.status).toBe(429);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Expose-Headers")).toContain(
      "Retry-After",
    );
    expect(((await r.json()) as any).error.code).toBe("upstream_http_429");
    rejectUpstream = false;
  });
});

async function freshAccount() {
  const db = await mf.getD1Database("DB");
  const existing = await db.prepare("SELECT id FROM accounts").all();
  for (const row of existing.results)
    await req("/admin/accounts/" + row.id, undefined, admin, "DELETE");
  const r = await req(
    "/admin/accounts",
    {
      label: "isolated",
      cookie: "__Secure-1PSID=PRIVATE_COOKIE",
      xsrf: "x",
      bl: "b",
    },
    admin,
  );
  expect(r.status).toBe(201);
  const id = ((await r.json()) as any).id;
  const ns = await mf.getDurableObjectNamespace("ACCOUNTS");
  return {
    id,
    stub: ns.get(ns.idFromName(id)),
    objectId: ns.idFromName(id).toString(),
    db,
  };
}
async function storage(stub: any, body: any = {}) {
  return (await (
    await stub.fetch("https://test/test/storage", {
      method: "POST",
      body: JSON.stringify(body),
    })
  ).json()) as any;
}
describe("state lifecycle in workerd", () => {
  it("counts daily statistics atomically without any Cron trigger", async () => {
    const db = await mf.getD1Database("DB");
    const count = await db
      .prepare("SELECT COUNT(*) AS count FROM requests")
      .first();
    const stats = await db
      .prepare("SELECT SUM(requests) AS count FROM daily_stats")
      .first();
    expect(stats?.count).toBe(count?.count);
    expect(Number(stats?.count)).toBeGreaterThan(0);
  });
  it("emits response.failed rather than a false completion on SSE rejection", async () => {
    await freshAccount();
    rejectUpstream = true;
    try {
      const r = await req("/v1/responses", { input: "fail", stream: true });
      const text = await r.text();
      expect(text).toContain("event: response.failed");
      expect(text).not.toContain("event: response.completed");
    } finally {
      rejectUpstream = false;
    }
  });
  it("rejects forged resumptions, encrypts session state, and cleans old rows using alarms", async () => {
    const { id, stub, db } = await freshAccount();
    const forged = await req("/v1/chat/completions", {
      messages: [{ role: "user", content: "x" }],
      session_id: id + ".s_" + "f".repeat(32),
    });
    expect(forged.status).toBe(404);
    const r = await req("/v1/chat/completions", {
      messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
    });
    await r.text();
    const rows = await storage(stub);
    expect(rows.credentials).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_COOKIE");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_PROMPT");
    expect(Object.keys(rows).some((k) => k.startsWith("session:"))).toBe(true);
    expect(Object.keys(rows).some((k) => k.startsWith("known:"))).toBe(false);
    await db
      .prepare(
        "INSERT INTO requests(id,created_at,key_id,endpoint,model,status,duration_ms) VALUES('expired',1,'k','chat','m',200,1)",
      )
      .run();
    await storage(stub, {
      put: { "known:legacy": true },
      delete: "maintenanceDay",
    });
    await stub.fetch("https://test/test/alarm");
    expect(
      await db.prepare("SELECT id FROM requests WHERE id='expired'").first(),
    ).toBeNull();
    expect((await storage(stub))["known:legacy"]).toBeUndefined();
  });
  it("returns actual visible media failure in SSE, without claiming success", async () => {
    await freshAccount();
    const r = await req("/v1/chat/completions", {
      model: "gemini-image",
      stream: true,
      messages: [{ role: "user", content: "draw" }],
    });
    const text = await r.text();
    expect(text).toContain("event: error");
    expect(text).toContain("media_unavailable");
    expect(text).toContain("Upstream reply: Hello runtime");
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain('"finish_reason":"stop"');
  });
  it("returns downloadable artifacts for the chat SSE image route", async () => {
    await freshAccount();
    returnMedia = true;
    try {
      const r = await req("/v1/chat/completions", {
        model: "gemini-image",
        stream: true,
        messages: [{ role: "user", content: "画一只可爱小猫" }],
      });
      const text = await r.text();
      expect(lastPayload[49]).toBe(14);
      expect(text).toContain("[DONE]");
      expect(text).toContain('"artifacts":[{"id":"acc_');
      expect(text).not.toContain("https://lh3.googleusercontent.com");
      const id = JSON.parse(
        text
          .split("\n")
          .find((line) => line.includes('"artifacts"'))!
          .slice(6),
      ).gemini.artifacts[0].id;
      expect(await (await req(`/v1/files/${id}/content`)).text()).toBe(
        "IMAGE_BYTES",
      );
    } finally {
      returnMedia = false;
    }
  });
  it("isolates artifact access and drives video completion with a DO alarm", async () => {
    const { stub } = await freshAccount();
    returnMedia = true;
    try {
      const image = await req("/v1/images/generations", { prompt: "draw" });
      expect(image.status).toBe(200);
      const url = ((await image.json()) as any).data[0].url;
      const path = new URL(url).pathname;
      const stranger = (await (
        await req("/admin/keys", { name: "stranger" }, admin)
      ).json()) as any;
      expect((await req(path, undefined, stranger.key)).status).toBe(404);
      expect(await (await req(path)).text()).toBe("IMAGE_BYTES");
      const v = await req("/v1/videos", { prompt: "PRIVATE_VIDEO_PROMPT" });
      expect(v.status).toBe(202);
      const job = (await v.json()) as any;
      expect(
        (await req("/v1/videos/" + job.id, undefined, stranger.key)).status,
      ).toBe(404);
      const before = await storage(stub);
      expect(JSON.stringify(before)).not.toContain("PRIVATE_VIDEO_PROMPT");
      await stub.fetch("https://test/test/alarm");
      const state = (await (await req("/v1/videos/" + job.id)).json()) as any;
      expect(state.status).toBe("completed");
      expect((await storage(stub)).activeVideo).toBeUndefined();
    } finally {
      returnMedia = false;
    }
  });
});

describe("concurrency and ambiguous jobs", () => {
  it("does not partially disable an account while a generation is in flight", async () => {
    const { id, db } = await freshAccount();
    const held = holdUpstream();
    const before = calls;
    const pending = req("/v1/chat/completions", {
      messages: [{ role: "user", content: "slow" }],
    });
    try {
      await held.waitUntilStarted();
      expect(calls).toBe(before + 1);
      const disabled = await req(
        "/admin/accounts/" + id,
        { enabled: false },
        admin,
        "PUT",
      );
      expect(disabled.status).toBe(429);
      expect(
        (
          await db
            .prepare("SELECT enabled FROM accounts WHERE id=?")
            .bind(id)
            .first()
        )?.enabled,
      ).toBe(1);
      const busy = await req("/v1/chat/completions", {
        messages: [{ role: "user", content: "overlap" }],
      });
      expect(busy.status).toBe(429);
      expect(((await busy.json()) as any).error.code).toBe(
        "account_queue_timeout",
      );
      expect(calls).toBe(before + 1);
    } finally {
      held.release();
      await (await pending).text();
    }
  });
  it.each(["submitting", "expired"])(
    "never resubmits a %s video job",
    async (kind) => {
      const { stub, objectId } = await freshAccount();
      const r = await req("/v1/videos", { prompt: "PRIVATE_VIDEO" });
      const video = (await r.json()) as any;
      const jobKey = "video:" + video.id.split(".")[1];
      const rows = await storage(stub);
      const secret = btoa("k".repeat(32));
      const aad = objectId + ":" + jobKey;
      const job = await unseal<any>(rows[jobKey], secret, aad);
      if (kind === "submitting") job.stage = "submitting";
      else job.created_at = Math.floor(Date.now() / 1000) - 601;
      await storage(stub, { put: { [jobKey]: await seal(job, secret, aad) } });
      const before = calls;
      await stub.fetch("https://test/test/alarm");
      expect(calls).toBe(before);
      const state = (await (await req("/v1/videos/" + video.id)).json()) as any;
      expect(state.status).toBe("failed");
      expect(state.error.code).toBe(
        kind === "submitting" ? "submission_uncertain" : "video_timeout",
      );
      const after = await storage(stub);
      const stored = await unseal<any>(after[jobKey], secret, aad);
      expect(stored.input).toBeUndefined();
      expect(after.activeVideo).toBeUndefined();
    },
  );
});

describe("Spark persisted sessions in workerd", () => {
  it("encrypts task cursor, resumes slot 71 and never exposes control events", async () => {
    const { stub, objectId } = await freshAccount();
    const body = {
      model: "gemini-spark",
      messages: [{ role: "user", content: "SPARK_OK" }],
    };
    const first = await req("/v1/chat/completions", body);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(JSON.parse(firstText).choices[0].message.content).toBe("SPARK_OK");
    expect(firstText).not.toContain("PRIVATE_SPARK");
    expect(lastPayload[71]).toBeNull();
    const rows = await storage(stub);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_SPARK");
    const sessionKey = Object.keys(rows).find((k) => k.startsWith("session:"))!;
    const saved = await unseal<any>(
      rows[sessionKey],
      btoa("k".repeat(32)),
      objectId + ":" + sessionKey,
    );
    expect(saved.sparkContext).toEqual({
      conversationId: "c_runtime",
      cursor: "PRIVATE_SPARK_CURSOR",
    });
    expect(saved.metadata[2]).toBe("rc_runtime");
    const second = await req("/v1/chat/completions", {
      ...body,
      session_id: first.headers.get("x-session-id"),
      stream: true,
    });
    const stream = await second.text();
    expect(stream).toContain('"content":"SPARK_OK"');
    expect(stream).toContain("data: [DONE]");
    expect(stream).not.toContain("PRIVATE_SPARK");
    expect(lastPayload[71]).toEqual([
      "c_runtime",
      null,
      null,
      null,
      null,
      null,
      null,
      "PRIVATE_SPARK_CURSOR",
    ]);
    expect(lastPayload[2]).toBeNull();
    expect(lastPayload[83]).toBeNull();
    const before = calls;
    const wrong = await req("/v1/chat/completions", {
      ...body,
      model: "gemini-3.8-flash",
      session_id: first.headers.get("x-session-id"),
    });
    expect(wrong.status).toBe(400);
    expect(calls).toBe(before);
  });
});

describe("login maintenance alarm lifecycle", () => {
  it("schedules first import promptly, keeps inference health separate, honors persisted due time", async () => {
    const { id, stub, db, objectId } = await freshAccount();
    const alarm = async () =>
      ((await (await stub.fetch("https://test/test/alarm-at")).json()) as any)
        .at;
    expect(await alarm()).toBeLessThanOrEqual(Date.now() + 16000);
    await db
      .prepare(
        "UPDATE accounts SET health='inference_error',cooldown_until=123 WHERE id=?",
      )
      .bind(id)
      .run();
    const before = maintenanceCalls;
    await stub.fetch("https://test/test/alarm");
    const status = (await (
      await req(`/admin/accounts/${id}/status`, undefined, admin)
    ).json()) as any;
    expect(status.maintenance.status).toBe("healthy");
    expect(
      status.maintenance.nextAttemptAt - status.maintenance.lastCompletedAt,
    ).toBe(600);
    expect(await alarm()).toBeGreaterThan(Date.now() + 590000);
    expect(await alarm()).toBeLessThan(Date.now() + 601000);
    const row = await db
      .prepare(
        "SELECT health,cooldown_until,last_refresh FROM accounts WHERE id=?",
      )
      .bind(id)
      .first();
    expect(row?.health).toBe("inference_error");
    expect(row?.cooldown_until).toBe(123);
    expect(row?.last_refresh).toBe(status.refreshed_at);
    const raw = await storage(stub);
    expect(JSON.stringify(raw)).not.toContain("PRIVATE_RENEWED");
    const creds = await unseal<any>(
      raw.credentials,
      btoa("k".repeat(32)),
      objectId,
    );
    expect(creds.maintenance.nextAttemptAt).toBe(
      status.maintenance.nextAttemptAt,
    );
    await stub.fetch("https://test/test/alarm");
    expect(maintenanceCalls - before).toBe(2);
    const retry = await req(`/admin/accounts/${id}/refresh`, {}, admin);
    expect(retry.status).toBe(429);
    expect(Number(retry.headers.get("retry-after"))).toBeGreaterThan(590);
    expect(await retry.text()).toContain("refresh_backoff");
    expect(maintenanceCalls - before).toBe(2);
  });
  it("reports manual failure honestly, schedules durable backoff and clears stale token age", async () => {
    const { id, stub } = await freshAccount();
    rejectRotation = true;
    rejectPage = true;
    try {
      const r = (await (
        await req(`/admin/accounts/${id}/refresh`, {}, admin)
      ).json()) as any;
      expect(r.ok).toBe(false);
      expect(r.renewed).toBe(false);
      expect(r.maintenance.status).toBe("reimport_required");
      expect(r.maintenance.nextAttemptAt - r.maintenance.lastCompletedAt).toBe(
        1800,
      );
      const state = (await (
        await req(`/admin/accounts/${id}/status`, undefined, admin)
      ).json()) as any;
      expect(state.tokens_at).toBe(0);
      const before = maintenanceCalls;
      await stub.fetch("https://test/test/alarm");
      expect(maintenanceCalls).toBe(before);
      const alarm = (await (
        await stub.fetch("https://test/test/alarm-at")
      ).json()) as any;
      expect(alarm.at).toBeGreaterThan(Date.now() + 1790000);
    } finally {
      rejectRotation = false;
      rejectPage = false;
    }
  });
  it("disabled account makes no maintenance requests and keeps daily cleanup alarm", async () => {
    const { id, stub } = await freshAccount();
    await req(`/admin/accounts/${id}`, { enabled: false }, admin, "PUT");
    const before = maintenanceCalls;
    await stub.fetch("https://test/test/alarm");
    expect((await req(`/admin/accounts/${id}/refresh`, {}, admin)).status).toBe(
      503,
    );
    expect(maintenanceCalls).toBe(before);
    const alarm = (await (
      await stub.fetch("https://test/test/alarm-at")
    ).json()) as any;
    expect(alarm.at).toBeGreaterThan(Date.now() + 86390000);
  });
});

describe("OpenAI client session compatibility in workerd", () => {
  const opaque = "6d3b06f5-70ad-4138-a1f4-79145cf7fbdd";
  const history = [
    { role: "user", content: "EARLIER_QUESTION" },
    { role: "assistant", content: "EARLIER_ANSWER" },
    { role: "user", content: "NEW_QUESTION" },
  ];
  async function chat(body: any, extra: Record<string, string> = {}) {
    return mf.dispatchFetch("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { ...headers(), Origin: "https://client.test", ...extra },
      body: JSON.stringify({ model: "gemini-3.6-flash", ...body }),
    });
  }
  function sessionHeader(r: any) {
    const id = r.headers.get("X-Gemini-Session-Id");
    expect(id).toMatch(/^acc_[a-f0-9]{32}\.s_[a-f0-9]{32}$/);
    expect(r.headers.get("X-Session-Id")).toBe(id);
    expect(r.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-Gemini-Session-Id",
    );
    return id;
  }
  it.each([false, true])(
    "accepts opaque body/header IDs with full history (stream=%s)",
    async (stream) => {
      await freshAccount();
      const r = await chat(
        { stream, session_id: opaque, messages: history },
        { "X-Session-Id": "client-trace" },
      );
      expect(r.status).toBe(200);
      const id = sessionHeader(r);
      const text = await r.text();
      if (stream) {
        expect(text).toContain("data: [DONE]");
        expect(text).not.toContain("event: error");
      } else
        expect(JSON.parse(text).choices[0].message.content).toBe(
          "Hello runtime",
        );
      expect(lastPrompt).toContain("EARLIER_QUESTION");
      expect(lastPrompt).toContain("NEW_QUESTION");
      expect(lastPayload[2][0]).toBeFalsy();
      // Reusing a client ID does not group accounts or resume a remote chat.
      const next = await chat({ session_id: opaque, messages: history });
      expect(next.status).toBe(200);
      expect(sessionHeader(next)).not.toBe(id);
      await next.text();
      expect(lastPayload[2][0]).toBeFalsy();
    },
  );
  it.each([false, true])(
    "returns real OpenAI-shaped tool calls with opaque IDs (stream=%s)",
    async (stream) => {
      await freshAccount();
      const tools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ];
      let call: any;
      returnTool = true;
      try {
        const r = await chat(
          {
            stream,
            session_id: opaque,
            messages: history,
            tools,
            tool_choice: "required",
          },
          { "X-Session-Id": "trace" },
        );
        expect(r.status).toBe(200);
        sessionHeader(r);
        if (stream) {
          const text = await r.text();
          expect(text).toContain("data: [DONE]");
          expect(text).not.toContain("event: error");
          const chunks = text
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)));
          expect(
            chunks.some((c) => c.choices[0].finish_reason === "tool_calls"),
          ).toBe(true);
          call = chunks.flatMap((c) => c.choices[0].delta.tool_calls || [])[0];
        } else {
          const b: any = await r.json();
          expect(b.choices[0].finish_reason).toBe("tool_calls");
          expect(b.choices[0].message.content).toBeNull();
          call = b.choices[0].message.tool_calls[0];
        }
        expect(call.id).toMatch(/^call_/);
        expect(call.type).toBe("function");
        expect(call.function.name).toBe("get_weather");
        expect(JSON.parse(call.function.arguments)).toEqual({
          city: "Shanghai",
        });
      } finally {
        returnTool = false;
      }
      const result = await chat({
        session_id: opaque,
        tools,
        tool_choice: "none",
        messages: [
          ...history,
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: "LOCAL_TOOL_RESULT" },
        ],
      });
      expect(result.status).toBe(200);
      await result.text();
      expect(lastPrompt).toContain("LOCAL_TOOL_RESULT");
      expect(lastPrompt).toContain(
        "Tool choice: none. Do not request or execute any function.",
      );
      expect(lastPrompt).toContain("EARLIER_QUESTION");
    },
  );
  it("strictly resumes canonical IDs and retains ownership/delta-mode guards", async () => {
    await freshAccount();
    const first = await chat({ messages: history });
    const id = sessionHeader(first);
    await first.text();
    const wrongHistory = await chat({
      gemini_session_id: id,
      messages: history,
    });
    expect(wrongHistory.status).toBe(400);
    const other: any = await (
      await req("/admin/keys", { name: "canonical-owner-test" }, admin)
    ).json();
    const denied = await req(
      "/v1/chat/completions",
      {
        gemini_session_id: id,
        messages: [{ role: "user", content: "cannot access" }],
      },
      other.key,
    );
    expect(denied.status).toBe(404);
    for (const viaHeader of [false, true]) {
      const r = await chat(
        {
          messages: [{ role: "user", content: "DELTA_ONLY" }],
          ...(viaHeader ? { session_id: opaque } : { gemini_session_id: id }),
        },
        viaHeader ? { "X-Gemini-Session-Id": id } : {},
      );
      expect(r.status).toBe(200);
      expect(sessionHeader(r)).toBe(id);
      await r.text();
      expect(lastPrompt).not.toContain("EARLIER_QUESTION");
      expect(lastPayload[2][0]).toBe("c_runtime");
    }
    const model = await chat({
      model: "gemini-3.1-pro",
      gemini_session_id: id,
      messages: [{ role: "user", content: "different model" }],
    });
    expect(model.status).toBe(400);
    expect(((await model.json()) as any).error.code).toBe("session_model");
  });
  it("rejects invalid/conflicting IDs before any upstream work, preserving resource validation", async () => {
    const { id } = await freshAccount(),
      before = calls;
    for (const [body, extra, code] of [
      [{ session_id: { id: opaque } }, {}, "invalid_session_id"],
      [{ gemini_session_id: opaque }, {}, "invalid_session_id"],
      [{ session_id: id + ".s_bad" }, {}, "invalid_session_id"],
      [{}, { "X-Gemini-Session-Id": opaque }, "invalid_session_id"],
      [
        { gemini_session_id: id + ".s_" + "a".repeat(32) },
        { "X-Session-Id": id + ".s_" + "b".repeat(32) },
        "conflicting_session_ids",
      ],
    ] as [any, Record<string, string>, string][]) {
      const r = await chat({ ...body, messages: history }, extra);
      expect(r.status).toBe(400);
      const b: any = await r.json();
      expect(b.error.code).toBe(code);
      expect(b.error.message).not.toContain(opaque);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    for (const path of ["/v1/files/bad/content", "/v1/videos/bad"]) {
      const r = await req(path);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe("invalid_id");
    }
    expect(calls).toBe(before);
  });
  it("does not drop explicit IDs when adapting Google or media bodies", async () => {
    const { id } = await freshAccount(),
      before = calls;
    const gemini_session_id = id + ".s_" + "a".repeat(32);
    for (const [path, body] of [
      ["/v1/responses", { input: "test" }],
      [
        "/v1beta/models/gemini-3.6-flash:generateContent",
        { contents: [{ role: "user", parts: [{ text: "test" }] }] },
      ],
      ["/v1/images/generations", { prompt: "test" }],
    ] as const) {
      const r = await req(path, { ...body, gemini_session_id });
      expect(r.status).toBe(404);
      expect(((await r.json()) as any).error.code).toBe("not_found");
    }
    expect(calls).toBe(before);
  });
});

describe("bounded pre-submission scheduling", () => {
  it.each([
    { stream: false, startDelay: 0 },
    { stream: true, startDelay: 0 },
    { stream: false, startDelay: 750 },
    { stream: true, startDelay: 750 },
  ])(
    "queues rather than submitting concurrently (stream=$stream, startup=$startDelay ms)",
    async ({ stream, startDelay }) => {
      const { id } = await freshAccount();
      const held = holdUpstream(startDelay);
      const before = calls;
      const first = req("/v1/chat/completions", {
        messages: [{ role: "user", content: "FIRST_QUEUED_TEST" }],
      }).then(async (r) => {
        expect(r.status).toBe(200);
        return r.text();
      });
      let second: Promise<any> | undefined;
      try {
        await held.waitUntilStarted();
        expect(calls).toBe(before + 1);
        second = req("/v1/chat/completions", {
          stream,
          messages: [{ role: "user", content: "SECOND_QUEUED_TEST" }],
        }).then(async (r) => {
          expect(r.status).toBe(200);
          return r.text();
        });
        let status: any;
        for (let i = 0; i < 30; i++) {
          status = await (
            await req(`/admin/accounts/${id}/status`, undefined, admin)
          ).json();
          if (status.queued === 1) break;
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(status.queued).toBe(1);
        expect(status.busy).toBe(true);
        expect(status.busy_since).toBeGreaterThan(0);
        expect(status.rate_limit.used).toBe(1);
        expect(calls).toBe(before + 1);
        held.release();
        await first;
        const text = await second;
        if (stream) expect(text).toContain("data: [DONE]");
        expect(calls).toBe(before + 2);
        status = await (
          await req(`/admin/accounts/${id}/status`, undefined, admin)
        ).json();
        expect(status.queued).toBe(0);
        expect(status.busy).toBe(false);
        expect(status.rate_limit.used).toBe(2);
      } finally {
        held.release();
        await first;
        await second;
      }
    },
  );
  it("preserves a real rate rejection and exact reset hint instead of pool_busy", async () => {
    const { stub, id } = await freshAccount();
    const minute = Math.floor(Date.now() / 60000);
    await storage(stub, { put: { rate: { minute, count: 6 } } });
    const before = calls;
    const r = await req("/v1/chat/completions", {
      messages: [{ role: "user", content: "not submitted" }],
    });
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error.code).toBe("account_rate_limit");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(r.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(calls).toBe(before);
    const s: any = await (
      await req(`/admin/accounts/${id}/status`, undefined, admin)
    ).json();
    expect(s.busy).toBe(false);
    expect(s.rate_limit.remaining).toBe(0);
    await storage(stub, { put: { rate: { minute: minute - 1, count: 6 } } });
    const next = await req("/v1/chat/completions", {
      messages: [{ role: "user", content: "new minute" }],
    });
    expect(next.status).toBe(200);
    await next.text();
    expect(calls).toBe(before + 1);
  });
});
