import assert from "node:assert/strict";
const origin = process.env.GATEWAY_URL?.replace(/\/$/, "");
const key = process.env.API_KEY;
if (!origin || !key) throw Error("Set GATEWAY_URL and API_KEY");
const target = new URL(origin);
if (
  target.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(target.hostname)
)
  throw Error("Use HTTPS for non-local gateways");
const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
const start = Date.now();
try {
  const r = await fetch(new URL("/v1/chat/completions", origin), {
    method: "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(240000),
    body: JSON.stringify({
      model: "gemini-image",
      stream: true,
      messages: [
        { role: "user", content: process.env.IMAGE_PROMPT || "画一只可爱小猫" },
      ],
    }),
  });
  if (!r.ok) {
    const b = await r.json();
    throw Error(`HTTP ${r.status}: ${b.error?.code}`);
  }
  // Media is buffered by the gateway; consume the actual SSE lifecycle, not JSON.
  const text = await r.text();
  const frames = text
    .split("\n")
    .filter((x) => x.startsWith("data: "))
    .map((x) => x.slice(6));
  const objects = frames
    .filter((x) => x !== "[DONE]")
    .map((x) => JSON.parse(x));
  const failure = objects.find((x) => x.error);
  if (failure) throw Error(failure.error.code);
  assert.ok(frames.includes("[DONE]"), "SSE did not finish");
  const artifact = objects.find((x) => x.gemini?.artifacts?.length)?.gemini
    .artifacts[0];
  assert.match(artifact?.id || "", /^acc_[a-f0-9]{32}\.file_[a-f0-9]{32}$/);
  const path = `/v1/files/${artifact.id}/content`;
  const file = await fetch(new URL(path, origin), {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(65000),
  });
  assert.equal(file.status, 200);
  const mime = file.headers.get("content-type");
  assert.match(mime || "", /^image\/(png|jpeg|webp|gif)/);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.ok(bytes.length > 100);
  assert.ok(
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP") ||
      bytes.toString("ascii", 0, 3) === "GIF",
    "Missing image signature",
  );
  console.log(
    JSON.stringify({
      test: "chat_image_sse_download",
      ok: true,
      mime,
      bytes: bytes.length,
      elapsedMs: Date.now() - start,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      test: "chat_image_sse_download",
      ok: false,
      reason: error.code === "ERR_ASSERTION" ? error.message : error.message,
    }),
  );
  process.exitCode = 1;
}
