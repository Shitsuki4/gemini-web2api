import { describe, it, expect } from "vitest";
import {
  payload,
  modelHeader,
  resolveModel,
  MODELS,
} from "../src/gemini/models";
import {
  absorb,
  decodeEnvelope,
  delta,
  emptyResult,
  envelopeLines,
  isArtifactUrl,
} from "../src/gemini/protocol";
import {
  GeminiClient,
  mergeCookies,
  pageTokens,
  validateCookie,
  isDownloadHost,
} from "../src/gemini/client";
import { normalize, parseToolCalls, finishResult } from "../src/api";
import {
  seal,
  unseal,
  constantEqual,
  readJson,
  readLimited,
} from "../src/util";
const secret = btoa("a".repeat(32));
const key = "owner";
export function frame(text = "Hello", actual = "3.6 Flash") {
  const inner: any[] = Array(43).fill(null);
  inner[1] = ["c_test", "r_test"];
  const candidate: any[] = Array(38).fill(null);
  candidate[0] = "rc_test";
  candidate[1] = [text];
  candidate[37] = [["private trace should not leave gateway"]];
  inner[4] = [candidate];
  inner[42] = ["fbb127bbb056c959", null, null, actual, true];
  return inner;
}
function envelope(inner: any) {
  return JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify(inner)]]);
}
describe("Gemini wire protocol", () => {
  it("uses the authoritative header model switch and separate UUIDs", () => {
    const model = resolveModel("gemini-3.1-pro-thinking");
    const p = payload("hi", model, "request-uuid");
    expect(p).toHaveLength(97);
    expect(p[79]).toBe(3);
    expect(p[80]).toBe(2);
    expect(p[59]).toBe("request-uuid");
    const h = JSON.parse(modelHeader(model, "header-uuid"));
    expect(h[4]).toBe("9d8ca3786ebdfbea");
    expect(h[15]).toBe(2);
    expect(h[16]).toBe("header-uuid");
  });
  it("uses turn index not invented thinking depth", () => {
    expect(payload("x", MODELS[0], "id", ["c", "r", "rc"], 4)[17]).toEqual([
      [4],
    ]);
    expect(() => resolveModel("gemini-3.6-flash@think=9")).toThrow();
  });
  it("sets native media switches", () => {
    expect(payload("x", resolveModel("gemini-image"), "id")[49]).toBe(14);
    expect(payload("x", resolveModel("gemini-video"), "id")[55]).toEqual([
      [16],
    ]);
  });
  it("decodes all envelopes on a line", () => {
    const line = JSON.stringify([
      ["wrb.fr", "x", JSON.stringify(frame())],
      ["wrb.fr", "x", JSON.stringify(frame("world"))],
    ]);
    expect(decodeEnvelope(line)).toHaveLength(2);
    expect(decodeEnvelope("123")).toEqual([]);
  });
  it("parses metadata and actual model without exposing private reasoning", () => {
    const r = emptyResult();
    absorb(r, frame());
    expect(r.text).toBe("Hello");
    expect(r.actualModel).toBe("3.6 Flash");
    expect(r.metadata).toEqual(["c_test", "r_test", "rc_test"]);
    expect(JSON.stringify(r)).not.toContain("private trace");
  });
  it("handles split UTF-8 and final line without newline", async () => {
    const raw = ")]}'\n123\n" + envelope(frame("你好🙂"));
    const b = new TextEncoder().encode(raw);
    const stream = new ReadableStream({
      start(c) {
        for (const byte of b) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    });
    const lines = [];
    for await (const l of envelopeLines(stream)) lines.push(l);
    expect(lines).toEqual([envelope(frame("你好🙂"))]);
  });
  it("rejects oversized frame buffers", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(30)));
        c.close();
      },
    });
    await expect(
      (async () => {
        for await (const _ of envelopeLines(stream, 20)) {
        }
      })(),
    ).rejects.toThrow("frame");
  });
  it("diffs cumulative output and never duplicates a revised prefix", () => {
    expect(delta("abc", "abcdef")).toBe("def");
    expect(delta("abcdef", "abc")).toBe("");
    expect(() => delta("abc", "ax")).toThrow("revised");
  });
  it("allows only precise media hosts and paths", () => {
    expect(isArtifactUrl("https://lh3.googleusercontent.com/gg-dl/token")).toBe(
      true,
    );
    expect(
      isArtifactUrl("https://evil.test/?q=lh3.googleusercontent.com/gg/token"),
    ).toBe(false);
    expect(isArtifactUrl("https://lh3.googleusercontent.com/avatar")).toBe(
      false,
    );
    expect(
      isArtifactUrl(
        "https://contribution.usercontent.google.com/download?c=" +
          btoa("response_data"),
      ),
    ).toBe(true);
    expect(
      isArtifactUrl(
        "https://contribution.usercontent.google.com/download?c=" +
          btoa("temp_data"),
      ),
    ).toBe(false);
  });
});
describe("credentials and transport safety", () => {
  it("encrypts, decrypts and binds ciphertext to an account", async () => {
    const data = await seal({ cookie: "SECRET" }, secret, "account1");
    expect(data).not.toContain("SECRET");
    expect(await unseal(data, secret, "account1")).toEqual({
      cookie: "SECRET",
    });
    await expect(unseal(data, secret, "account2")).rejects.toThrow();
  });
  it("rejects missing key and non-256-bit secrets", async () => {
    await expect(seal({}, "", "a")).rejects.toThrow("not configured");
    await expect(seal({}, btoa("short"), "a")).rejects.toThrow("32-byte");
  });
  it("compares tokens without prefix acceptance", async () => {
    expect(await constantEqual("key", "key")).toBe(true);
    expect(await constantEqual("key", "key1")).toBe(false);
  });
  it("validates imported headers", () => {
    expect(() => validateCookie("foo=x")).toThrow();
    expect(() => validateCookie("__Secure-1PSID=x\r\nx:y")).toThrow();
    expect(validateCookie("__Secure-1PSID=x; SID=y")).toBe(
      "__Secure-1PSID=x; SID=y",
    );
  });
  it("merges ticket refreshes and honors deletion", () => {
    expect(
      mergeCookies("a=1; __Secure-1PSIDTS=old", [
        "__Secure-1PSIDTS=new; Secure; HttpOnly",
        "a=; Max-Age=0",
      ]),
    ).toBe("__Secure-1PSIDTS=new");
  });
  it("extracts escaped tokens from WIZ data", () => {
    expect(
      pageTokens(
        '"SNlM0e":"abc\\u003d","cfb2h":"boq_test","qKIAYe":"push","Ylro7b":"pctx"',
      ),
    ).toMatchObject({
      xsrf: "abc=",
      bl: "boq_test",
      pushId: "push",
      pctx: "pctx",
    });
  });
  it.each([
    "http://lh3.googleusercontent.com/gg/x",
    "https://evil.googleusercontent.com/",
    "https://lh3.googleusercontent.com.evil.test/",
    "https://u:p@lh3.googleusercontent.com/",
    "https://127.0.0.1/",
    "https://lh3.googleusercontent.com:444/",
  ])("rejects unsafe download %s", (url) => {
    expect(isDownloadHost(new URL(url))).toBe(false);
  });
  it("does not send cookies to an unapproved redirect", async () => {
    let count = 0;
    const transport: any = async () => {
      count++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test/collect" },
      });
    };
    const client = new GeminiClient(
      { cookie: "SID=secret" },
      async () => {},
      new AbortController().signal,
      transport,
    );
    await expect(
      client.download("https://lh3.googleusercontent.com/gg/test"),
    ).rejects.toThrow("allowed");
    expect(count).toBe(1);
  });
  it("preserves download auth tickets on each approved redirect without host-only cookies", async () => {
    const hosts: string[] = [];
    const client = new GeminiClient(
      {
        cookie:
          "SID=sid; __Secure-1PSID=psid; __Secure-1PSIDTS=ticket; __Secure-3PSIDTS=third; SIDCC=cc; __Host-1PLSID=private; LSID=local; OTHER=secret",
      },
      async () => {},
      new AbortController().signal,
      async (url, init) => {
        hosts.push(new URL(String(url)).hostname);
        const cookie = new Headers(init?.headers).get("cookie")!;
        expect(cookie).toContain("__Secure-1PSIDTS=ticket");
        expect(cookie).toContain("__Secure-3PSIDTS=third");
        expect(cookie).toContain("SIDCC=cc");
        expect(cookie).not.toMatch(/__Host-|LSID|OTHER/);
        if (hosts.length === 1)
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://work.fife.usercontent.google.com/rd-gg-dl/test",
            },
          });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      },
    );
    const response = await client.download(
      "https://lh3.googleusercontent.com/gg-dl/test",
    );
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(3);
    expect(hosts).toEqual([
      "lh3.googleusercontent.com",
      "work.fife.usercontent.google.com",
    ]);
  });
  it("does not accept login HTML as image bytes", async () => {
    const client = new GeminiClient(
      { cookie: "SID=x" },
      async () => {},
      new AbortController().signal,
      (async () =>
        new Response("login", {
          headers: { "content-type": "text/html" },
        })) as any,
    );
    await expect(
      client.download("https://lh3.googleusercontent.com/gg/x"),
    ).rejects.toThrow("image");
  });
});
describe("OpenAI normalization and function emulation", () => {
  const base = {
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "hi" }],
  };
  const tool = {
    type: "function" as const,
    function: { name: "weather", parameters: { type: "object" } },
  };
  it("preserves role boundaries and tool outputs", () => {
    const r = normalize(
      {
        ...base,
        messages: [
          { role: "system", content: "rules" },
          { role: "tool", tool_call_id: "call_x", content: "sunny" },
          { role: "user", content: "hi" },
        ],
      },
      "chat",
      key,
      base.model,
    );
    expect(r.prompt).toContain("[tool call_x]\nsunny");
  });
  it("normalizes Responses input", () => {
    expect(
      normalize(
        { input: "hello", instructions: "be concise" },
        "responses",
        key,
        base.model,
      ).prompt,
    ).toBe("[system]\nbe concise\n\n[user]\nhello");
  });
  it("rejects remote images rather than introducing SSRF", () => {
    expect(() =>
      normalize(
        {
          ...base,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "http://localhost/secret" },
                },
              ],
            },
          ],
        },
        "chat",
        key,
        base.model,
      ),
    ).toThrow("SSRF");
  });
  it("supports bounded inline images", () => {
    const r = normalize(
      {
        ...base,
        messages: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: "data:image/png;base64,YQ==" },
            ],
          },
        ],
      },
      "chat",
      key,
      base.model,
    );
    expect(r.files).toHaveLength(1);
    expect(r.files[0].mime).toBe("image/png");
  });
  it("does not silently accept unknown modalities", () => {
    expect(() =>
      normalize(
        {
          ...base,
          messages: [{ role: "user", content: [{ type: "input_audio" }] }],
        },
        "chat",
        key,
        base.model,
      ),
    ).toThrow("Unsupported");
  });
  it("rejects full history with delta-only session IDs", () => {
    expect(() =>
      normalize(
        { ...base, messages: [...base.messages, ...base.messages] },
        "chat",
        key,
        base.model,
        "s_x",
      ),
    ).toThrow("exactly one");
  });
  it("rejects unknown models", () => {
    expect(() =>
      normalize({ ...base, model: "pretend-pro" }, "chat", key, base.model),
    ).toThrow("Unknown model");
  });
  it("does not promise strict schema enforcement", () => {
    expect(() =>
      normalize(
        {
          ...base,
          tools: [{ ...tool, function: { ...tool.function, strict: true } }],
        },
        "chat",
        key,
        base.model,
      ),
    ).toThrow("Strict");
  });
  it("parses only declared tools and object arguments", () => {
    expect(
      parseToolCalls(
        '{"tool_calls":[{"name":"weather","arguments":{"city":"Tokyo"}}]}',
        [tool],
      )?.[0].function.arguments,
    ).toBe('{"city":"Tokyo"}');
    expect(() =>
      parseToolCalls('{"tool_calls":[{"name":"shell","arguments":{}}]}', [
        tool,
      ]),
    ).toThrow();
    expect(parseToolCalls("ordinary text", [tool])).toBeUndefined();
  });
  it("enforces required tools and JSON object output", () => {
    expect(() =>
      finishResult(
        { ...emptyResult(), text: "hello" },
        {
          ...normalize(
            { ...base, tools: [tool], tool_choice: "required" },
            "chat",
            key,
            base.model,
          ),
        },
      ),
    ).toThrow("required");
    expect(() =>
      finishResult(
        { ...emptyResult(), text: "[1]" },
        normalize(
          { ...base, response_format: { type: "json_object" } },
          "chat",
          key,
          base.model,
        ),
      ),
    ).toThrow("JSON object");
  });
  it("tool_choice none prevents function interpretation", () => {
    const r = {
      ...emptyResult(),
      text: '{"tool_calls":[{"name":"weather","arguments":{}}]}',
    };
    finishResult(
      r,
      normalize(
        { ...base, tools: [tool], tool_choice: "none" },
        "chat",
        key,
        base.model,
      ),
    );
    expect((r as any).toolCalls).toBeUndefined();
  });
  it("fails closed for malformed JSON and oversized bodies", async () => {
    await expect(
      readJson(
        new Request("https://x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toThrow("Invalid JSON");
    await expect(readLimited(new Response("abc"), 2)).rejects.toThrow("limit");
  });
});

describe("private trace boundaries", () => {
  it("does not export HTML or media URLs found inside private reasoning", () => {
    const f = frame();
    f[4][0][37] = [
      [
        "<!DOCTYPE html><p>private reasoning</p>",
        "https://lh3.googleusercontent.com/gg/private",
      ],
    ];
    const r = emptyResult();
    absorb(r, f);
    expect(r.canvas).toBe("");
    expect(r.urls).toEqual([]);
    expect(r.text).toBe("Hello");
  });
});
