const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cdp = arg("--cdp") || process.env.CDP_URL || "http://127.0.0.1:9222";
const origin = arg("--origin") || process.env.GATEWAY_URL;
const key = process.env.ADMIN_KEY;
if (!origin || !key)
  throw new Error(
    "Set ADMIN_KEY and pass --origin https://your-worker.workers.dev [--cdp http://127.0.0.1:PORT] [--account acc_ID]",
  );
const target = new URL(origin);
if (
  target.protocol !== "https:" &&
  target.hostname !== "127.0.0.1" &&
  target.hostname !== "localhost"
)
  throw Error("Refusing to send a cookie over non-local HTTP");
const tabs = await fetch(cdp + "/json/list").then((r) => r.json());
const tab = tabs.find(
  (t) => t.type === "page" && new URL(t.url).hostname === "gemini.google.com",
);
if (!tab) throw Error("Open a signed-in Gemini tab in Roxy first");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let next = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.id) {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p?.reject(Error("CDP request failed"));
    else p?.resolve(data.result);
  }
};
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const cookies = await call("Network.getCookies", {
    urls: ["https://gemini.google.com/app", "https://accounts.google.com/"],
  });
  const page = await call("Runtime.evaluate", {
    expression:
      "JSON.stringify({userAgent:navigator.userAgent,xsrf:window.WIZ_global_data?.SNlM0e,bl:window.WIZ_global_data?.cfb2h,pushId:window.WIZ_global_data?.qKIAYe,pctx:window.WIZ_global_data?.Ylro7b})",
    returnByValue: true,
  });
  const tokens = JSON.parse(page.result.value);
  if (!tokens.xsrf) throw Error("Gemini page is not signed in");
  const selected = cookies.cookies.filter((c) =>
    [
      ".google.com",
      "google.com",
      "gemini.google.com",
      ".gemini.google.com",
    ].includes(c.domain),
  );
  const jar = new Map(selected.map((c) => [c.name, c.value]));
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const account = arg("--account");
  const r = await fetch(
    origin.replace(/\/$/, "") +
      "/admin/accounts" +
      (account ? "/" + account : ""),
    {
      method: account ? "PUT" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        label: arg("--label") || "Roxy Gemini",
        cookie,
        ...tokens,
      }),
    },
  );
  const result = await r.json();
  if (!r.ok) throw Error(result.error?.message || "Import failed");
  console.log(
    JSON.stringify({
      ok: true,
      account_id: account || result.id,
      cookie_count: jar.size,
      page_build: tokens.bl,
    }),
  );
} finally {
  ws.close();
}
