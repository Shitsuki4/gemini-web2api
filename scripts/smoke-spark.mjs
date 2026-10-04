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
  throw Error("Refusing to send API key over non-local HTTP");
const model = "gemini-spark";
const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
const report = (test, detail = {}) =>
  console.log(JSON.stringify({ test, ...detail }));
async function request(path, body, extra = {}) {
  // Each request gets its own deadline, including its response stream.
  const response = await fetch(origin + path, {
    redirect: "error",
    signal: AbortSignal.timeout(240000),
    headers: { ...headers, ...extra },
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
async function* events(response) {
  assert.match(
    response.headers.get("content-type") || "",
    /text\/event-stream/,
  );
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = block
          .split("\n")
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data)
          yield { name, data: data === "[DONE]" ? data : JSON.parse(data) };
      }
      if (done) {
        assert.equal(buffer.trim(), "", "Truncated SSE event");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
try {
  const models = await (await request("/v1/models")).json();
  assert.ok(models.data?.some((m) => m.id === model));
  report("models", { ok: true, model });
  const nonce = "memory_" + randomUUID().replaceAll("-", "");
  const first = await request("/v1/chat/completions", {
    model,
    messages: [
      {
        role: "user",
        content: `Remember this exact private test marker for my next question: ${nonce}. For now reply with exactly SPARK_CF_OK.`,
      },
    ],
  });
  const answer = await first.json(),
    session = first.headers.get("x-session-id");
  assert.ok(!JSON.stringify(answer).includes("sparkContext"));
  assert.equal(answer.choices?.[0]?.message?.content?.trim(), "SPARK_CF_OK");
  assert.match(session || "", /^acc_[a-f0-9]{32}\.s_[a-f0-9]{32}$/);
  report("nonstream", {
    ok: true,
    actual_model: answer.gemini?.actual_model ?? null,
  });
  // Only the question and session id are sent: the nonce is NOT replayed to Gemini.
  const second = await (
    await request(
      "/v1/chat/completions",
      {
        model,
        messages: [
          {
            role: "user",
            content:
              "What exact private test marker did I ask you to remember? Reply with only that marker.",
          },
        ],
      },
      { "X-Session-Id": session },
    )
  ).json();
  assert.equal(second.choices?.[0]?.message?.content?.trim(), nonce);
  report("remote_context", { ok: true });
  const began = Date.now();
  const stream = await request("/v1/chat/completions", {
    model,
    stream: true,
    messages: [
      {
        role: "user",
        content:
          "Output SPARK_SSE_OK on the first line, then count from 1 to 80 with one number per line, then SPARK_SSE_DONE on the final line. No other text.",
      },
    ],
  });
  let text = "",
    chunks = 0,
    stopped = false,
    done = false,
    firstDeltaMs = 0;
  for await (const event of events(stream)) {
    assert.notEqual(event.name, "error", "SSE error event");
    if (event.data === "[DONE]") {
      done = true;
      continue;
    }
    assert.ok(!event.data.error, "SSE error payload");
    const choice = event.data.choices?.[0];
    if (choice?.delta?.content) {
      if (!chunks) firstDeltaMs = Date.now() - began;
      chunks++;
      text += choice.delta.content;
    }
    if (choice?.finish_reason === "stop") stopped = true;
  }
  assert.ok(stopped && done, "Missing stream completion");
  assert.ok(text.includes("SPARK_SSE_OK") && text.includes("SPARK_SSE_DONE"));
  // Spark may return one final answer frame after progress-only events. Never
  // split it artificially or mistake successful SSE framing for token streaming.
  assert.ok(chunks >= 1, "No user-visible answer event");
  report("sse", {
    ok: true,
    text_deltas: chunks,
    multi_delta_streaming_observed: chunks > 1,
    chars: text.length,
    first_delta_ms: firstDeltaMs,
    total_ms: Date.now() - began,
  });
  const responses = await (
    await request("/v1/responses", {
      model,
      input: "Reply with exactly SPARK_RESPONSES_OK.",
    })
  ).json();
  const output = (responses.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
  assert.equal(output.trim(), "SPARK_RESPONSES_OK");
  report("responses", { ok: true });
  report("complete", { ok: true, real_generation_requests: 4 });
} catch (error) {
  // Do not print request headers, cookies or raw server responses.
  report("failed", {
    ok: false,
    reason: error.code === "ERR_ASSERTION" ? error.operator : error.message,
  });
  process.exitCode = 1;
}
