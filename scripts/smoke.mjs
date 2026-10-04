const origin = process.env.GATEWAY_URL?.replace(/\/$/, "");
const key = process.env.API_KEY;
if (!origin || !key) throw Error("Set GATEWAY_URL and API_KEY");
const target = new URL(origin);
if (
  target.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(target.hostname)
)
  throw Error("Refusing to send API key over non-local HTTP");
const options = { redirect: "error", signal: AbortSignal.timeout(240000) };
const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
let r = await fetch(origin + "/v1/models", { headers, ...options });
const models = await r.json();
if (!r.ok || !models.data?.length) throw Error("Models check failed");
console.log("models: ok");
r = await fetch(origin + "/v1/chat/completions", {
  ...options,
  method: "POST",
  headers,
  body: JSON.stringify({
    model: process.env.MODEL || "gemini-3.6-flash",
    messages: [{ role: "user", content: "Reply with exactly CF_NATIVE_OK." }],
  }),
});
const result = await r.json();
console.log(
  JSON.stringify({
    status: r.status,
    answer: result.choices?.[0]?.message?.content,
    actual_model: result.gemini?.actual_model,
    error: result.error,
    session: r.headers.get("x-session-id"),
  }),
);
if (!r.ok || !result.choices?.[0]?.message?.content) process.exitCode = 1;
