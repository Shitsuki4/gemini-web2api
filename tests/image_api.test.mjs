import { test } from "node:test";
import assert from "node:assert/strict";
import { officialImageGenerate, handleImagesGenerations } from "../worker.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = real; });
}

test("officialImageGenerate refuses to run without an API key", async () => {
  await assert.rejects(
    () => officialImageGenerate({ gemini_api_key: "" }, "a cat"),
    /GEMINI_API_KEY 未配置/
  );
});

test("officialImageGenerate pulls inlineData out of a candidates response", async () => {
  await withFetch(
    async (url, init) => {
      assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/);
      assert.equal(init.headers["x-goog-api-key"], "test-key");
      const body = JSON.parse(init.body);
      assert.equal(body.contents[0].parts[0].text, "a red apple");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    async () => {
      const cfg = { gemini_api_key: "test-key", gemini_image_model: "gemini-3.1-flash-image" };
      const out = await officialImageGenerate(cfg, "a red apple");
      assert.equal(out.mime, "image/png");
      assert.ok(out.bytes.byteLength > 0);
      // 字节要能还原成 PNG magic
      assert.deepEqual([...out.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
  );
});

test("officialImageGenerate surfaces a clear error when the API returns no image", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "I cannot do that." }] }, finishReason: "STOP" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      await assert.rejects(
        () => officialImageGenerate({ gemini_api_key: "k" }, "x"),
        /未返回图片/
      );
    }
  );
});

test("officialImageGenerate reports upstream HTTP failures verbatim", async () => {
  await withFetch(
    async () => new Response("API key not valid", { status: 403 }),
    async () => {
      await assert.rejects(
        () => officialImageGenerate({ gemini_api_key: "bad" }, "x"),
        /官方 API 403.*API key not valid/
      );
    }
  );
});

test("handleImagesGenerations is 503 until a key is configured", async () => {
  const res = await handleImagesGenerations({ prompt: "a cat" }, { gemini_api_key: "" }, {});
  assert.equal(res.status, 503);
});

test("handleImagesGenerations rejects an empty prompt", async () => {
  const res = await handleImagesGenerations({ prompt: "  " }, { gemini_api_key: "k" }, {});
  assert.equal(res.status, 400);
});

test("handleImagesGenerations stores the image and returns a public URL", async () => {
  const put = [];
  const env = { FILECACHE: { put: async (k, bytes, opts) => { put.push({ k, size: bytes.byteLength, type: opts.httpMetadata.contentType }); } } };
  const cfg = { gemini_api_key: "k", gemini_image_model: "m", public_origin: "https://api.example.org", image_cache_ttl_sec: 60 };
  await withFetch(
    async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      const res = await handleImagesGenerations({ prompt: "a cat" }, cfg, env);
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.equal(j.data.length, 1);
      assert.match(j.data[0].url, /^https:\/\/api\.example\.org\/img\/[0-9a-f]{24}$/);
      assert.equal(put.length, 1);
      assert.match(put[0].k, /^img\/[0-9a-f]{24}$/);
    }
  );
});