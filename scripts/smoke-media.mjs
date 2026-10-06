import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
async function request(path, body) {
  const response = await fetch(new URL(path, origin), {
    redirect: "error",
    signal: AbortSignal.timeout(240000),
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(
      `HTTP ${response.status}: ${error.error?.code || "request_failed"}`,
    );
  }
  return response;
}
try {
  const marker = "FILE_CF_" + randomUUID().replaceAll("-", "");
  const answer = await (
    await request("/v1/chat/completions", {
      model: process.env.MODEL || "gemini-3.6-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Read the attached file. Reply with only the exact marker inside it.",
            },
            {
              type: "input_file",
              filename: "cloudflare-smoke.txt",
              file_data:
                "data:text/plain;base64," +
                Buffer.from(marker).toString("base64"),
            },
          ],
        },
      ],
    })
  ).json();
  // Gemini may append a citation; the unpredictable marker must still be read from the upload.
  assert.ok(answer.choices?.[0]?.message?.content?.includes(marker));
  console.log(JSON.stringify({ test: "file_read", ok: true }));
  const image = await (
    await request("/v1/images/generations", {
      model: "gemini-image",
      prompt:
        "Generate one simple image: a solid red circle centered on a plain white background. No text.",
      n: 1,
    })
  ).json();
  assert.ok(image.data?.[0]?.url, "Missing generated artifact");
  const url = new URL(image.data[0].url, origin);
  // Never send the gateway key to an upstream URL or follow arbitrary redirects.
  assert.equal(url.origin, target.origin);
  assert.match(
    url.pathname,
    /^\/v1\/files\/acc_[a-f0-9]{32}\.file_[a-f0-9]{32}\/content$/,
  );
  const download = await request(url.href);
  assert.match(download.headers.get("content-type") || "", /^image\//);
  const bytes = new Uint8Array(await download.arrayBuffer());
  assert.ok(bytes.length > 100);
  const signature = Buffer.from(bytes.subarray(0, 12));
  assert.ok(
    signature.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      signature
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (signature.toString("ascii", 0, 4) === "RIFF" &&
        signature.toString("ascii", 8, 12) === "WEBP"),
    "Missing image file signature",
  );
  console.log(
    JSON.stringify({
      test: "image_download",
      ok: true,
      mime: download.headers.get("content-type"),
      bytes: bytes.length,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      test: "failed",
      ok: false,
      reason: error.code === "ERR_ASSERTION" ? error.operator : error.message,
    }),
  );
  process.exitCode = 1;
}
