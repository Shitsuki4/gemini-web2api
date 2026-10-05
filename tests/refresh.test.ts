import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiClient, mergeCookies } from "../src/gemini/client";
import {
  refreshDelay,
  retrySeconds,
  rotateParams,
  TICKET_BODY,
  ROTATE_PAGE,
} from "../src/gemini/refresh";
import { ApiError } from "../src/util";
import type { Credentials } from "../src/types";
const time = 1791160000;
function setup(
  options: {
    ticket?: number;
    sidcc?: number;
    page?: number;
    noTicket?: boolean;
    noSidcc?: boolean;
    cookies?: string[];
    retry?: string;
    pageRetry?: string;
    challenge?: boolean;
    firstPageFails?: boolean;
    interval?: number;
  } = {},
) {
  vi.spyOn(Date, "now").mockReturnValue(time * 1000);
  const creds: Credentials = {
    cookie:
      "__Secure-1PSID=SECRET_SID; __Secure-1PSIDTS=OLD_TS; SIDCC=OLD_CC; __Host-DBSC=PRIVATE_BOUND; GEMINI_ONLY=PRIVATE_HOST",
  };
  const saved: Credentials[] = [];
  const requests: { url: string; headers: Headers; body: string }[] = [];
  let pages = 0;
  const save = vi.fn(async () => {
    saved.push(structuredClone(creds));
  });
  const transport = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = String(init.body || "");
    expect(saved.length).toBeGreaterThan(0);
    requests.push({ url, headers, body });
    expect(init.redirect).toBe("manual");
    if (url.endsWith("/RotateCookies")) {
      const ticket = body === TICKET_BODY;
      const status = (ticket ? options.ticket : options.sidcc) || 200;
      const h = new Headers({ "retry-after": options.retry || "0" });
      if (status === 200) {
        for (const value of ticket
          ? (options.cookies ??
            (options.noTicket
              ? []
              : [
                  "__Secure-1PSIDTS=NEW_TS; Domain=.google.com; Path=/; Secure; HttpOnly",
                ]))
          : options.noSidcc
            ? []
            : ["SIDCC=NEW_CC; Domain=.google.com; Path=/"])
          h.append("set-cookie", value);
      }
      return new Response("[]", { status, headers: h });
    }
    if (url === ROTATE_PAGE)
      return new Response(
        `init('4162200486104360679', 658.0, 0.0, 0.0, ${options.interval || 600}.0)`,
      );
    if (url.endsWith("/app")) {
      pages++;
      if (options.challenge)
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://www.google.com/sorry/index?secret=PRIVATE",
          },
        });
      if (options.page === 302 || (options.firstPageFails && pages === 1))
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://accounts.google.com/ServiceLogin?secret=PRIVATE",
          },
        });
      if (options.page && options.page !== 200)
        return new Response("error", {
          status: options.page,
          headers: { "retry-after": options.pageRetry || "0" },
        });
      return new Response('"SNlM0e":"PRIVATE_XSRF","cfb2h":"boq_test"');
    }
    if (url.includes("StreamGenerate"))
      return new Response("generation rejected", { status: 500 });
    throw Error("Unexpected test request");
  }) as unknown as typeof fetch;
  const client = new GeminiClient(
    creds,
    save,
    AbortSignal.timeout(10000),
    transport,
  );
  return { creds, saved, requests, save, client, transport };
}
afterEach(() => vi.restoreAllMocks());
describe("durable login maintenance", () => {
  it("renews independent tickets and page tokens, persists before I/O, leaks no secrets", async () => {
    const x = setup();
    const r = await x.client.rotate();
    expect(r.status).toBe("healthy");
    expect(r.nextAttemptAt).toBe(time + 600);
    expect(x.saved[0].maintenance?.status).toBe("running");
    expect(x.requests).toHaveLength(4);
    expect(x.requests[0].body).toBe('[000,"-0000000000000000000"]');
    expect(x.requests[0].headers.get("cookie")).toBe(
      "__Secure-1PSID=SECRET_SID; __Secure-1PSIDTS=OLD_TS",
    );
    expect(x.requests[2].body).toBe('[658,"4162200486104360679"]');
    expect(x.requests[2].headers.get("cookie")).toContain(
      "__Secure-1PSIDTS=NEW_TS",
    );
    expect(x.requests[2].headers.get("cookie")).not.toMatch(/DBSC|GEMINI_ONLY/);
    expect(x.creds.refreshedAt).toBe(time);
    expect(x.creds.fetchedAt).toBe(time);
    expect(JSON.stringify(r)).not.toMatch(
      /SECRET|PRIVATE|NEW_TS|NEW_CC|4162200486104360679/,
    );
  });
  it("401 does not suppress SIDCC or page checking and does not claim ticket renewed", async () => {
    const x = setup({ ticket: 401 });
    const r = await x.client.rotate();
    expect(r.status).toBe("degraded");
    expect(r.ticket?.code).toBe("refresh_http_401");
    expect(r.sidcc?.status).toBe("ok");
    expect(r.page?.status).toBe("ok");
    expect(x.creds.refreshedAt).toBeUndefined();
    expect(x.requests).toHaveLength(4);
  });
  it("reports unrecoverable login honestly without following redirects", async () => {
    const x = setup({ ticket: 401, page: 302 });
    const r = await x.client.rotate();
    expect(r.status).toBe("reimport_required");
    expect(r.nextAttemptAt).toBe(time + 1800);
    expect(r.page?.code).toBe("login_expired");
    expect(x.requests).toHaveLength(4);
    expect(JSON.stringify(r)).not.toContain("ServiceLogin");
  });
  it("saves renewed PSIDTS even if both remaining steps fail", async () => {
    const x = setup({ sidcc: 403, page: 302 });
    const r = await x.client.rotate();
    expect(r.status).toBe("degraded");
    expect(r.ticket?.status).toBe("ok");
    expect(
      x.saved.some((c) => c.cookie.includes("NEW_TS") && !c.maintenance?.page),
    ).toBe(true);
    expect(x.creds.refreshedAt).toBe(time);
  });
  it("honors Retry-After and skips another rotation POST after 429", async () => {
    const x = setup({ ticket: 429, retry: "7200" });
    const r = await x.client.rotate();
    expect(x.requests).toHaveLength(2);
    expect(r.sidcc?.status).toBe("skipped");
    expect(r.page?.status).toBe("ok");
    expect(r.nextRotationAt).toBe(time + 7200);
    expect(r.nextPageAt).toBe(time + 600);
    expect(r.nextAttemptAt).toBe(time + 600);
  });
  it("honors page probe Retry-After independently of successful ticket renewal", async () => {
    const x = setup({ page: 429, pageRetry: "7200" });
    const r = await x.client.rotate();
    expect(r.ticket?.status).toBe("ok");
    expect(r.page?.status).toBe("error");
    expect(r.nextRotationAt).toBe(time + 600);
    expect(r.nextPageAt).toBe(time + 7200);
    expect(r.nextAttemptAt).toBe(time + 600);
  });
  it("enforces persisted backoff even after client reconstruction", async () => {
    const x = setup({ ticket: 401, page: 302 });
    await x.client.rotate();
    const c = new GeminiClient(
      structuredClone(x.creds),
      x.save,
      AbortSignal.timeout(1000),
      x.transport,
    );
    await expect(c.rotate()).rejects.toMatchObject({
      code: "refresh_backoff",
      status: 429,
    });
    expect(x.requests).toHaveLength(4);
  });
  it("increments exponential backoff and resets after a fully healthy round", async () => {
    const x = setup({ ticket: 401, page: 302 });
    await x.client.rotate();
    vi.spyOn(Date, "now").mockReturnValue((time + 1800) * 1000);
    const r = await x.client.rotate();
    expect(r.failures).toBe(2);
    expect(r.nextAttemptAt).toBe(time + 1800 + 3600);
    const y = setup();
    y.creds.maintenance = {
      ...r,
      nextAttemptAt: time,
      nextRotationAt: time,
      nextPageAt: time,
    };
    expect((await y.client.rotate()).failures).toBe(0);
  });
  it.each(["Max-Age=0", "Max-Age=-1", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"])(
    "does not treat ticket deletion as renewal: %s",
    async (attr) => {
      const x = setup({
        cookies: [
          `__Secure-1PSIDTS=OLD_TS; Domain=.google.com; Path=/; ${attr}`,
        ],
      });
      const r = await x.client.rotate();
      expect(r.ticket?.code).toBe("refresh_no_ticket");
      expect(x.creds.cookie).not.toContain("__Secure-1PSIDTS=");
      expect(x.creds.refreshedAt).toBeUndefined();
    },
  );
  it.each([
    "",
    "; Domain=accounts.google.com; Path=/",
    "; Domain=.google.com; Path=/restricted",
    "; Domain=.evilgoogle.com; Path=/",
  ])("ignores non-shared accounts cookies: %s", async (attr) => {
    const x = setup({ cookies: ["__Secure-1PSIDTS=HOST_ONLY" + attr] });
    const r = await x.client.rotate();
    expect(r.ticket?.code).toBe("refresh_no_ticket");
    expect(x.creds.cookie).not.toContain("HOST_ONLY");
  });
  it("does not label a 200 without new tickets healthy", async () => {
    const x = setup({ noTicket: true, noSidcc: true });
    const r = await x.client.rotate();
    expect(r.status).toBe("degraded");
    expect(r.ticket?.code).toBe("refresh_no_ticket");
    expect(r.sidcc?.code).toBe("refresh_no_sidcc");
  });
  it("recovers only before generation and never replays a submitted generation", async () => {
    const x = setup({ firstPageFails: true });
    x.saved.push(structuredClone(x.creds));
    await expect(
      x.client.generate(
        {
          model: "gemini-3.6-flash",
          prompt: "test",
          files: [],
          stream: false,
          owner: "test",
          endpoint: "chat",
        },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(
      x.requests.filter((r) => r.url.includes("StreamGenerate")),
    ).toHaveLength(1);
    expect(x.requests.filter((r) => r.body === TICKET_BODY)).toHaveLength(1);
  });
  it("uses SIDCC already issued with the short ticket instead of a redundant POST", async () => {
    const x = setup({
      cookies: [
        "__Secure-1PSIDTS=NEW_TS; Domain=.google.com; Path=/",
        "__Secure-1PSIDCC=NEW_CC; Domain=.google.com; Path=/",
      ],
    });
    const r = await x.client.rotate();
    expect(r.status).toBe("healthy");
    expect(r.lastSidccAt).toBe(time);
    expect(x.requests).toHaveLength(2);
  });
  it("SIDCC-only failures cannot exponentially delay a healthy short ticket", async () => {
    const x = setup({ sidcc: 429 });
    for (let i = 0; i < 4; i++) {
      vi.spyOn(Date, "now").mockReturnValue((time + i * 600) * 1000);
      const r = await x.client.rotate();
      expect(r.status).toBe("degraded");
      expect(r.failures).toBe(i + 1);
      expect(r.nextAttemptAt).toBe(time + (i + 1) * 600);
    }
  });
  it("runs due maintenance before generation even when cached page tokens remain valid", async () => {
    const x = setup();
    Object.assign(x.creds, {
      importedAt: time - 20,
      xsrf: "cached",
      bl: "cached",
      fetchedAt: time,
    });
    await expect(
      x.client.generate(
        {
          model: "gemini-3.6-flash",
          prompt: "test",
          files: [],
          stream: false,
          owner: "test",
          endpoint: "chat",
        },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(x.requests[0].body).toBe(TICKET_BODY);
    expect(
      x.requests.filter((r) => r.url.includes("StreamGenerate")),
    ).toHaveLength(1);
  });
  it("maintains short tickets at ten minutes even if SIDCC asks for one hour", async () => {
    const x = setup({ interval: 3600 });
    const first = await x.client.rotate();
    expect(first.intervalSeconds).toBe(3600);
    expect(first.nextAttemptAt).toBe(time + 600);
    vi.spyOn(Date, "now").mockReturnValue((time + 600) * 1000);
    const next = await x.client.rotate();
    expect(next.status).toBe("healthy");
    expect(next.sidcc?.code).toBe("refresh_not_due");
    expect(next.lastSidccAt).toBe(time);
    expect(next.lastTicketAt).toBe(time + 600);
    expect(next.nextAttemptAt).toBe(time + 1200);
    expect(x.requests.filter((r) => r.url === ROTATE_PAGE)).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue((time + 3600) * 1000);
    expect((await x.client.rotate()).sidcc?.status).toBe("ok");
    expect(x.requests.filter((r) => r.url === ROTATE_PAGE)).toHaveLength(2);
  });
  it("does not make network requests if initial persistence fails", async () => {
    const x = setup();
    x.save.mockRejectedValueOnce(Error("storage failure"));
    await expect(x.client.rotate()).rejects.toThrow("storage failure");
    expect(x.requests).toHaveLength(0);
  });
});
describe("rotation and cookie parsers", () => {
  it("uses real page parameters without accepting arbitrary text or product IDs", () => {
    expect(rotateParams("init('12345678',658,0,0,900)")).toEqual({
      id: "12345678",
      interval: 900,
    });
    expect(() => rotateParams("init('evil',658,0,0,600)")).toThrow();
    expect(() => rotateParams("init('12345678',999,0,0,600)")).toThrow();
    expect(rotateParams("init('12345678',658,0,0,5)").interval).toBe(600);
  });
  it("honors Max-Age precedence and handles empty/expired cookies", () => {
    expect(
      mergeCookies("a=1; b=2", [
        "a=3; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=600",
      ]),
    ).toBe("a=3; b=2");
    expect(mergeCookies("a=1; b=2", ["a=; Path=/"])).toBe("b=2");
  });
  it("bounds Retry-After dates and exponential delays", () => {
    expect(
      retrySeconds(
        "Wed, 07 Oct 2026 00:00:00 GMT",
        Date.parse("2026-10-06T23:00Z") / 1000,
      ),
    ).toBe(3600);
    expect(retrySeconds("garbage")).toBe(0);
    expect(retrySeconds("9999999")).toBe(86400);
    expect(refreshDelay(20, true, 0, 600)).toBe(21600);
  });
});

describe("independent page and rotation clocks", () => {
  it("sustains short tickets for four simulated hours while backing off a blocked page", async () => {
    const x = setup({
      challenge: true,
      cookies: [
        "__Secure-1PSIDTS=NEW_TS; Domain=.google.com; Path=/",
        "__Secure-1PSIDCC=NEW_CC; Domain=.google.com; Path=/",
      ],
    });
    for (let i = 0; i < 25; i++) {
      vi.spyOn(Date, "now").mockReturnValue((time + i * 600) * 1000);
      // Reconstruct every round like DO eviction: all budgets must be persisted.
      const c = new GeminiClient(
        x.creds,
        x.save,
        AbortSignal.timeout(10000),
        x.transport,
      );
      const state = await c.rotate();
      expect(state.status).toBe("blocked");
      expect(state.nextRotationAt).toBe(time + (i + 1) * 600);
      expect(state.lastTicketAt).toBe(time + i * 600);
      expect(state.rotationFailures).toBe(0);
      expect(state.history!.length).toBeLessThanOrEqual(24);
    }
    expect(x.requests.filter((r) => r.body === TICKET_BODY)).toHaveLength(25);
    expect(x.requests.filter((r) => r.url.endsWith("/app"))).toHaveLength(5);
    expect(x.creds.maintenance?.nextPageAt).toBe(time + 31 * 600);
    expect(JSON.stringify(x.creds.maintenance)).not.toMatch(
      /PRIVATE|SECRET|NEW_TS|google.com/,
    );
  });
  it("continues due page checks without violating accounts Retry-After", async () => {
    const x = setup({ ticket: 429, retry: "7200" });
    await x.client.rotate();
    vi.spyOn(Date, "now").mockReturnValue((time + 600) * 1000);
    const state = await x.client.rotate();
    expect(x.requests.filter((r) => r.body === TICKET_BODY)).toHaveLength(1);
    expect(x.requests.filter((r) => r.url.endsWith("/app"))).toHaveLength(2);
    expect(state.nextRotationAt).toBe(time + 7200);
    expect(state.nextPageAt).toBe(time + 1200);
  });
  it("does not retry a rate-limited page on every successful ticket renewal", async () => {
    const x = setup({ page: 429, pageRetry: "7200" });
    await x.client.rotate();
    for (let i = 1; i <= 3; i++) {
      vi.spyOn(Date, "now").mockReturnValue((time + i * 600) * 1000);
      await x.client.rotate();
    }
    expect(x.requests.filter((r) => r.body === TICKET_BODY)).toHaveLength(4);
    expect(x.requests.filter((r) => r.url.endsWith("/app"))).toHaveLength(1);
    expect(x.creds.maintenance?.nextPageAt).toBe(time + 7200);
  });
  it("recovers after the independently due page succeeds", async () => {
    const options = { challenge: true };
    const x = setup(options);
    await x.client.rotate();
    vi.spyOn(Date, "now").mockReturnValue((time + 600) * 1000);
    await x.client.rotate();
    options.challenge = false;
    vi.spyOn(Date, "now").mockReturnValue((time + 1200) * 1000);
    expect((await x.client.rotate()).status).toBe("blocked");
    vi.spyOn(Date, "now").mockReturnValue((time + 1800) * 1000);
    const state = await x.client.rotate();
    expect(state.status).toBe("healthy");
    expect(state.pageFailures).toBe(0);
    expect(x.creds.pageDiagnostic?.code).toBeUndefined();
  });
});
