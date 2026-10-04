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
  decodeEnvelope,
  emptyResult,
  envelopeLines,
  upstreamFailure,
} from "./protocol";
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
    if (/max-age=0(?:;|$)/i.test(h) || !value) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
export function pageTokens(html: string) {
  const value = (key: string) => {
    const m = html.match(
      new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'),
    );
    try {
      return m ? JSON.parse(m[1]) : "";
    } catch {
      return "";
    }
  };
  return {
    xsrf: value("SNlM0e"),
    bl: value("cfb2h"),
    pushId: value("qKIAYe"),
    pctx: value("Ylro7b"),
    fetchedAt: now(),
  };
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
  if (target.hostname === "accounts.google.com")
    return new ApiError(
      502,
      "login_expired",
      "Google redirected to account login. The imported session may be expired or device-bound.",
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
  async tokens(force = false) {
    if (
      !force &&
      this.credentials.xsrf &&
      this.credentials.bl &&
      now() - (this.credentials.fetchedAt || 0) < 1200
    )
      return;
    const r = await this.send(ORIGIN + "/app", {
      headers: { Accept: "text/html" },
    });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      throw new ApiError(
        502,
        "login_expired",
        "Gemini redirected to login. Re-import a valid session.",
      );
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw upstreamFailure(r.status);
    }
    const tokens = pageTokens(
      new TextDecoder().decode(await readLimited(r, 8 * 1024 * 1024)),
    );
    if (!tokens.xsrf || !tokens.bl)
      throw new ApiError(
        502,
        "login_expired",
        "Gemini did not return signed-in page tokens. Re-import the login; device-bound cookies may not be portable.",
      );
    Object.assign(this.credentials, tokens);
    await this.save();
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
    const jar = parseCookies(this.credentials.cookie),
      subset = ["__Secure-1PSID", "__Secure-1PSIDTS"]
        .filter((k) => jar.has(k))
        .map((k) => `${k}=${jar.get(k)}`)
        .join("; ");
    if (!jar.has("__Secure-1PSID"))
      throw new ApiError(
        502,
        "refresh_unavailable",
        "Import __Secure-1PSID to enable automatic refresh",
      );
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://accounts.google.com",
      Referer: "https://accounts.google.com/",
      Cookie: subset,
    };
    const r = await this.send(
      "https://accounts.google.com/RotateCookies",
      { method: "POST", headers, body: '[000,"-0000000000000000000"]' },
      false,
    );
    const set = r.headers.getSetCookie();
    await r.body?.cancel();
    if (!r.ok) throw upstreamFailure(r.status);
    if (!set.some((s) => s.startsWith("__Secure-1PSIDTS=")))
      throw new ApiError(
        502,
        "refresh_no_ticket",
        "Cookie rotation did not issue a fresh login ticket; re-import may be required",
      );
    this.credentials.cookie = mergeCookies(this.credentials.cookie, set);
    this.credentials.refreshedAt = now();
    await this.save();
    await this.tokens(true);
  }
  async generate(
    input: GenerateInput,
    session: Session | undefined,
    onText?: (text: string) => Promise<void>,
  ): Promise<Result> {
    await this.tokens();
    const model = resolveModel(input.model);
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
        input.prompt,
        model,
        uuid,
        session?.metadata,
        session?.turn || 0,
        refs,
      );
    const h = await this.headers();
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
      await this.tokens(true);
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
    for await (const line of envelopeLines(r.body)) {
      const m = line.match(/BardErrorInfo[^0-9]{0,40}(\d{3,5})/);
      if (m) bardCode = m[1];
      for (const frame of decodeEnvelope(line)) {
        const previous = result.text;
        absorb(result, frame);
        if (onText && result.text !== previous) await onText(result.text);
      }
    }
    if (!result.text && !result.urls.length && !result.canvas)
      throw new ApiError(
        502,
        bardCode ? `gemini_${bardCode}` : "no_content",
        bardCode
          ? `Gemini rejected the request (code ${bardCode}). Verify account entitlement and Cloudflare egress.`
          : "Gemini returned no answer. The web protocol or login may have changed.",
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
