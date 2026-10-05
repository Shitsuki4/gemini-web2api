import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiClient } from "../src/gemini/client";
import { inspectPage, pageTokens } from "../src/gemini/page";
import { errorResponse } from "../src/util";
import type { Credentials } from "../src/types";
const time = 1791174000;
afterEach(() => vi.restoreAllMocks());
describe("sanitized page diagnostics", () => {
  it("preserves valid escaped WIZ tokens without exporting values", () => {
    const html =
      '"SNlM0e":"private\\u003dtoken","cfb2h":"private_build","oPEP7c":"private@example.test"';
    const { tokens, diagnostic } = inspectPage(html, "app", 200, html.length);
    expect(tokens.xsrf).toBe("private=token");
    expect(diagnostic).toMatchObject({
      kind: "signed_in",
      accountMarker: "present",
      hasXsrf: true,
      hasBuild: true,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|example/);
    expect(pageTokens("not json").xsrf).toBe("");
  });
  it.each([
    ['"oPEP7c":"","cfb2h":"build"', "signed_out", "login_expired"],
    [
      '"oPEP7c":"private@example.test","cfb2h":"build"',
      "unrecognized",
      "page_tokens_missing",
    ],
    ["<html>unknown layout</html>", "unrecognized", "page_tokens_missing"],
    [
      "Our systems have detected unusual traffic from your computer network.",
      "challenge",
      "egress_blocked",
    ],
    [
      '<form id="captcha-form" action="/sorry/index?private=secret">',
      "challenge",
      "egress_blocked",
    ],
  ])(
    "classifies pages without inferring device binding",
    (html, kind, code) => {
      const { diagnostic } = inspectPage(html, "app", 200, html.length);
      expect(diagnostic).toMatchObject({ kind, code });
      expect(JSON.stringify(diagnostic)).not.toMatch(/private|secret|example/);
    },
  );
  it("does not treat a normal recaptcha script / sign-in link alone as a challenge or expired login", () => {
    const html =
      '<script src="https://www.google.com/recaptcha/api.js"></script><a href="https://accounts.google.com/ServiceLogin">Sign in</a>';
    expect(inspectPage(html, "app", 200, html.length).diagnostic.code).toBe(
      "page_tokens_missing",
    );
  });
  it("persists missing-token evidence and gates repeat preflights across restarts", async () => {
    vi.spyOn(Date, "now").mockReturnValue(time * 1000);
    const creds: Credentials = {
      cookie: "__Secure-1PSID=PRIVATE",
      xsrf: "stale",
      bl: "stale",
      fetchedAt: time - 1800,
    };
    const save = vi.fn(async () => {});
    const transport = vi.fn(
      async () => new Response("<html>changed layout PRIVATE</html>"),
    );
    const make = () =>
      new GeminiClient(
        creds,
        save,
        AbortSignal.timeout(1000),
        transport as typeof fetch,
      );
    await expect(make().tokens()).rejects.toMatchObject({
      code: "page_tokens_missing",
    });
    expect(creds.fetchedAt).toBe(0);
    expect(creds.pageDiagnostic).toMatchObject({
      httpStatus: 200,
      hasXsrf: false,
      hasBuild: false,
      kind: "unrecognized",
      retryAt: time + 600,
    });
    expect(JSON.stringify(creds.pageDiagnostic)).not.toContain("PRIVATE");
    await expect(make().tokens()).rejects.toMatchObject({
      code: "page_tokens_missing",
      retryAfter: 600,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue((time + 600) * 1000);
    await expect(make().tokens()).rejects.toMatchObject({
      code: "page_tokens_missing",
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each([
    [
      "https://www.google.com/sorry/index?token=PRIVATE",
      "challenge",
      "egress_blocked",
    ],
    [
      "https://accounts.google.com/ServiceLogin?token=PRIVATE",
      "signed_out",
      "login_expired",
    ],
    [
      "https://consent.google.com/m?token=PRIVATE",
      "consent",
      "consent_required",
    ],
  ])(
    "persists redirect diagnosis without following or leaking query",
    async (url, kind, code) => {
      const creds: Credentials = { cookie: "__Secure-1PSID=PRIVATE" };
      const transport = vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: url } }),
      );
      const c = new GeminiClient(
        creds,
        async () => {},
        AbortSignal.timeout(1000),
        transport as typeof fetch,
      );
      await expect(c.tokens(true)).rejects.toMatchObject({ code });
      expect(creds.pageDiagnostic?.kind).toBe(kind);
      expect(JSON.stringify(creds.pageDiagnostic)).not.toMatch(
        /PRIVATE|token=|google.com/,
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps page HTTP-429 semantics and Retry-After on cached failures", async () => {
    vi.spyOn(Date, "now").mockReturnValue(time * 1000);
    const creds: Credentials = { cookie: "__Secure-1PSID=PRIVATE" };
    const transport = vi.fn(
      async () =>
        new Response("limited", {
          status: 429,
          headers: { "retry-after": "7200" },
        }),
    );
    const c = new GeminiClient(
      creds,
      async () => {},
      AbortSignal.timeout(1000),
      transport as typeof fetch,
    );
    await expect(c.tokens()).rejects.toMatchObject({
      status: 429,
      retryAfter: 7200,
    });
    try {
      await c.tokens();
      throw Error("expected error");
    } catch (e) {
      const r = errorResponse(e);
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("7200");
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
