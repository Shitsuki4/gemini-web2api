import { describe, it, expect } from "vitest";
import { GeminiClient, redirectFailure } from "../src/gemini/client";
import { normalize } from "../src/api";
import type { Credentials } from "../src/types";
const credentials = (): Credentials => ({
  cookie: "__Secure-1PSID=SECRET",
  xsrf: "x",
  bl: "b",
  pushId: "p",
  fetchedAt: Math.floor(Date.now() / 1000),
});
const client = (transport: typeof fetch) =>
  new GeminiClient(
    credentials(),
    async () => {},
    new AbortController().signal,
    transport,
  );
const body = () => ({ messages: [{ role: "user", content: "Hello" }] });
describe("validation and safe upstream handling", () => {
  it.each([null, 1, [], "bad"])("rejects invalid message %j", (m) => {
    expect(() =>
      normalize({ messages: [m] }, "chat", "owner", "gemini-3.6-flash"),
    ).toThrow();
  });
  it("rejects role-only empty requests", () => {
    expect(() =>
      normalize(
        { messages: [{ role: "user", content: "  " }] },
        "chat",
        "o",
        "gemini-3.6-flash",
      ),
    ).toThrow();
  });
  it.each([
    "temperature",
    "max_tokens",
    "max_output_tokens",
    "parallel_tool_calls",
  ])("rejects unsupported %s instead of silently ignoring it", (option) => {
    expect(() =>
      normalize({ ...body(), [option]: 1 }, "chat", "o", "gemini-3.6-flash"),
    ).toThrow(option);
  });
  it("rejects strict Responses JSON schemas", () => {
    expect(() =>
      normalize(
        { input: "x", text: { format: { type: "json_schema", strict: true } } },
        "responses",
        "o",
        "gemini-3.6-flash",
      ),
    ).toThrow();
  });
  it("rejects malformed tools, tool choice without tools, and resumed assistant turns", () => {
    for (const extra of [{ tools: [null] }, { tool_choice: "required" }])
      expect(() =>
        normalize({ ...body(), ...extra }, "chat", "o", "gemini-3.6-flash"),
      ).toThrow();
    expect(() =>
      normalize(
        { messages: [{ role: "assistant", content: "x" }] },
        "chat",
        "o",
        "gemini-3.6-flash",
        "s",
      ),
    ).toThrow();
  });
  it("reports a Google challenge without revealing the redirect query", () => {
    const e = redirectFailure(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://www.google.com/sorry/index?token=SECRET",
        },
      }),
      "https://gemini.google.com",
    );
    expect(e.code).toBe("egress_blocked");
    expect(e.message).not.toContain("SECRET");
  });
  it("does not follow redirects or forward cookies to the redirect destination", async () => {
    let calls = 0;
    const c = client(async (_url, init) => {
      calls++;
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/?secret=SECRET" },
      });
    });
    await expect(c.tokens(true)).rejects.toMatchObject({
      code: "upstream_redirect",
    });
    expect(calls).toBe(1);
  });
  it("rejects upload destinations outside the exact upload origin", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return new Response(null, {
        headers: { "x-goog-upload-url": "https://evil.test/upload" },
      });
    });
    await expect(
      c.upload({ name: "x", mime: "text/plain", data: "aGk=" }),
    ).rejects.toMatchObject({ code: "unsafe_upload_url" });
    expect(calls).toBe(1);
  });
  it("stops media redirects before sending Google cookies to an untrusted host", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/file" },
      });
    });
    await expect(
      c.download("https://lh3.googleusercontent.com/gg/test"),
    ).rejects.toMatchObject({ code: "unsafe_media_url" });
    expect(calls).toBe(1);
  });
  it("rotates only the minimum login cookie pair and saves the fresh ticket", async () => {
    const creds = {
      ...credentials(),
      cookie: "__Secure-1PSID=SID; __Secure-1PSIDTS=OLD; OTHER=PRIVATE",
    };
    let saved = 0;
    const c = new GeminiClient(
      creds,
      async () => {
        saved++;
      },
      new AbortController().signal,
      async (url, init) => {
        if (
          String(url).endsWith("/RotateCookies") &&
          String(init?.body).startsWith("[000,")
        ) {
          const h = new Headers(init?.headers);
          expect(h.get("cookie")).toBe(
            "__Secure-1PSID=SID; __Secure-1PSIDTS=OLD",
          );
          expect(init?.body).toBe('[000,"-0000000000000000000"]');
          return new Response(null, {
            headers: {
              "set-cookie":
                "__Secure-1PSIDTS=NEW; Domain=.google.com; Secure; Path=/",
            },
          });
        }
        return new Response('"SNlM0e":"new-xsrf","cfb2h":"new-build"');
      },
    );
    await c.rotate();
    expect(creds.cookie).toContain("__Secure-1PSIDTS=NEW");
    expect(saved).toBeGreaterThanOrEqual(4);
  });
});
