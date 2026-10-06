import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
// Three independent real generations, submitted together, never retried.
// Requires an otherwise idle, enabled account. Does not execute external tools.
const origin = process.env.GATEWAY_URL?.replace(/\/$/, ""),
  key = process.env.API_KEY,
  admin = process.env.ADMIN_KEY,
  account = process.env.EXPECTED_ACCOUNT;
if (!origin || !key || !admin || !/^acc_[a-f0-9]{32}$/.test(account || ""))
  throw Error("Set GATEWAY_URL, API_KEY, ADMIN_KEY, EXPECTED_ACCOUNT");
const target = new URL(origin);
if (
  target.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(target.hostname)
)
  throw Error("Refusing non-local HTTP");
const report = (test, data) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), test, ...data }));
async function status() {
  const r = await fetch(origin + `/admin/accounts/${account}/status`, {
    headers: { Authorization: `Bearer ${admin}` },
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!r.ok) throw Error(`Status HTTP ${r.status}`);
  return r.json();
}
async function generate(mode) {
  const marker = "QUEUE_" + randomUUID().replaceAll("-", "").slice(0, 12),
    stream = mode === "stream",
    tools = mode === "tools";
  const start = Date.now();
  const r = await fetch(origin + "/v1/chat/completions", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(400000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gemini-3.6-flash",
      session_id: randomUUID(),
      stream,
      messages: [
        {
          role: "user",
          content: tools
            ? 'Call get_weather exactly once with {"city":"Shanghai"}. Do not guess weather or call any other tools.'
            : `Reply with exactly ${marker}`,
        },
      ],
      ...(tools
        ? {
            tools: [
              {
                type: "function",
                function: {
                  name: "get_weather",
                  description: "Return current weather for the given city.",
                  parameters: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                  },
                },
              },
            ],
            tool_choice: {
              type: "function",
              function: { name: "get_weather" },
            },
          }
        : {}),
    }),
  });
  if (!r.ok) {
    const b = await r.json();
    throw Error(`${mode}: HTTP ${r.status}, ${b.error?.code}`);
  }
  assert.ok(r.headers.get("x-gemini-session-id")?.startsWith(account + "."));
  if (stream) {
    const text = await r.text();
    assert.ok(!text.includes("event: error"));
    assert.ok(text.includes("data: [DONE]"));
    const chunks = text
      .split("\n")
      .filter((x) => x.startsWith("data: {"))
      .map((x) => JSON.parse(x.slice(6)));
    assert.ok(
      chunks
        .map((x) => x.choices?.[0]?.delta?.content || "")
        .join("")
        .includes(marker),
    );
    assert.ok(chunks.some((x) => x.choices?.[0]?.finish_reason === "stop"));
  } else {
    const b = await r.json();
    if (tools) {
      assert.equal(b.choices?.[0]?.finish_reason, "tool_calls");
      const calls = b.choices[0].message.tool_calls;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, "get_weather");
      assert.deepEqual(JSON.parse(calls[0].function.arguments), {
        city: "Shanghai",
      });
    } else assert.ok(b.choices?.[0]?.message?.content?.includes(marker));
  }
  report(mode, { ok: true, http: r.status, duration_ms: Date.now() - start });
}
try {
  const before = await status();
  assert.ok(
    before.enabled && !before.busy && !before.queued,
    "Account must be idle before acceptance",
  );
  assert.ok(
    before.rate_limit?.remaining >= 3,
    "Wait for sufficient minute budget; no generation was sent",
  );
  const pending = Promise.allSettled(
    ["nonstream", "stream", "tools"].map(generate),
  );
  // Observation failures must not cause resubmission or leave responses unread.
  let observed = 0,
    observationError;
  try {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const s = await status();
      observed = Math.max(observed, s.queued || 0);
      if (observed >= 1) {
        report("queue_observed", {
          busy: s.busy,
          queued: s.queued,
          used: s.rate_limit?.used,
        });
        break;
      }
    }
  } catch (e) {
    observationError = e;
  }
  const results = await pending;
  results.forEach((result, index) => {
    if (result.status === "rejected")
      report(["nonstream", "stream", "tools"][index], {
        ok: false,
        message: result.reason?.message,
        cause: result.reason?.cause?.code,
      });
  });
  const failed = results.find((x) => x.status === "rejected");
  if (failed) throw failed.reason;
  if (observationError) throw observationError;
  assert.ok(
    observed >= 1,
    "Generations passed but queue contention was not observed",
  );
  const final = await status();
  assert.equal(final.imported_at, before.imported_at);
  assert.equal(final.queued, 0);
  assert.equal(final.busy, false);
  report("concurrency_complete", {
    ok: true,
    generations: 3,
    retries: 0,
    observed_queued: observed,
    import_unchanged: true,
    maintenance: final.maintenance?.status,
  });
} catch (e) {
  report("concurrency_failed", {
    ok: false,
    message: e.message,
    cause: e.cause?.code,
  });
  process.exitCode = 1;
}
