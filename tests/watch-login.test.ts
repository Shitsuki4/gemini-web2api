import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
const source = await readFile("scripts/watch-login.mjs", "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function run(
  options: {
    reimport?: boolean;
    renew?: boolean;
    verify?: boolean;
    wrongAccount?: boolean;
    minutes?: string;
  } = {},
) {
  const start = 1791160000000;
  let time = start;
  const output: any[] = [];
  const requests: string[] = [];
  const process = {
    argv: [
      "node",
      "watch",
      "--account",
      "acc_test",
      "--minutes",
      options.minutes || "21",
      ...(options.verify ? ["--verify-chat"] : []),
    ],
    env: {
      GATEWAY_URL: "https://gateway.test",
      ADMIN_KEY: "PRIVATE_ADMIN",
      API_KEY: "PRIVATE_API",
    },
    exitCode: 0,
  };
  class Clock extends Date {
    static now() {
      return time;
    }
  }
  const fetch = async (input: any, init: any) => {
    const url = String(input);
    requests.push(url);
    expect(init.redirect).toBe("error");
    if (url.endsWith("/status")) {
      const round =
        options.renew === false ? 0 : Math.floor((time - start) / 600000);
      const ticket = (start - 600000 + round * 600000) / 1000;
      return Response.json({
        configured: true,
        enabled: true,
        imported_at: options.reimport && round > 0 ? 2 : 1,
        maintenance: {
          status: "healthy",
          lastAttemptAt: ticket,
          lastTicketAt: ticket,
          ticket: { status: "ok" },
          sidcc: { status: "ok" },
          page: { status: "ok" },
          nextAttemptAt: ticket + 600,
        },
      });
    }
    expect(url).toBe("https://gateway.test/v1/chat/completions");
    const text = JSON.parse(init.body).messages[0].content.split(": ")[1];
    return Response.json(
      { choices: [{ message: { content: text } }] },
      {
        headers: {
          "x-session-id": options.wrongAccount
            ? "acc_other.test"
            : "acc_test.test",
        },
      },
    );
  };
  const delay = (cb: () => void, ms: number) => {
    time += ms;
    queueMicrotask(cb);
    return 1;
  };
  await new AsyncFunction(
    "process",
    "fetch",
    "Date",
    "console",
    "setTimeout",
    "crypto",
    source,
  )(
    process,
    fetch,
    Clock,
    { log: (s: string) => output.push(JSON.parse(s)) },
    delay,
    crypto,
  );
  expect(JSON.stringify(output)).not.toMatch(/PRIVATE_ADMIN|PRIVATE_API/);
  return { process, output, requests, time, start };
}
describe("bounded, read-only login observation CLI", () => {
  it("observes two new renewals without issuing refresh or reimport and waits for the full window", async () => {
    const r = await run();
    expect(r.process.exitCode).toBe(0);
    expect(r.requests.every((x) => x.endsWith("/status"))).toBe(true);
    expect(r.time - r.start).toBe(21 * 60000);
    expect(r.output.at(-1)).toMatchObject({
      test: "observation_complete",
      observed_renewals: 2,
    });
  });
  it("does not count repeatedly reading one stale ticket as successful renewal", async () => {
    const r = await run({ renew: false });
    expect(r.process.exitCode).toBe(1);
    expect(r.output.at(-1).test).toBe("observation_failed");
  });
  it("rejects a changed import time instead of presenting manual recovery as unattended success", async () => {
    const r = await run({ reimport: true });
    expect(r.process.exitCode).toBe(1);
    expect(r.output.at(-1).message).toContain("reimported");
  });
  it("optionally makes exactly one final generation on the observed account", async () => {
    const r = await run({ verify: true });
    expect(r.process.exitCode).toBe(0);
    expect(r.requests.filter((x) => x.endsWith("/completions"))).toHaveLength(
      1,
    );
    expect(r.output.at(-2).test).toBe("post_observation_generation");
  });
  it("rejects a final generation routed to a different account", async () => {
    const r = await run({ verify: true, wrongAccount: true });
    expect(r.process.exitCode).toBe(1);
    expect(r.output.at(-1).message).toContain("different account");
  });
  it("rejects unbounded observation durations", async () => {
    await expect(run({ minutes: "9999" })).rejects.toThrow("Set GATEWAY_URL");
  });
});
