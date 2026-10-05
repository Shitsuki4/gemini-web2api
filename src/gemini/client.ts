import type {
  Credentials,
  GenerateInput,
  InputFile,
  Result,
  Session,
} from "../types";
import { ApiError, fromBase64, hex, now, readLimited } from "../util";
import { modelHeader, payload, resolveModel } from "./models";
import {
  absorb,
  absorbSpark,
  decodeEnvelope,
  emptyResult,
  envelopeLines,
  upstreamFailure,
} from "./protocol";
import { refreshLogin, retrySeconds } from "./refresh";
import { inspectPage, pageFailure } from "./page";
export { pageTokens } from "./page";
export const ORIGIN = "https://gemini.google.com";
export function parseCookies(cookie: string) {
  const out = new Map<string, string>();
  for (const p of cookie.split(";")) {
    const i = p.indexOf("=");
    if (i > 0) out.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  return out;
}
export function validateCookie(cookie: unknown): string {
  if (
    typeof cookie !== "string" ||
    cookie.length > 32768 ||
    /[\r\n\x00]/.test(cookie)
  )
    throw new ApiError(
      400,
      "invalid_cookie",
      "Supply a single Cookie header, not Set-Cookie or a JSON export",
    );
  const jar = parseCookies(cookie);
  if (!jar.has("__Secure-1PSID") && !jar.has("__Secure-3PSID"))
    throw new ApiError(
      400,
      "missing_cookie",
      "Cookie must contain __Secure-1PSID or __Secure-3PSID",
    );
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
export function mergeCookies(cookie: string, headers: string[]) {
  const jar = parseCookies(cookie);
  for (const h of headers) {
    const first = h.split(";")[0],
      i = first.indexOf("=");
    if (i < 1) continue;
    const name = first.slice(0, i).trim(),
      value = first.slice(i + 1);
    const age = /;\s*max-age\s*=\s*(-?\d+)\s*(?:;|$)/i.exec(h);
    const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(h);
    const expired = age
      ? Number(age[1]) <= 0
      : !!expires && Date.parse(expires[1]) <= Date.now();
    if (expired || !value) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
// Never include a redirect query (it can carry authentication data) in errors.
export function redirectFailure(response: Response, from: string): ApiError {
  let target: URL;
  try {
    target = new URL(response.headers.get("location") || "", from);
  } catch {
    return new ApiError(
      502,
      "upstream_redirect",
      "Gemini returned an invalid redirect",
    );
  }
  if (
    (target.hostname === "www.google.com" ||
      target.hostname === "google.com") &&
    target.pathname.startsWith("/sorry")
  )
    return new ApiError(
      502,
      "egress_blocked",
      "Google redirected Cloudflare egress to its /sorry challenge. No challenge bypass is attempted.",
    );
  if (target.hostname === "consent.google.com")
    return pageFailure("consent_required");
  if (target.hostname === "accounts.google.com")
    return new ApiError(
      502,
      "login_expired",
      "Google redirected to account login. Check the browser login before updating this account; this does not establish device binding.",
    );
  return new ApiError(
    502,
    "upstream_redirect",
    `Gemini returned HTTP ${response.status} redirect to ${target.hostname}; not followed.`,
  );
}
export class GeminiClient {
  constructor(
    public credentials: Credentials,
    private save: () => Promise<void>,
    private signal: AbortSignal,
    private transport: typeof fetch = fetch.bind(globalThis),
  ) {}
  async send(url: string, init: RequestInit = {}, cookies = true) {
    const h = new Headers(init.headers);
    if (this.credentials.userAgent)
      h.set("User-Agent", this.credentials.userAgent);
    h.set("Accept-Language", "en-US,en;q=0.9");
    if (cookies) h.set("Cookie", this.credentials.cookie);
    const r = await this.transport(url, {
      ...init,
      headers: h,
      redirect: "manual",
      signal: this.signal,
    });
    if (cookies && r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      throw redirectFailure(r, url);
    }
    if (cookies) {
      const next = mergeCookies(
        this.credentials.cookie,
        r.headers.getSetCookie(),
      );
      if (next !== this.credentials.cookie) {
        this.credentials.cookie = next;
        await this.save();
      }
    }
    return r;
  }
  async tokens(force = false, surface: "app" | "spark" = "app") {
    if (
      !force &&
      this.credentials.xsrf &&
      this.credentials.bl &&
      (this.credentials.tokenSurface || "app") === surface &&
      now() - (this.credentials.fetchedAt || 0) < 1200
    )
      return;
    // A failed forced probe must not leave apparently fresh cached page tokens.
    if (this.credentials.fetchedAt) {
      this.credentials.fetchedAt = 0;
      await this.save();
    }
    const previous = this.credentials.pageDiagnostic;
    // User retries must not bypass the persisted page cooldown. Forced probes
    // are used only by independently due maintenance / explicit HTTP-400 repair.
    if (
      !force &&
      previous?.code &&
      previous.surface === surface &&
      now() < (previous.retryAt || 0)
    )
      throw pageFailure(
        previous.code,
        previous.retryAt! - now(),
        previous.errorStatus,
      );
    let diagnostic: Credentials["pageDiagnostic"] = {
      at: now(),
      surface,
      kind: "error",
    };
    try {
      const r = await this.send(ORIGIN + "/" + surface, {
        headers: { Accept: "text/html" },
      });
      diagnostic.httpStatus = r.status;
      if (!r.ok) {
        await r.body?.cancel();
        const error = upstreamFailure(r.status);
        error.retryAfter = retrySeconds(r.headers.get("retry-after"));
        throw error;
      }
      const body = await readLimited(r, 8 * 1024 * 1024);
      const checked = inspectPage(
        new TextDecoder().decode(body),
        surface,
        r.status,
        body.byteLength,
      );
      diagnostic = checked.diagnostic;
      if (diagnostic.code) throw pageFailure(diagnostic.code);
      Object.assign(this.credentials, checked.tokens, {
        tokenSurface: surface,
        pageDiagnostic: diagnostic,
      });
      await this.save();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "page_network_error";
      diagnostic.code = code;
      diagnostic.errorStatus = e instanceof ApiError ? e.status : 502;
      if (code === "egress_blocked") diagnostic.kind = "challenge";
      else if (code === "login_expired") diagnostic.kind = "signed_out";
      else if (code === "consent_required") diagnostic.kind = "consent";
      diagnostic.retryAt =
        now() + Math.max(600, e instanceof ApiError ? e.retryAfter || 0 : 0);
      this.credentials.pageDiagnostic = diagnostic;
      if (e instanceof ApiError) e.retryAfter = diagnostic.retryAt - now();
      await this.save();
      throw e;
    }
  }
  async headers() {
    const h = new Headers({
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Origin: ORIGIN,
      Referer: ORIGIN + "/app",
      "X-Same-Domain": "1",
      "X-Goog-AuthUser": "0",
      "x-goog-ext-73010989-jspb": "[0]",
      "x-goog-ext-73010990-jspb": "[0,0,0]",
    });
    const jar = parseCookies(this.credentials.cookie),
      sapisid =
        jar.get("SAPISID") ||
        jar.get("__Secure-3PAPISID") ||
        jar.get("__Secure-1PAPISID");
    if (sapisid) {
      const t = now(),
        hash = hex(
          await crypto.subtle.digest(
            "SHA-1",
            new TextEncoder().encode(`${t} ${sapisid} ${ORIGIN}`),
          ),
        );
      h.set("Authorization", `SAPISIDHASH ${t}_${hash}`);
    }
    return h;
  }
  async rotate() {
    return refreshLogin({
      credentials: this.credentials,
      save: () => this.save(),
      send: (url, init) => this.send(url, init, false),
      tokens: () => this.tokens(true),
      merge: mergeCookies,
    });
  }
  async generate(
    input: GenerateInput,
    session: Session | undefined,
    onText?: (text: string) => Promise<void>,
  ): Promise<Result> {
    const model = resolveModel(input.model);
    if (
      model.spark &&
      (input.files.length ||
        input.tools?.length ||
        (input.responseFormat &&
          (input.responseFormat as { type?: string }).type !== "text") ||
        !["chat", "responses", "google"].includes(input.endpoint))
    )
      throw new ApiError(
        400,
        "spark_text_only",
        "Spark currently supports text chat/Responses only, without attachments, function tools or structured output",
      );
    if (model.spark && session && !session.sparkContext)
      throw new ApiError(
        409,
        "spark_context_missing",
        "Spark continuation context is missing; start a new session",
      );
    // Sustained generation traffic can keep alarms behind the account lock.
    // Run an already-due round before submission, never in the middle of a turn.
    const due =
      this.credentials.maintenance?.nextAttemptAt ??
      (this.credentials.importedAt ? this.credentials.importedAt + 15 : 0);
    if (due && now() >= due) await this.rotate();
    try {
      await this.tokens(false, model.spark ? "spark" : "app");
    } catch (e) {
      // Recover only before any generation/upload is submitted. Never replay a
      // StreamGenerate failure here: a task could already have been accepted.
      // The existing explicit HTTP-400 token correction below is unchanged.
      if (
        !(e instanceof ApiError) ||
        e.code !== "login_expired" ||
        now() < (this.credentials.maintenance?.nextAttemptAt || 0)
      )
        throw e;
      const maintenance = await this.rotate();
      if (maintenance.page?.status !== "ok") throw e;
      await this.tokens(false, model.spark ? "spark" : "app");
    }
    const refs = [];
    for (const file of input.files) {
      const ref = await this.upload(file);
      refs.push([
        [ref, 1, null, file.mime],
        file.name,
        null,
        null,
        null,
        null,
        null,
        null,
        [0],
      ]);
    }
    const uuid = crypto.randomUUID(),
      data = payload(
        model.spark
          ? "[API scope: text replies only. Do not browse, use tools, access files or connected apps, schedule tasks, or take external actions. If the request requires those capabilities, explain the limitation instead.]\n\n" +
              input.prompt
          : input.prompt,
        model,
        uuid,
        session?.metadata,
        session?.turn || 0,
        refs,
        session?.sparkContext,
      );
    const h = await this.headers();
    if (model.spark) h.set("Referer", ORIGIN + "/spark");
    h.set("x-goog-ext-525001261-jspb", modelHeader(model, crypto.randomUUID()));
    h.set("x-goog-ext-525005358-jspb", JSON.stringify([uuid, 1]));
    const endpoint = () =>
      ORIGIN +
      "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?" +
      new URLSearchParams({
        bl: this.credentials.bl!,
        hl: "en",
        _reqid: String(Math.floor(Math.random() * 900000) + 100000),
        rt: "c",
      });
    const form = () =>
      new URLSearchParams({
        "f.req": JSON.stringify([null, JSON.stringify(data)]),
        at: this.credentials.xsrf!,
      }).toString();
    let r = await this.send(endpoint(), {
      method: "POST",
      headers: h,
      body: form(),
    });
    if (r.status === 400) {
      await r.body?.cancel();
      await this.tokens(true, model.spark ? "spark" : "app");
      r = await this.send(endpoint(), {
        method: "POST",
        headers: h,
        body: form(),
      });
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw upstreamFailure(r.status);
    }
    if (!r.body)
      throw new ApiError(
        502,
        "empty_response",
        "Gemini returned an empty stream",
      );
    const result = emptyResult();
    let bardCode = "";
    let sparkCompleted = false;
    let frameCount = 0;
    const sparkEvents = new Set<string>();
    for await (const line of envelopeLines(r.body)) {
      const m = line.match(/BardErrorInfo[^0-9]{0,40}(\d{3,5})/);
      if (m) bardCode = m[1];
      for (const frame of decodeEnvelope(line)) {
        frameCount++;
        if (model.spark && frame?.[2] && typeof frame[2] === "object")
          for (const k of Object.keys(frame[2]))
            if (/^\d{1,3}$/.test(k)) sparkEvents.add(k);
        const previous = result.text;
        if (model.spark)
          sparkCompleted = absorbSpark(result, frame) || sparkCompleted;
        else absorb(result, frame);
        if (onText && result.text !== previous) await onText(result.text);
      }
    }
    if (model.spark && bardCode)
      throw new ApiError(
        502,
        `gemini_${bardCode}`,
        `Gemini rejected the Spark task (code ${bardCode}); any partial answer is not a successful completion.`,
      );
    if (!result.text && !result.urls.length && !result.canvas)
      throw new ApiError(
        502,
        bardCode ? `gemini_${bardCode}` : "no_content",
        bardCode
          ? `Gemini rejected the request (code ${bardCode}). Verify account entitlement and Cloudflare egress.`
          : model.spark
            ? `Spark returned no answer (frames=${frameCount}; control fields=${[...sparkEvents].sort().join(",")}; task=${!!result.sparkContext}; completed=${sparkCompleted}). No task is automatically replayed.`
            : "Gemini returned no answer. The web protocol or login may have changed.",
      );
    if (model.spark && !sparkCompleted)
      throw new ApiError(
        502,
        "spark_incomplete",
        "Spark task did not return its completion event; it may still exist upstream. No automatic replay is attempted.",
      );
    return result;
  }
  async rpc(id: string, args: unknown[]) {
    await this.tokens();
    const form = new URLSearchParams({
      "f.req": JSON.stringify([[[id, JSON.stringify(args), null, "generic"]]]),
      at: this.credentials.xsrf!,
    });
    const r = await this.send(
      ORIGIN +
        "/_/BardChatUi/data/batchexecute?" +
        new URLSearchParams({
          rpcids: id,
          bl: this.credentials.bl!,
          hl: "en",
          rt: "c",
          _reqid: String(Date.now() % 1000000),
        }),
      { method: "POST", headers: await this.headers(), body: form.toString() },
    );
    if (!r.ok) {
      await r.body?.cancel();
      throw upstreamFailure(r.status);
    }
    const results: any[] = [];
    if (r.body)
      for await (const line of envelopeLines(r.body))
        results.push(...decodeEnvelope(line));
    return results;
  }
  async history(cid: string) {
    const frames = await this.rpc("hNvQHb", [
      cid,
      10,
      null,
      1,
      [0],
      [4],
      null,
      1,
    ]);
    const r = emptyResult();
    for (const f of frames) absorb(r, f);
    return r;
  }
  async upload(file: InputFile) {
    if (!this.credentials.pushId)
      throw new ApiError(
        502,
        "upload_tokens_missing",
        "The imported session has no upload token; refresh the account",
      );
    const bytes = fromBase64(file.data);
    if (bytes.length > 768 * 1024)
      throw new ApiError(
        413,
        "file_too_large",
        "File exceeds the free-tier 768 KiB limit",
      );
    const h = new Headers({
      Origin: ORIGIN,
      Referer: ORIGIN + "/",
      "X-Tenant-Id": "bard-storage",
      "Push-ID": this.credentials.pushId,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
    });
    if (this.credentials.pctx) h.set("X-Client-Pctx", this.credentials.pctx);
    const r = await this.send("https://push.clients6.google.com/upload/", {
      method: "POST",
      headers: h,
      body: "File name: " + file.name.replace(/[\r\n]/g, ""),
    });
    const location = r.headers.get("x-goog-upload-url");
    await r.body?.cancel();
    if (!r.ok || !location)
      throw new ApiError(
        502,
        "upload_start_failed",
        "Gemini rejected the upload start",
      );
    const u = new URL(location);
    if (
      u.protocol !== "https:" ||
      u.hostname !== "push.clients6.google.com" ||
      u.port ||
      u.username ||
      u.password
    )
      throw new ApiError(
        502,
        "unsafe_upload_url",
        "Unexpected upload destination",
      );
    h.delete("X-Goog-Upload-Protocol");
    h.delete("X-Goog-Upload-Header-Content-Length");
    h.set("X-Goog-Upload-Command", "upload, finalize");
    h.set("X-Goog-Upload-Offset", "0");
    const done = await this.send(u.href, {
      method: "POST",
      headers: h,
      body: bytes,
    });
    if (!done.ok) {
      await done.body?.cancel();
      throw new ApiError(
        502,
        "upload_failed",
        `Upload returned HTTP ${done.status}`,
      );
    }
    const ref = new TextDecoder().decode(await readLimited(done, 4096)).trim();
    if (!ref.startsWith("/"))
      throw new ApiError(
        502,
        "upload_failed",
        "Gemini returned an invalid file reference",
      );
    return ref;
  }
  async download(url: string, range?: string | null) {
    const jar = parseCookies(this.credentials.cookie);
    const names = [
      "SID",
      "HSID",
      "SSID",
      "APISID",
      "SAPISID",
      "__Secure-1PSID",
      "__Secure-3PSID",
      "__Secure-1PAPISID",
      "__Secure-3PAPISID",
      "__Secure-1PSIDTS",
      "__Secure-3PSIDTS",
      "__Secure-1PSIDRTS",
      "__Secure-3PSIDRTS",
      "SIDCC",
      "__Secure-1PSIDCC",
      "__Secure-3PSIDCC",
      "NID",
      "GOOGLE_ABUSE_EXEMPTION",
    ];
    const cookies = names
      .filter((k) => jar.has(k))
      .map((k) => `${k}=${jar.get(k)}`)
      .join("; ");
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(url);
      if (!isDownloadHost(u))
        throw new ApiError(
          502,
          "unsafe_media_url",
          "Media redirect left the allowed Google download hosts",
        );
      const h = new Headers({
        Cookie: cookies,
        Referer: ORIGIN + "/",
        Origin: ORIGIN,
      });
      if (range) h.set("Range", range);
      const r = await this.send(url, { headers: h }, false);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        await r.body?.cancel();
        if (!loc)
          throw new ApiError(502, "media_redirect", "Missing media redirect");
        url = new URL(loc, url).href;
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw upstreamFailure(r.status);
      }
      const mime = r.headers.get("content-type") || "";
      if (!/^(image|audio|video)\//.test(mime)) {
        await r.body?.cancel();
        throw new ApiError(
          502,
          "invalid_media",
          "Upstream did not return an image, audio or video",
        );
      }
      const headers = new Headers({
        "Content-Type": mime,
        "Cache-Control": "private, no-store",
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
      });
      for (const k of ["content-length", "content-range", "accept-ranges"])
        if (r.headers.has(k)) headers.set(k, r.headers.get(k)!);
      return new Response(r.body, { status: r.status, headers });
    }
    throw new ApiError(502, "media_redirect", "Too many media redirects");
  }
}
export function isDownloadHost(u: URL) {
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    /^(lh[3-6]\.googleusercontent\.com|work\.fife\.usercontent\.google\.com|contribution\.usercontent\.google\.com)$/.test(
      u.hostname,
    )
  );
}
