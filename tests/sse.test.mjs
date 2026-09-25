import { test } from "node:test";
import assert from "node:assert/strict";
import { sseResponse } from "../worker.js";

async function drain(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

test("sseResponse emits a heartbeat while the producer is quiet", async () => {
  // 回归:长回答静默期会让客户端(Android OkHttp 默认读超时 10s)判定连接已死。
  // 心跳是 `:` 开头的注释行,按 SSE 规范会被客户端忽略。
  const res = sseResponse(async (write) => {
    write("data: 1\n\n");
    await new Promise((r) => setTimeout(r, 120));
    write("data: 2\n\n");
  }, null, 40);
  const text = await drain(res);
  assert.match(text, /data: 1/);
  assert.match(text, /data: 2/);
  assert.match(text, /^: ping$/m, "should have emitted a heartbeat comment");
  assert.match(res.headers.get("Content-Type"), /text\/event-stream/);
});

test("sseResponse sends no heartbeat when the interval is 0 or absent", async () => {
  const a = await drain(sseResponse(async (write) => { write("data: x\n\n"); }, null, 0));
  assert.doesNotMatch(a, /: ping/);
  const b = await drain(sseResponse(async (write) => { write("data: x\n\n"); }));
  assert.doesNotMatch(b, /: ping/);
});

test("sseResponse still terminates cleanly when the producer throws", async () => {
  const res = sseResponse(async (write) => {
    write("data: partial\n\n");
    throw new Error("upstream blew up");
  }, null, 40);
  const text = await drain(res);
  assert.match(text, /upstream blew up/, "error must reach the client");
  assert.match(text, /data: \[DONE\]/, "stream must still be terminated");
});