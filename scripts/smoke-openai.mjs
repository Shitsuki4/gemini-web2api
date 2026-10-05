import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Seven real generations (including two locally simulated tool-result turns).
// No retries/replay, no external tool execution. Space starts for the free-tier
// six/minute account limit; a failure stops this script immediately.
const origin = process.env.GATEWAY_URL?.replace(/\/$/, "");
const key = process.env.API_KEY;
if (!origin || !key) throw Error("Set GATEWAY_URL and API_KEY");
const target = new URL(origin);
if (
  target.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(target.hostname)
)
  throw Error("Refusing non-local HTTP");
const model = process.env.MODEL || "gemini-3.6-flash";
const clientId = randomUUID();
const marker = "OPENAI_" + randomUUID().replaceAll("-", "");
const history = [
  { role: "user", content: `Remember this exact test marker: ${marker}` },
  { role: "assistant", content: "Noted." },
  {
    role: "user",
    content: "Reply with only the exact test marker from my earlier message.",
  },
];
let lastStart = 0,
  currentTest = "init",
  requests = 0;
const report = (test, data = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), test, ...data }));
async function request(test, body, extra = {}) {
  currentTest = test;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, lastStart + 12000 - Date.now())),
  );
  lastStart = Date.now();
  requests++;
  const r = await fetch(origin + "/v1/chat/completions", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(240000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Origin: "https://openai-client.invalid",
      ...extra,
    },
    body: JSON.stringify({ model, ...body }),
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw Error(`HTTP ${r.status}: ${b.error?.code || "request_failed"}`);
  }
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  const id = r.headers.get("x-gemini-session-id");
  assert.match(id || "", /^acc_[a-f0-9]{32}\.s_[a-f0-9]{32}$/);
  assert.equal(r.headers.get("x-session-id"), id);
  assert.ok(
    r.headers
      .get("Access-Control-Expose-Headers")
      ?.includes("X-Gemini-Session-Id"),
  );
  if (process.env.EXPECTED_ACCOUNT)
    assert.ok(
      id.startsWith(process.env.EXPECTED_ACCOUNT + "."),
      "Unexpected account routing",
    );
  return r;
}
async function streamed(r) {
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const text = await r.text();
  const blocks = text.replaceAll("\r\n", "\n").split("\n\n");
  const data = [];
  let done = false;
  for (const block of blocks) {
    if (block.includes("event: error")) {
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      const error = line ? JSON.parse(line.slice(5)) : {};
      throw Error(`SSE error: ${error.error?.code || "stream_error"}`);
    }
    const value = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!value) continue;
    assert.equal(done, false, "Unexpected data after DONE");
    if (value === "[DONE]") done = true;
    else data.push(JSON.parse(value));
  }
  assert.ok(done, "Missing terminal DONE");
  assert.ok(data.length, "No stream chunks");
  return data;
}
function checkCall(call) {
  assert.match(call?.id || "", /^call_/);
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "get_weather");
  assert.equal(typeof call.function.arguments, "string");
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "Shanghai" });
  return { id: call.id, type: call.type, function: call.function };
}
try {
  const first = await request(
    "nonstream_client_id",
    { messages: history, session_id: clientId },
    { "X-Session-Id": "trace-" + clientId },
  );
  const b = await first.json();
  assert.ok(
    b.choices?.[0]?.message?.content?.includes(marker),
    "Full history marker mismatch",
  );
  assert.equal(b.choices[0].finish_reason, "stop");
  report(currentTest, {
    ok: true,
    http: first.status,
    actual_model: b.gemini?.actual_model ?? null,
  });
  const resume = await request("canonical_remote_resume", {
    gemini_session_id: first.headers.get("x-gemini-session-id"),
    session_id: clientId,
    messages: [
      {
        role: "user",
        content: "Repeat the exact test marker again, nothing else.",
      },
    ],
  });
  assert.equal(
    resume.headers.get("x-gemini-session-id"),
    first.headers.get("x-gemini-session-id"),
  );
  assert.ok(
    (await resume.json()).choices?.[0]?.message?.content?.includes(marker),
    "Remote context marker mismatch",
  );
  report(currentTest, { ok: true, http: resume.status });
  const stream = await request(
    "stream_client_id",
    { stream: true, messages: history },
    { "X-Session-Id": clientId },
  );
  const chunks = await streamed(stream);
  assert.ok(
    chunks
      .map((c) => c.choices?.[0]?.delta?.content || "")
      .join("")
      .includes(marker),
    "Stream history marker mismatch",
  );
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "stop"));
  report(currentTest, {
    ok: true,
    http: stream.status,
    chunks: chunks.length,
    done: true,
  });
  const tools = [
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
  ];
  for (const stream of [false, true]) {
    const messages = [
      { role: "user", content: "Use Shanghai as the city for our test." },
      { role: "assistant", content: "Understood." },
      {
        role: "user",
        content:
          'Call get_weather exactly once with {"city":"Shanghai"}. Do not guess weather or call any other tools.',
      },
    ];
    const r = await request(
      stream ? "tool_calls_stream" : "tool_calls_nonstream",
      {
        stream,
        session_id: clientId,
        messages,
        tools,
        tool_choice: { type: "function", function: { name: "get_weather" } },
      },
      { "X-Session-Id": "tool-trace-" + clientId },
    );
    let call;
    if (stream) {
      const chunks = await streamed(r),
        calls = new Map();
      assert.ok(
        chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"),
      );
      for (const c of chunks)
        for (const delta of c.choices?.[0]?.delta?.tool_calls || []) {
          assert.equal(typeof delta.index, "number");
          const value = calls.get(delta.index) || {
            id: "",
            type: "",
            function: { name: "", arguments: "" },
          };
          if (delta.id) value.id = delta.id;
          if (delta.type) value.type = delta.type;
          if (delta.function?.name) value.function.name += delta.function.name;
          if (delta.function?.arguments)
            value.function.arguments += delta.function.arguments;
          calls.set(delta.index, value);
        }
      assert.equal(calls.size, 1);
      call = checkCall([...calls.values()][0]);
    } else {
      const b = await r.json();
      assert.equal(b.choices?.[0]?.finish_reason, "tool_calls");
      assert.equal(b.choices[0].message.content, null);
      assert.equal(b.choices[0].message.tool_calls?.length, 1);
      call = checkCall(b.choices[0].message.tool_calls[0]);
    }
    report(currentTest, {
      ok: true,
      http: r.status,
      tool: call.function.name,
      arguments_valid: true,
      finish_reason: "tool_calls",
      ...(stream ? { done: true } : {}),
    });
    const toolMarker = "TOOL_RESULT_" + randomUUID().replaceAll("-", "");
    const followup = await request(
      stream ? "tool_result_after_stream" : "tool_result_after_nonstream",
      {
        session_id: clientId,
        tools,
        tool_choice: "none",
        messages: [
          {
            role: "system",
            content:
              "After receiving a tool result, reply only with its marker field. Do not call more tools.",
          },
          ...messages,
          { role: "assistant", content: null, tool_calls: [call] },
          {
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              city: "Shanghai",
              marker: toolMarker,
              simulated: true,
            }),
          },
        ],
      },
    );
    const output = await followup.json();
    assert.equal(output.choices?.[0]?.finish_reason, "stop");
    assert.ok(
      output.choices[0].message.content?.includes(toolMarker),
      "Tool result marker mismatch",
    );
    report(currentTest, {
      ok: true,
      http: followup.status,
      tool_result_roundtrip: true,
    });
  }
  report("openai_compatibility_complete", { ok: true, requests, retries: 0 });
} catch (e) {
  report(currentTest, { ok: false, requests, retries: 0, message: e.message });
  process.exitCode = 1;
}
