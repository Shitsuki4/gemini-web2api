import { test } from "node:test";
import assert from "node:assert/strict";

import {
  syncHash,
  extractPartsFromLine,
  extractSessionMeta,
  sessionKey,
  planTurn,
  messageHash,
  renderSlice,
  renderMessageParts,
  imageProxyUrl,
  imgKeyOf,
  handleImageProxy,
} from "../worker.js";

// 真实抓包(见 Codex/imgraw2.txt 的第 1 行):只有会话 id、没有内容体。
const META_ONLY_LINE =
  '[["wrb.fr",null,"[null,[\\"c_f226b04996499b57\\",\\"r_46d3b6cb9a652fab\\"],' +
  '{\\"18\\":\\"r_46d3b6cb9a652fab\\",\\"21\\":[\\"TvJw7KOEfu43S6US1pmSubnpIMrSLZ6U4g7354UlYCc\\"],\\"44\\":true}]"]]';

function syntheticLine(cid, rid, rcid, text) {
  const inner = [null, [cid, rid], null, null, [[rcid, [text], null]]];
  return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

test("syncHash is deterministic and distinguishes inputs", () => {
  assert.equal(syncHash("abc"), syncHash("abc"));
  assert.notEqual(syncHash("abc"), syncHash("abd"));
  assert.match(syncHash("abc"), /^[0-9a-f]{32}$/);
});

test("extractPartsFromLine reads [cid, rid, rcid] out of a metadata-only line", () => {
  // 这一行没有 inner[4],以前会被整个丢掉 —— 会话 id 就永远拿不到。
  const parsed = extractPartsFromLine(META_ONLY_LINE);
  assert.deepEqual(parsed.meta, ["c_f226b04996499b57", "r_46d3b6cb9a652fab", ""]);
  assert.equal(parsed.texts.length, 0);
});

test("extractPartsFromLine reads rcid alongside the text parts", () => {
  const parsed = extractPartsFromLine(syntheticLine("c_aaa", "r_bbb", "rc_ccc", "hello"));
  assert.deepEqual(parsed.texts, ["hello"]);
  assert.deepEqual(parsed.meta, ["c_aaa", "r_bbb", "rc_ccc"]);
});

test("extractSessionMeta rejects non-conversation ids", () => {
  assert.equal(extractSessionMeta([null, ["x_bad", "r_bbb"], null]), null);
  assert.equal(extractSessionMeta([null, ["c_aaa", "nope"], null]), null);
});

test("sessionKey falls back to an implicit key derived from API key + first user message", () => {
  const req = { headers: new Headers() };
  const msgs = [{ role: "user", content: "第一个问题" }];
  const a = sessionKey({}, req, { messages: msgs }, msgs);
  assert.equal(a.source, "implicit");
  assert.equal(a.explicit, false);
  // 同一条首问 + 同一个 key => 稳定命中同一会话
  const b = sessionKey({}, req, { messages: msgs }, msgs);
  assert.equal(a.raw, b.raw);
  // 换一条首问就是另一个会话
  const c = sessionKey({}, req, { messages: [{ role: "user", content: "另一个问题" }] }, [{ role: "user", content: "另一个问题" }]);
  assert.notEqual(a.raw, c.raw);
});

test("sessionKey prefers an explicit session id", () => {
  const req = { headers: new Headers({ "x-session-id": "s-123" }) };
  const k = sessionKey({}, req, {}, []);
  assert.equal(k.explicit, true);
  assert.equal(k.source, "header");
});

test("renderSlice renders only the messages from the given index", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
  ];
  assert.equal(renderSlice(messages, 3), "u2");
  assert.equal(renderSlice(messages, 0), "[System instruction]: sys\n\nu1\n\n[Assistant]: a1\n\nu2");
});

test("sessionKey recognises a Gemini conversation id and addresses it directly", () => {
  const req = { headers: new Headers({ "x-session-id": "c_a0a619b3daaa3bf8" }) };
  const k = sessionKey({}, req, {}, []);
  assert.equal(k.explicit, true);
  assert.equal(k.cid, "c_a0a619b3daaa3bf8");
  assert.equal(k.raw, "cid:c_a0a619b3daaa3bf8");
  // body 里的 session_id 同样支持
  const viaBody = sessionKey({}, { headers: new Headers() }, { session_id: "c_0123456789abcdef" }, []);
  assert.equal(viaBody.cid, "c_0123456789abcdef");
  // 普通自定义 id 不能被误判成 cid
  const plain = sessionKey({}, { headers: new Headers({ "x-session-id": "my-chat-1" }) }, {}, []);
  assert.equal(plain.cid, undefined);
});

test("planTurn keeps a cid-addressed session even when local history diverged", () => {
  // 客户端截断旧消息、或每轮都换 system prompt(时间戳之类)会让前缀对不上。
  // 以前这种情况会退回「重发全量」,长对话发几轮就爆 —— 点名了 cid 就不该这样。
  const cfg = { session_ttl_sec: 604800 };
  const sess = sessionWith([{ role: "user", content: "u1" }]);
  const messages = [
    { role: "system", content: "当前时间 12:00:03" },
    { role: "user", content: "被截断过的历史" },
    { role: "user", content: "新问题" },
  ];
  assert.equal(planTurn(cfg, sess, messages, "1", false, false).mode, "new");
  const plan = planTurn(cfg, sess, messages, "1", false, true);
  assert.equal(plan.mode, "continue");
  assert.equal(plan.reason, "trusted-last-user");
  assert.equal(renderSlice(messages, plan.startIndex), "新问题");
});

test("planTurn trusts a cid session when the client sends only the new message", () => {
  const cfg = { session_ttl_sec: 604800 };
  const sess = sessionWith([{ role: "user", content: "u1" }, { role: "assistant", content: "a1" }]);
  const plan = planTurn(cfg, sess, [{ role: "user", content: "只发这一条" }], "1", false, true);
  assert.equal(plan.mode, "continue");
  assert.equal(plan.startIndex, 0);
});

test("planTurn still refuses to invent a session when there is none", () => {
  const cfg = { session_ttl_sec: 604800 };
  const plan = planTurn(cfg, null, [{ role: "user", content: "hi" }], "1", false, true);
  assert.equal(plan.mode, "new");
  assert.equal(plan.reason, "no-session");
});

function sessionWith(messages, over = {}) {
  return {
    cid: "c_1",
    rid: "r_1",
    rcid: "rc_1",
    model: "1",
    nmsgs: messages.length,
    phash: messageHash(messages, messages.length),
    delta_mode: 0,
    updated_ts: Date.now(),
    ...over,
  };
}

test("planTurn continues and skips the echoed assistant reply", () => {
  const cfg = { session_ttl_sec: 604800 };
  const u1 = { role: "user", content: "u1" };
  const a1 = { role: "assistant", content: "a1" };
  const u2 = { role: "user", content: "u2" };
  const sess = sessionWith([u1]);
  const plan = planTurn(cfg, sess, [u1, a1, u2], "1", false);
  assert.equal(plan.mode, "continue");
  assert.equal(plan.reason, "prefix-match");
  // 只把新增的那条发上去,回显的 a1 不重发
  assert.equal(renderSlice([u1, a1, u2], plan.startIndex), "u2");
});

test("planTurn sends tool results that follow the assistant reply", () => {
  const cfg = { session_ttl_sec: 604800 };
  const u1 = { role: "user", content: "u1" };
  const a1 = { role: "assistant", content: "", tool_calls: [{ function: { name: "f", arguments: "{}" } }] };
  const t1 = { role: "tool", name: "f", content: "42" };
  const plan = planTurn(cfg, sessionWith([u1, a1]), [u1, a1, t1], "1", false);
  assert.equal(plan.mode, "continue");
  assert.equal(renderSlice([u1, a1, t1], plan.startIndex), "[Tool result for f]: 42");
});

test("planTurn starts a new session when history diverges, the model changes, or it expired", () => {
  const cfg = { session_ttl_sec: 604800 };
  const u1 = { role: "user", content: "u1" };
  const u2 = { role: "user", content: "u2" };
  const a1 = { role: "assistant", content: "a1" };

  // 客户端改了历史:指纹对不上 => 不能续聊(否则会串话)
  assert.equal(planTurn(cfg, sessionWith([u1]), [{ role: "user", content: "被改过的" }, a1, u2], "1", false).mode, "new");
  // 换模型 => 新会话
  assert.equal(planTurn(cfg, sessionWith([u1]), [u1, a1, u2], "2", false).reason, "model-changed");
  // 过期 => 新会话
  const old = sessionWith([u1], { updated_ts: Date.now() - 8 * 24 * 3600 * 1000 });
  assert.equal(planTurn(cfg, old, [u1, a1, u2], "1", false).reason, "expired");
  // 没有会话 => 新会话
  assert.equal(planTurn(cfg, null, [u1], "1", false).reason, "no-session");
});

test("planTurn treats a declared delta request as the whole payload", () => {
  // 客户端声明「只发增量」时 messages 里没有历史,前缀校验必然对不上,
  // 所以必须先判断 delta,否则每次都会误判成「历史分叉」而开新会话。
  const cfg = { session_ttl_sec: 604800 };
  const u1 = { role: "user", content: "u1" };
  const u2 = { role: "user", content: "u2" };
  const plan = planTurn(cfg, sessionWith([u1]), [u2], "1", true);
  assert.equal(plan.mode, "continue");
  assert.equal(plan.reason, "delta-mode");
  assert.equal(plan.startIndex, 0);
});

test("imageProxyUrl rewrites only whitelisted upstream hosts", () => {
  const cfg = { image_proxy: true, public_origin: "https://api.example.org", _env: { DB: {} } };
  const good = "https://lh3.googleusercontent.com/gg/abc123";
  assert.match(imageProxyUrl(cfg, good), /^https:\/\/api\.example\.org\/img\/[0-9a-f]{24}$/);
  // 不能变成任意 URL 代理
  assert.equal(imageProxyUrl(cfg, "https://evil.example.com/a.png"), "https://evil.example.com/a.png");
  assert.equal(imageProxyUrl(cfg, "http://169.254.169.254/latest/meta-data/"), "http://169.254.169.254/latest/meta-data/");
  // 没配对外域名就保持直链,免得给出一个打不开的地址
  assert.equal(imageProxyUrl({ ...cfg, public_origin: "" }, good), good);
  assert.equal(imageProxyUrl({ ...cfg, image_proxy: false }, good), good);
});

test("handleImageProxy rejects a malformed key and an unknown image", async () => {
  const cfg = { image_cache_ttl_sec: 604800 };
  const env = { DB: dbStub() };
  const bad = await handleImageProxy("NOT-A-KEY", new Request("https://x/img/NOT-A-KEY"), cfg, env);
  assert.equal(bad.status, 400);
  const missing = await handleImageProxy("a".repeat(24), new Request("https://x/img/" + "a".repeat(24)), cfg, env);
  assert.equal(missing.status, 404);
});

test("handleImageProxy fetches, serves and stores the image in R2", async () => {
  const url = "https://lh3.googleusercontent.com/gg/generated-image";
  const cfg = { image_proxy: true, public_origin: "https://api.example.org", image_cache_ttl_sec: 604800,
                image_r2_store: true, image_r2_monthly_max_bytes: 4294967296, image_object_max_bytes: 12582912,
                _env: {} };
  const key = imgKeyOf(cfg, url);
  const put = [];
  const env = {
    DB: dbStub(),
    FILECACHE: {
      get: async () => null,
      put: async (k, bytes, opts) => { put.push({ k, size: bytes.byteLength, mime: opts.httpMetadata.contentType }); },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
  try {
    const req = new Request(`https://x/img/${key}?s=${Buffer.from(url).toString("base64url")}`);
    const res = await handleImageProxy(key, req, cfg, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/png");
    assert.equal((await res.arrayBuffer()).byteLength, 4);
    assert.equal(put.length, 1, "image should be cached to R2");
    assert.equal(put[0].k, "img/" + key);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function dbStub() {
  const stmt = () => ({
    bind: () => ({ first: async () => null, run: async () => ({ meta: { changes: 0 } }) }),
    first: async () => null,
    run: async () => ({ meta: { changes: 0 } }),
  });
  return { prepare: () => stmt() };
}
