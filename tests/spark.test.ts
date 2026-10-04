import { describe, it, expect } from "vitest";
import { modelHeader, payload, resolveModel } from "../src/gemini/models";
import { absorbSpark, emptyResult } from "../src/gemini/protocol";
import { GeminiClient } from "../src/gemini/client";
import { normalize } from "../src/api";
import type { Session } from "../src/types";
const model = resolveModel("gemini-spark");
const meta = ["c_spark_test", "r_spark_test"];
const status = (obj: any) => [null, meta, { 44: true, ...obj }];
const answer = () => {
  const candidate = Array(38).fill(null);
  candidate[0] = "rc_spark_test";
  candidate[1] = ["SPARK_TEST_OK"];
  candidate[37] = [["PRIVATE_REASONING", "<!DOCTYPE secret>"]];
  return [null, meta, null, null, [candidate]];
};
const wire = (frames: any[]) =>
  frames
    .map((f) =>
      JSON.stringify([["wrb.fr", "StreamGenerate", JSON.stringify(f)]]),
    )
    .join("\n");
const input = (extra = {}) =>
  normalize(
    {
      model: model.id,
      messages: [{ role: "user", content: "Reply SPARK_TEST_OK" }],
      ...extra,
    },
    "chat",
    "owner",
    model.id,
  );
function client(transport: typeof fetch) {
  return new GeminiClient(
    {
      cookie: "__Secure-1PSID=test",
      xsrf: "test",
      tokenSurface: "spark",
      bl: "test",
      fetchedAt: Math.floor(Date.now() / 1000),
    },
    async () => {},
    new AbortController().signal,
    transport,
  );
}
describe("Spark Beta protocol", () => {
  it("is a 99-slot agent request with tool 40, not a standard model alias", () => {
    const p = payload("test", model, "uuid");
    expect(p).toHaveLength(99);
    expect(p[49]).toBe(40);
    expect(p[2]).toBeNull();
    expect(p[3]).toBeNull();
    expect(p[4]).toBeNull();
    expect(p[6]).toEqual([1]);
    expect(p[30]).toEqual([4, 16]);
    expect(p[67]).toBe(0);
    expect(p[68]).toBe(2);
    expect(p[83]).toBe(1);
    expect(p[98]).toBe(1);
    const h = JSON.parse(modelHeader(model, "header-uuid"));
    expect(h[4]).toBe("56fdd199312815e2");
    expect(h[8]).toEqual([4, 5, 6, 8, 16, 4, 5, 6, 8, 16]);
    expect(h).toHaveLength(20);
    expect(h[19][0]).toEqual([]);
    expect(h[19][1][0]).toBeGreaterThan(0);
    expect(h[19][1][1] % 1000000).toBe(0);
    expect(h[11]).toBe(2);
  });
  it("continues with slot 71 rather than replaying normal slot 2 metadata", () => {
    const p = payload(
      "next",
      model,
      "uuid",
      [...meta, "rc_spark_test"],
      2,
      [],
      { conversationId: meta[0], cursor: "test-cursor" },
    );
    expect(p[2]).toBeNull();
    expect(p[83]).toBeNull();
    expect(p[71]).toEqual([
      meta[0],
      null,
      null,
      null,
      null,
      null,
      null,
      "test-cursor",
    ]);
    expect(p[17]).toEqual([[2]]);
  });
  it("leaves standard model payload/header unchanged", () => {
    const normal = resolveModel("gemini-3.8-flash"),
      p = payload("test", normal, "uuid");
    expect(p).toHaveLength(97);
    expect(p[6]).toEqual([0]);
    expect(p[68]).toBe(1);
    expect(p[71]).toBeNull();
    expect(JSON.parse(modelHeader(normal, "uuid"))[11]).toBe(1);
  });
  it("keeps only answer and encrypted-session context, never planning/tool artifacts", () => {
    const r = emptyResult();
    expect(
      absorbSpark(
        r,
        status({
          7: [
            "PRIVATE_PLAN",
            "https://lh3.googleusercontent.com/gg/PRIVATE_APP_DATA",
            "<!DOCTYPE private>",
          ],
        }),
      ),
    ).toBe(false);
    absorbSpark(r, answer());
    absorbSpark(r, status({ 26: "test-cursor" }));
    expect(absorbSpark(r, status({ 46: [meta[0], ""] }))).toBe(true);
    expect(r.metadata).toEqual([...meta, "rc_spark_test"]);
    expect(r.sparkContext).toEqual({
      conversationId: meta[0],
      cursor: "test-cursor",
    });
    expect(r.text).toBe("SPARK_TEST_OK");
    expect(r.urls).toEqual([]);
    expect(r.canvas).toBe("");
    expect(JSON.stringify(r)).not.toContain("PRIVATE");
  });
  it("does not confuse a different task completion with this task", () => {
    const r = emptyResult();
    absorbSpark(r, answer());
    expect(absorbSpark(r, status({ 46: ["c_other", ""] }))).toBe(false);
  });
  it("uses Spark referer, streams answers only and saves returned context", async () => {
    const texts: string[] = [];
    const c = client((async (url, init) => {
      expect(String(url)).toContain("StreamGenerate");
      expect(new Headers(init?.headers).get("referer")).toBe(
        "https://gemini.google.com/spark",
      );
      const form = new URLSearchParams(String(init?.body));
      const p = JSON.parse(JSON.parse(form.get("f.req")!)[1]);
      expect(p[49]).toBe(40);
      expect(p[0][0]).toContain("Do not browse");
      return new Response(
        wire([
          status({ 7: ["PRIVATE_PLAN"] }),
          answer(),
          status({ 26: "cursor" }),
          status({ 46: [meta[0], ""] }),
        ]),
      );
    }) as typeof fetch);
    const r = await c.generate(input(), undefined, async (t) => {
      texts.push(t);
    });
    expect(texts).toEqual(["SPARK_TEST_OK"]);
    expect(r.sparkContext?.cursor).toBe("cursor");
  });
  it("rejects a truncated task even when a partial answer arrived", async () => {
    const c = client(
      (async () => new Response(wire([answer()]))) as typeof fetch,
    );
    await expect(c.generate(input(), undefined)).rejects.toMatchObject({
      code: "spark_incomplete",
    });
  });
  it("reports rejection, not success, when there is no answer", async () => {
    const c = client(
      (async () =>
        new Response(wire([status({ 7: ["planning"] })]))) as typeof fetch,
    );
    await expect(c.generate(input(), undefined)).rejects.toMatchObject({
      code: "no_content",
    });
  });
  it("will not silently open a fresh task when continuation context is absent", async () => {
    let calls = 0;
    const c = client((async () => {
      calls++;
      return new Response();
    }) as typeof fetch);
    await expect(
      c.generate(input(), {
        metadata: meta,
        turn: 1,
        model: model.id,
        updatedAt: 0,
      } as Session),
    ).rejects.toMatchObject({ code: "spark_context_missing" });
    expect(calls).toBe(0);
  });
  it.each([
    { tools: [{ type: "function", function: { name: "test" } }] },
    { response_format: { type: "json_object" } },
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "input_file", file_data: "data:text/plain;base64,eA==" },
          ],
        },
      ],
    },
  ])(
    "rejects unverified capabilities before making upstream requests: %j",
    (extra) => {
      expect(() => input(extra)).toThrow("text chat/Responses only");
    },
  );
  it("accepts explicit plain text response_format", () =>
    expect(input({ response_format: { type: "text" } }).model).toBe(model.id));
  it("refreshes page tokens when switching surfaces and caches only the matching surface", async () => {
    const pages: string[] = [];
    const c = client((async (url) => {
      const path = new URL(String(url)).pathname;
      pages.push(path);
      return new Response(
        '"SNlM0e":"token_' + path.slice(1) + '","cfb2h":"build"',
      );
    }) as typeof fetch);
    await c.tokens(false, "spark");
    expect(pages).toEqual([]);
    await c.tokens(false, "app");
    expect(c.credentials.xsrf).toBe("token_app");
    await c.tokens(false, "app");
    await c.tokens(false, "spark");
    expect(c.credentials.xsrf).toBe("token_spark");
    expect(c.credentials.tokenSurface).toBe("spark");
    expect(pages).toEqual(["/app", "/spark"]);
  });
  it("does not accept a partial answer followed by an upstream rejection", async () => {
    const c = client(
      (async () =>
        new Response(
          wire([answer(), status({ 46: [meta[0], ""] })]) +
            '\n["BardErrorInfo",1061]',
        )) as typeof fetch,
    );
    await expect(c.generate(input(), undefined)).rejects.toMatchObject({
      code: "gemini_1061",
    });
  });
});
