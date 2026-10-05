// Read-only, bounded observation of Cloudflare alarms. This is not a cookie relay.
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const origin = new URL(process.env.GATEWAY_URL || "https://invalid.local");
const account = arg("--account");
const minutes = Number(arg("--minutes") || 35);
const verify = process.argv.includes("--verify-chat");
if (
  !process.env.GATEWAY_URL ||
  !process.env.ADMIN_KEY ||
  !/^acc_[a-zA-Z0-9]+$/.test(account || "") ||
  !Number.isFinite(minutes) ||
  minutes < 1 ||
  minutes > 120 ||
  (verify && !process.env.API_KEY)
)
  throw Error(
    "Set GATEWAY_URL, ADMIN_KEY and --account acc_ID [--minutes 35] [--verify-chat with API_KEY]",
  );
if (
  origin.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(origin.hostname)
)
  throw Error("Refusing non-local HTTP");
const start = Date.now(),
  tickets = new Set();
let imported,
  lastAttempt = -1,
  last;
const emit = (data) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
let statusReadRetries = 0;
async function readStatus() {
  // Only the read-only status GET may retry a local connection failure. Never
  // retry a failed generation, an HTTP error, refresh or cookie import here.
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(new URL(`/admin/accounts/${account}/status`, origin), {
        headers: { Authorization: `Bearer ${process.env.ADMIN_KEY}` },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      if (attempt === 3)
        throw Error("Status connection failed after three bounded attempts");
      statusReadRetries++;
      emit({ test: "status_read_retry", attempt, code: "connection_failed" });
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}
async function status() {
  const r = await readStatus();
  if (!r.ok) throw Error(`Status HTTP ${r.status}`);
  const s = await r.json();
  if (!s.enabled || !s.configured)
    throw Error("Account must remain enabled and configured");
  if (imported === undefined) imported = s.imported_at;
  if (imported !== s.imported_at)
    throw Error(
      "Cookie was reimported during observation; not unattended maintenance",
    );
  const m = s.maintenance;
  if (m && m.status !== "running" && m.lastAttemptAt !== lastAttempt) {
    lastAttempt = m.lastAttemptAt;
    // Do not count a ticket already renewed before this observation began.
    if (m.ticket?.status === "ok" && m.lastTicketAt * 1000 >= start)
      tickets.add(m.lastTicketAt);
    emit({
      test: "maintenance",
      status: m.status,
      ticket: m.ticket?.code || m.ticket?.status,
      sidcc: m.sidcc?.code || m.sidcc?.status,
      page: m.page?.code || m.page?.status,
      last_ticket_at: m.lastTicketAt,
      next_attempt_at: m.nextAttemptAt,
      observed_renewals: tickets.size,
    });
  }
  last = s;
}
try {
  emit({ test: "observation_started", minutes, verify_chat: verify });
  do {
    await status();
    const remaining = minutes * 60000 - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(60000, remaining)));
  } while (true);
  if (
    tickets.size < 2 ||
    last.maintenance?.page?.status !== "ok" ||
    last.maintenance?.ticket?.status !== "ok"
  )
    throw Error(
      "Fewer than two successful unattended ticket renewals, or latest login check failed",
    );
  if (verify) {
    const nonce =
      "LOGIN_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const r = await fetch(new URL("/v1/chat/completions", origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        messages: [
          { role: "user", content: `Reply with exactly this marker: ${nonce}` },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(240000),
    });
    if (r.ok && !r.headers.get("x-session-id")?.startsWith(account + "."))
      throw Error(
        "Final generation was routed to a different account; fixed-account validation failed",
      );
    const b = await r.json();
    if (!r.ok || !b.choices?.[0]?.message?.content?.includes(nonce))
      throw Error(
        `Final generation failed: HTTP ${r.status}, code ${b.error?.code || "content_mismatch"}`,
      );
    emit({ test: "post_observation_generation", ok: true, http: r.status });
  }
  emit({
    test: "observation_complete",
    ok: true,
    minutes: (Date.now() - start) / 60000,
    observed_renewals: tickets.size,
    without_reimport: true,
    status_read_retries: statusReadRetries,
  });
} catch (e) {
  emit({ test: "observation_failed", ok: false, message: e.message });
  process.exitCode = 1;
}
