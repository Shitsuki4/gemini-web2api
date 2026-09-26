import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseEgressSpec,
  entryToSpec,
  maskProxySpec,
  scoreEgress,
  orderEgress,
  socks5Connect,
  streamSource,
  defaultEgressPool,
  egressCooling,
  markEgressBad,
  markEgressGood,
  upstreamErrorMessage,} from "../worker.js";

test("a failed exit is cooled down so retries do not land on it again", () => {
  // 回归:某个出口被 Google 回 302 验证码页时,重试若又轮到同一个出口,
  // 重试预算会被连续吃掉,最后把原始 302 抛给调用方。
  const cfg = { _egress: { id: "colo:xx", label: "XX" } };
  assert.equal(egressCooling("colo:xx"), false);
  markEgressBad(cfg);
  assert.equal(egressCooling("colo:xx"), true, "should be cooling right after a failure");
  markEgressGood(cfg);
  assert.equal(egressCooling("colo:xx"), false, "a success must clear the cooldown");
});

test("cooldown expires and does not blacklist an exit forever", () => {
  const cfg = { _egress: { id: "colo:tmp", label: "TMP" } };
  markEgressBad(cfg, 1); // 1ms 冷却
  return new Promise((r) => setTimeout(r, 10)).then(() => {
    assert.equal(egressCooling("colo:tmp"), false, "cooldown must expire");
  });
});

test("markEgressBad tolerates a missing egress (no pool configured)", () => {
  assert.doesNotThrow(() => markEgressBad({}));
  assert.doesNotThrow(() => markEgressGood({}));
  assert.doesNotThrow(() => markEgressBad(null));
});

test("upstreamErrorMessage explains a bot-check instead of leaking a bare status", () => {
  const bot = upstreamErrorMessage(new Error("Gemini upstream HTTP 302 (bot-check / reCAPTCHA page)"));
  assert.match(bot, /302/);
  assert.match(bot, /异常流量/);
  assert.match(bot, /admin\/egress/);
  // 普通错误不被改写
  const plain = upstreamErrorMessage(new Error("socket hang up"));
  assert.match(plain, /socket hang up/);
  assert.doesNotMatch(plain, /异常流量/);
});

test("entryToSpec round-trips every kind through parseEgressSpec", () => {
  // 回归:出口池存进 D1 时 colo 的 target 只是 "weur",读回来必须能还原成
  // "colo:weur" —— 直接拿 target 去 parse 会全部解析失败、静默退回默认池。
  for (const spec of ["direct", "colo:weur", "colo:me", "socks5://bob:pw@1.2.3.4:1080", "http://h.example:3128", "relay:1.2.3.4:443"]) {
    const entry = parseEgressSpec(spec);
    assert.ok(entry, `should parse ${spec}`);
    const round = parseEgressSpec(entryToSpec(entry));
    assert.ok(round, `${spec} must survive a store/load round trip`);
    assert.equal(round.id, entry.id);
  }
  assert.equal(entryToSpec(parseEgressSpec("colo:oc")), "colo:oc");
});

test("parseEgressSpec recognises the three kinds and rejects junk", () => {
  assert.deepEqual(parseEgressSpec("direct"), { id: "direct", kind: "direct", target: "", label: "direct" });

  const colo = parseEgressSpec("colo:weur");
  assert.equal(colo.kind, "colo");
  assert.equal(colo.target, "weur");
  assert.equal(colo.id, "colo:weur");
  assert.equal(parseEgressSpec("colo:nowhere"), null, "unknown region must be rejected");
  // 机房代码有两位的(Oceania / Middle East),不能只认三四个字母
  assert.equal(parseEgressSpec("colo:oc").target, "oc");
  assert.equal(parseEgressSpec("colo:me").target, "me");

  const proxy = parseEgressSpec("socks5://bob:s3cret@1.2.3.4:1080");
  assert.equal(proxy.kind, "proxy");
  assert.equal(proxy.proxy.host, "1.2.3.4");
  assert.equal(proxy.proxy.port, 1080);
  assert.equal(proxy.proxy.user, "bob");
  assert.equal(proxy.proxy.pass, "s3cret");
  assert.match(proxy.id, /^proxy:[0-9a-f]{12}$/);
  // 同一代理必须得到同一个 id,否则统计和排序会散掉
  assert.equal(parseEgressSpec("socks5://bob:s3cret@1.2.3.4:1080").id, proxy.id);

  assert.equal(parseEgressSpec("http://user:pw@host.example:8080").kind, "proxy");
  assert.equal(parseEgressSpec(""), null);
  assert.equal(parseEgressSpec("socks5://noport"), null);
  assert.equal(parseEgressSpec("ftp://1.2.3.4:21"), null);
});

test("parseEgressSpec recognises a blind relay (edgetunnel PROXYIP style)", () => {
  for (const spec of ["relay:1.2.3.4:443", "relay://1.2.3.4:443"]) {
    const e = parseEgressSpec(spec);
    assert.equal(e.kind, "relay");
    assert.equal(e.relay.host, "1.2.3.4");
    assert.equal(e.relay.port, 443);
    assert.match(e.id, /^relay:[0-9a-f]{12}$/);
  }
  // 同一中继必须得到同一个 id
  assert.equal(parseEgressSpec("relay:1.2.3.4:443").id, parseEgressSpec("relay://1.2.3.4:443").id);
  assert.equal(parseEgressSpec("relay:noport"), null);
});

test("maskProxySpec hides the password", () => {
  assert.equal(maskProxySpec("socks5://bob:s3cret@1.2.3.4:1080"), "socks5://bob:***@1.2.3.4:1080");
  assert.equal(maskProxySpec("socks5://1.2.3.4:1080"), "socks5://1.2.3.4:1080");
});

test("scoreEgress ranks image-capable exits above merely-working ones", () => {
  const imageOk = scoreEgress({ text_status: "ok", image_status: "ok", latency_ms: 500 });
  const textOnly = scoreEgress({ text_status: "ok", image_status: "blocked", latency_ms: 500 });
  const rateLimited = scoreEgress({ text_status: "429", image_status: "blocked", latency_ms: 500 });
  const broken = scoreEgress({ text_status: "1060", image_status: "error", latency_ms: 0 });
  assert.ok(imageOk > textOnly, "image-capable must win");
  assert.ok(textOnly > rateLimited);
  assert.ok(rateLimited > broken);
  assert.equal(scoreEgress(null), 0);
  assert.ok(imageOk <= 100 && broken >= 0);
});

test("orderEgress sorts by score and honours an explicit force", () => {
  const pool = [
    parseEgressSpec("colo:weur"),
    parseEgressSpec("colo:eeur"),
    parseEgressSpec("colo:wnam"),
  ];
  const stats = new Map([
    ["colo:weur", { score: 10 }],
    ["colo:eeur", { score: 90 }],
    ["colo:wnam", { score: 50 }],
  ]);
  assert.deepEqual(orderEgress(pool, stats, "").map((e) => e.id), ["colo:eeur", "colo:wnam", "colo:weur"]);
  // 强制指定时排最前,其余保持分数序
  assert.deepEqual(
    orderEgress(pool, stats, "colo:weur").map((e) => e.id),
    ["colo:weur", "colo:eeur", "colo:wnam"]
  );
});

test("defaultEgressPool falls back to the configured region hints", () => {
  const pool = defaultEgressPool({ egress_hint: "weur", egress_fallback_hints: ["eeur", "wnam", "weur"] });
  assert.deepEqual(pool.map((e) => e.id), ["colo:weur", "colo:eeur", "colo:wnam"]);
  assert.deepEqual(defaultEgressPool({}), []);
});

// ── SOCKS5 握手 ─────────────────────────────────────────────────────────────
// 这段跑不了真代理,所以用假 socket 按字节校验握手序列 —— 这是唯一能验证
// 协议实现是否正确的方式。
function fakeSocket(chunks) {
  const sent = [];
  const queue = chunks.slice();
  return {
    sent,
    writer: { write: async (bytes) => { sent.push(new Uint8Array(bytes)); } },
    reader: {
      read: async () => {
        if (!queue.length) return { done: true, value: undefined };
        return { done: false, value: new Uint8Array(queue.shift()) };
      },
    },
  };
}
const textsOf = (sent) => sent.map((b) => [...b]);

test("socks5Connect does an unauthenticated handshake and CONNECT", async () => {
  const s = fakeSocket([
    [5, 0],                                            // 服务端选中「无需认证」
    [5, 0, 0, 1, 93, 184, 216, 34, 0x1f, 0x90],        // 成功,atyp=IPv4
  ]);
  await socks5Connect(s.writer, streamSource(s.reader), "gemini.google.com", 443, "", "");
  assert.deepEqual(textsOf(s.sent), [
    [5, 1, 0],                                         // 问候:只要「无需认证」
    [5, 1, 0, 3, 17, ...Buffer.from("gemini.google.com"), 0x01, 0xbb], // CONNECT,ATYP=域名,端口 443
  ]);
});

test("socks5Connect offers and uses username/password auth when given", async () => {
  const s = fakeSocket([
    [5, 2],                 // 服务端要求用户名/密码
    [1, 0],                 // 认证通过
    [5, 0, 0, 3, 4, ...Buffer.from("h.os"), 0x00, 0x50], // atyp=域名
  ]);
  await socks5Connect(s.writer, streamSource(s.reader), "h.os", 80, "bob", "pw");
  assert.deepEqual(textsOf(s.sent), [
    [5, 2, 0, 2],                              // 两种都提供
    [1, 3, 98, 111, 98, 2, 112, 119],          // 1, len("bob"), bob, len("pw"), pw
    [5, 1, 0, 3, 4, 104, 46, 111, 115, 0, 80], // CONNECT h.os:80
  ]);
});

test("socks5Connect surfaces refusals instead of hanging", async () => {
  const refused = fakeSocket([[5, 0], [5, 5, 0, 1, 0, 0, 0, 0, 0, 0]]); // code 5 = connection refused
  await assert.rejects(() => socks5Connect(refused.writer, streamSource(refused.reader), "x", 443, "", ""), /connect failed/);

  const badVersion = fakeSocket([[4, 0]]);
  await assert.rejects(() => socks5Connect(badVersion.writer, streamSource(badVersion.reader), "x", 443, "", ""), /bad version/);

  const noAuth = fakeSocket([[5, 3]]); // 服务端只接受我们不支持的方式
  await assert.rejects(() => socks5Connect(noAuth.writer, streamSource(noAuth.reader), "x", 443, "", ""), /auth method/);
});

test("streamSource buffers when a read returns more bytes than requested", async () => {
  // 真实 socket 常把「问候回复 + CONNECT 回复」一次性喂回来,早期实现会在这种
  // 情况下直接抛错,所以这里专门锁住缓冲行为。
  const s = fakeSocket([[5, 0, 5, 0, 0, 1, 93, 184, 216, 34, 0, 80]]);
  await socks5Connect(s.writer, streamSource(s.reader), "h.os", 80, "", "");
  assert.equal(textsOf(s.sent).length, 2);
});

test("streamSource hands back coalesced chunks intact", async () => {
  const src = streamSource(fakeSocket([[1, 2, 3, 4, 5]]).reader);
  assert.deepEqual([...(await src.need(2))], [1, 2]);
  assert.deepEqual([...(await src.need(3))], [3, 4, 5]);
});

test("streamSource rejects a stream that closes mid-handshake", async () => {
  const src = streamSource(fakeSocket([]).reader);
  await assert.rejects(() => src.need(2), /closed mid-handshake/);
});
