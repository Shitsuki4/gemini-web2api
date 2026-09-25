import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectImageMime,
  normalizeMimeType,
  decodeDataUrl,
  imageFromPart,
  messagesToPrompt,
  googleContentsToPrompt,
  validateImageUrl,
  isPrivateIpv4,
  isPrivateHostname,
  parseToolCalls,
  cleanText,
  getConfig,
} from "../worker.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const bytesOf = (...b) => new Uint8Array(b);

test("detectImageMime sniffs magic bytes, not declared type", () => {
  assert.equal(detectImageMime(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(detectImageMime(bytesOf(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(detectImageMime(bytesOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), "image/gif");
  assert.equal(detectImageMime(bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), "image/webp");
  assert.equal(detectImageMime(bytesOf(0x42, 0x4d)), "image/bmp");
  // unknown bytes fall back to the caller-supplied default
  assert.equal(detectImageMime(bytesOf(1, 2, 3, 4), "image/png"), "image/png");
});

test("decodeDataUrl handles base64 and percent-encoded payloads", () => {
  const b64 = decodeDataUrl(`data:image/png;base64,${PNG}`);
  assert.equal(b64.mime, "image/png");
  assert.equal(b64.b64, PNG);

  const plain = decodeDataUrl("data:image/png,%89PNG%0D%0A");
  assert.equal(plain.mime, "image/png");
  assert.ok(plain.b64.length > 0);

  assert.equal(decodeDataUrl("not-a-data-url"), null);
});

test("imageFromPart accepts OpenAI, Responses and Anthropic shapes", () => {
  const viaChat = imageFromPart({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
  assert.equal(viaChat.mime, "image/png");
  assert.equal(viaChat.b64, PNG);

  const viaResponses = imageFromPart({ type: "input_image", image_url: "https://example.com/a.png" });
  assert.equal(viaResponses.url, "https://example.com/a.png");

  const viaAnthropic = imageFromPart({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  assert.equal(viaAnthropic.mime, "image/jpeg");
  assert.equal(viaAnthropic.b64, "AAAA");

  assert.equal(imageFromPart({ type: "text", text: "hi" }), null);
});

test("messagesToPrompt keeps every image part and marks the prompt", () => {
  const [prompt, images] = messagesToPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: "input_image", image_url: "https://example.com/b.png" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      ],
    },
  ]);
  assert.equal(images.length, 3);
  assert.equal((prompt.match(/\[Image attached\]/g) || []).length, 3);
});

test("googleContentsToPrompt converts inlineData to an uploadable image", () => {
  const [prompt, images] = googleContentsToPrompt({
    contents: [{ role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: PNG } }] }],
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].mime, "image/png");
  assert.match(prompt, /\[Image attached\]/);
});

test("googleContentsToPrompt carries fileData.fileUri through", () => {
  const [prompt, images] = googleContentsToPrompt({
    contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://example.com/c.png", mimeType: "image/png" } }] }],
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].url, "https://example.com/c.png");
  assert.match(prompt, /\[Image attached\]/);
});

test("validateImageUrl blocks private and metadata targets", () => {
  const blocked = [
    "http://127.0.0.1/x",
    "http://10.0.0.1/x",
    "http://172.16.5.4/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/x",
    "http://[::1]/x",
    "http://0x7f000001/x",
    "file:///etc/passwd",
    "ftp://example.com/a.png",
    "https://user:pass@example.com/a.png",
  ];
  for (const url of blocked) {
    assert.throws(() => validateImageUrl(url), undefined, `expected ${url} to be rejected`);
  }
  assert.ok(validateImageUrl("https://example.com/a.png") instanceof URL);
});

test("isPrivateIpv4 / isPrivateHostname cover the usual SSRF ranges", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "224.0.0.1"]) {
    assert.equal(isPrivateIpv4(ip), true, `${ip} should be private`);
  }
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateHostname("localhost"), true);
  assert.equal(isPrivateHostname("metadata.google.internal"), true);
  assert.equal(isPrivateHostname("foo.internal"), true);
  assert.equal(isPrivateHostname("example.com"), false);
});

test("parseToolCalls extracts function calls and strips them from the text", () => {
  const [text, calls] = parseToolCalls('before\n```tool_call\n{"name":"get_weather","arguments":{"city":"Tokyo"}}\n```\nafter');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Tokyo" });
  assert.match(text, /before/);
  assert.match(text, /after/);
  assert.doesNotMatch(text, /tool_call/);
});

test("cleanText trims assistant scaffolding", () => {
  assert.equal(cleanText("  hello  "), "hello");
});

test("decodeDataUrl preserves raw binary bytes in percent-encoded payloads", () => {
  // Regression: decodeURIComponent() throws on %89 (invalid UTF-8), which used to
  // make non-base64 data URLs silently return null and drop the image.
  const out = decodeDataUrl("data:image/png,%89PNG%0D%0A%1A%0A");
  assert.equal(out.mime, "image/png");
  const bytes = new Uint8Array(Buffer.from(out.b64, "base64"));
  assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectImageMime(bytes), "image/png");
});

test("normalizeMimeType maps image/jpg to image/jpeg", () => {
  assert.equal(normalizeMimeType("image/jpg"), "image/jpeg");
  assert.equal(normalizeMimeType("IMAGE/JPEG; charset=x"), "image/jpeg");
  assert.equal(normalizeMimeType("", "image/png"), "image/png");
});

test("getConfig keeps a single cookie containing | intact", () => {
  // 回归:Google 的 LSID 里带 `|`(LSID=s.GB|s.youtube:…)。按 `|` 切会把 cookie
  // 从中间截断(实测只剩 183 字符),表现为「鉴权莫名其妙失效」。
  // 只有 GEMINI_COOKIES(多账号池)才该按 `|` 分隔。
  const one = "SID=abc; LSID=s.GB|s.youtube:g.a000CwnTTRUIzry; HSID=xyz";
  const cfg1 = getConfig({ GEMINI_COOKIE: one });
  assert.equal(cfg1.cookie, one, "single cookie must survive verbatim");
  assert.equal(cfg1.cookie_pool.length, 1);

  const viaCookieString = getConfig({ COOKIE_STRING: one });
  assert.equal(viaCookieString.cookie, one);

  // 多账号池仍然按 `|` 切
  const cfg2 = getConfig({ GEMINI_COOKIES: "SID=a1; HSID=h1|SID=a2; HSID=h2" });
  assert.equal(cfg2.cookie_pool.length, 2);
});
