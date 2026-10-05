import type { Credentials, LoginMaintenance, RefreshStep } from "../types";
import { ApiError, now, readLimited } from "../util";

export const ROTATE_PAGE =
  "https://accounts.google.com/RotateCookiesPage?og_pid=658&rot=3&origin=https%3A%2F%2Fgemini.google.com&exp_id=0";
const ROTATE_POST = "https://accounts.google.com/RotateCookies";
// JSPB sentinel, intentionally NOT JSON.stringify([0, ...]). See Go rotate.go.
export const TICKET_BODY = '[000,"-0000000000000000000"]';
export const REFRESH_INTERVAL = 600;
export function rotateParams(html: string) {
  const m =
    /\binit\(\s*['"](-?\d{4,64})['"]\s*,\s*658(?:\.0)?\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(
      html,
    );
  if (!m)
    throw new ApiError(
      502,
      "refresh_page_changed",
      "Rotation page did not contain recognized session parameters",
    );
  const seconds = Number(m[2]);
  return {
    id: m[1],
    interval:
      Number.isFinite(seconds) && seconds >= 60 && seconds <= 3600
        ? Math.ceil(seconds)
        : REFRESH_INTERVAL,
  };
}
export function retrySeconds(header: string | null, time = now()) {
  if (!header) return 0;
  const seconds = /^\d+$/.test(header.trim())
    ? Number(header)
    : Math.ceil(Date.parse(header) / 1000) - time;
  return Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : 0;
}
export function refreshDelay(
  failures: number,
  authFailure: boolean,
  retryAfter: number,
  interval: number,
) {
  // SIDCC's suggested cadence must never extend the short-ticket cadence.
  const normal = Math.max(60, Math.min(REFRESH_INTERVAL, interval));
  if (!failures) return normal;
  return Math.max(
    normal,
    retryAfter,
    Math.min(
      21600,
      (authFailure ? 1800 : 600) * 2 ** Math.min(failures - 1, 6),
    ),
  );
}
export function maintenanceMessage(s: LoginMaintenance) {
  const status =
    s.status === "healthy"
      ? "短期票据已换发，页面登录有效，SIDCC 已更新或尚未到维护时间。"
      : s.status === "reimport_required"
        ? "自动续期未恢复登录。请在浏览器确认登录后更新原账号；不会重放生成。"
        : "本轮保活未全部通过；页面可用不等于长期票据已续期。";
  return `${status} 票据：${s.ticket?.code || s.ticket?.status || "待检查"}；SIDCC：${s.sidcc?.code || s.sidcc?.status || "待检查"}；页面：${s.page?.code || s.page?.status || "待检查"}。`;
}
interface RefreshClient {
  credentials: Credentials;
  save(): Promise<void>;
  send(url: string, init: RequestInit): Promise<Response>;
  tokens(): Promise<void>;
  merge(cookie: string, set: string[]): string;
}
const sharedNames = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "SIDCC",
  "NID",
  "AEC",
  "__Secure-ENID",
]);
function subset(cookie: string, names: Set<string>) {
  return cookie
    .split(";")
    .map((x) => x.trim())
    .filter((x) => names.has(x.split("=")[0]))
    .join("; ");
}
// An accounts.google.com host-only cookie must not be forwarded to Gemini.
function sharedSetCookies(headers: string[]) {
  return headers.filter((h) => {
    const name = h.split("=", 1)[0].trim();
    return (
      sharedNames.has(name) &&
      /;\s*domain=\.?google\.com\s*(?:;|$)/i.test(h) &&
      !/;\s*path=(?!\/\s*(?:;|$))/i.test(h)
    );
  });
}
export async function refreshLogin(
  c: RefreshClient,
): Promise<LoginMaintenance> {
  const old = c.credentials.maintenance;
  const time = now();
  if (old && time < old.nextAttemptAt)
    throw new ApiError(
      429,
      "refresh_backoff",
      `Login maintenance is in backoff; next attempt at ${new Date(old.nextAttemptAt * 1000).toISOString()}`,
      old.nextAttemptAt - time,
    );
  const state: LoginMaintenance = {
    ...old,
    status: "running",
    lastAttemptAt: time,
    nextAttemptAt: time + 120,
    failures: old?.failures || 0,
    ticket: undefined,
    sidcc: undefined,
    page: undefined,
  };
  c.credentials.maintenance = state;
  // Persist before I/O so eviction / a deployment cannot erase the retry floor.
  await c.save();
  let retryAfter = 0,
    interval = old?.intervalSeconds || REFRESH_INTERVAL,
    rateLimited = false;
  const accept = async (r: Response) => {
    if (r.status === 429) rateLimited = true;
    retryAfter = Math.max(
      retryAfter,
      retrySeconds(r.headers.get("retry-after")),
    );
    if (!r.ok) {
      await r.body?.cancel();
      throw new ApiError(
        502,
        `refresh_http_${r.status}`,
        `Google session maintenance returned HTTP ${r.status}`,
      );
    }
    const headers = sharedSetCookies(r.headers.getSetCookie());
    const next = c.merge(c.credentials.cookie, headers);
    if (next !== c.credentials.cookie) {
      c.credentials.cookie = next;
      c.credentials.fetchedAt = 0;
      await c.save();
    }
    // Deletion is NOT proof of a renewed credential.
    return headers
      .filter((h) => {
        const first = h.split(";")[0],
          name = first.split("=", 1)[0];
        return (
          first.slice(name.length + 1).length > 0 &&
          next.split(";").some((x) => x.trim() === first)
        );
      })
      .map((h) => h.split("=", 1)[0]);
  };
  const step = async (run: () => Promise<string[]>): Promise<RefreshStep> => {
    try {
      const names = await run();
      return { status: "ok", at: now(), cookies: [...new Set(names)] };
    } catch (e) {
      if (e instanceof ApiError && e.retryAfter)
        retryAfter = Math.max(retryAfter, e.retryAfter);
      return {
        status: "error",
        at: now(),
        code: e instanceof ApiError ? e.code : "refresh_network_error",
      };
    }
  };
  const base = {
    Accept: "*/*",
    "Content-Type": "application/json",
    Origin: "https://accounts.google.com",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  state.ticket = await step(async () => {
    const cookie = subset(
      c.credentials.cookie,
      new Set(["__Secure-1PSID", "__Secure-1PSIDTS"]),
    );
    if (!/(?:^|;\s*)__Secure-1PSID=[^;]+/.test(cookie))
      throw new ApiError(
        502,
        "refresh_unavailable",
        "Import __Secure-1PSID to enable ticket renewal",
      );
    const r = await c.send(ROTATE_POST, {
      method: "POST",
      headers: { ...base, Cookie: cookie },
      body: TICKET_BODY,
    });
    const names = await accept(r);
    await r.body?.cancel();
    if (!names.includes("__Secure-1PSIDTS"))
      throw new ApiError(
        502,
        "refresh_no_ticket",
        "Rotation did not issue a first-party short-lived ticket",
      );
    c.credentials.refreshedAt = now();
    state.lastTicketAt = now();
    await c.save();
    return names;
  });
  // Persist a successful ticket even when the independent SIDCC/page step fails.
  await c.save();
  // Some accounts renew first-party SIDCC in the sentinel response too.
  // A redundant POST immediately afterwards can itself trigger HTTP 429.
  const issuedSidcc = (state.ticket.cookies || []).filter((n) =>
    /^(?:SIDCC|__Secure-1PSIDCC)$/.test(n),
  );
  state.sidcc = issuedSidcc.length
    ? { status: "ok", at: now(), cookies: issuedSidcc }
    : rateLimited
      ? { status: "skipped", at: now(), code: "refresh_rate_limited" }
      : old?.lastSidccAt && now() < old.lastSidccAt + interval
        ? { status: "skipped", at: now(), code: "refresh_not_due" }
        : await step(async () => {
            const r = await c.send(ROTATE_PAGE, {
              headers: {
                Cookie: subset(c.credentials.cookie, sharedNames),
                Accept: "text/html",
                Referer: "https://gemini.google.com/",
                "Sec-Fetch-Dest": "iframe",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-site",
              },
            });
            const names = await accept(r);
            const params = rotateParams(
              new TextDecoder().decode(await readLimited(r, 1024 * 1024)),
            );
            interval = params.interval;
            const done = await c.send(ROTATE_POST, {
              method: "POST",
              headers: {
                ...base,
                Referer: ROTATE_PAGE,
                Cookie: subset(c.credentials.cookie, sharedNames),
              },
              body: JSON.stringify([658, params.id]),
            });
            names.push(...(await accept(done)));
            await done.body?.cancel();
            if (!names.some((n) => /^(?:__Secure-[13]PSIDCC|SIDCC)$/.test(n)))
              throw new ApiError(
                502,
                "refresh_no_sidcc",
                "Rotation did not issue SIDCC cookies",
              );
            state.lastSidccAt = now();
            return names;
          });
  if (state.sidcc.status === "ok") state.lastSidccAt = now();
  await c.save();
  // Crucially, a 401/429 in RotateCookies does not suppress this independent GET.
  // It never submits a conversation or tries to solve an authentication challenge.
  state.page = await step(async () => {
    await c.tokens();
    state.lastPageAt = now();
    return [];
  });
  const good =
    state.ticket.status === "ok" &&
    (state.sidcc.status === "ok" || state.sidcc.code === "refresh_not_due") &&
    state.page.status === "ok";
  const authFailure =
    state.page.code === "login_expired" &&
    ["refresh_http_401", "refresh_http_403", "refresh_unavailable"].includes(
      state.ticket.code || "",
    );
  state.status = good
    ? "healthy"
    : authFailure
      ? "reimport_required"
      : "degraded";
  state.failures = good ? 0 : state.failures + 1;
  state.lastCompletedAt = now();
  state.intervalSeconds = interval;
  state.nextAttemptAt =
    now() +
    Math.max(
      retryAfter,
      refreshDelay(
        // A SIDCC-only failure must not exponentially postpone a healthy short
        // ticket past its lifetime. Explicit Retry-After still takes priority.
        state.ticket.status === "ok" && state.page.status === "ok"
          ? 0
          : state.failures,
        authFailure,
        retryAfter,
        interval,
      ),
    );
  await c.save();
  return state;
}
