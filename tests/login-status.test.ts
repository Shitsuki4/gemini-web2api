import { describe, expect, it } from "vitest";
import { loginStatus } from "../public/login-status.js";
describe("console login diagnostic formatting", () => {
  it("renders independent deadlines and successful results", () => {
    const text = loginStatus({
      maintenance: {
        status: "healthy",
        ticket: { status: "ok" },
        sidcc: { status: "ok" },
        page: { status: "ok" },
        nextRotationAt: 1700000000,
        nextPageAt: 1700003600,
      },
      page_diagnostic: { kind: "signed_in", at: 1700000000 },
    });
    expect(text).toContain("票据：ok");
    expect(text).toContain("页面：ok");
    expect(text).toContain(new Date(1700000000 * 1000).toLocaleString());
    expect(text).toContain(new Date(1700003600 * 1000).toLocaleString());
    expect(text).toContain("signed_in / ok");
  });
  it("distinguishes generation load from healthy login", () => {
    const text = loginStatus({
      busy: true,
      queued: 2,
      queue_capacity: 4,
      rate_limit: { used: 3, limit: 6 },
      maintenance: { status: "healthy" },
    });
    expect(text).toContain("账号：处理中");
    expect(text).toContain("排队：2/4");
    expect(text).toContain("本分钟生成：3/6");
  });
  it("supports not-yet-maintained accounts", () => {
    expect(loginStatus({})).toContain("尚未进行保活检查");
    expect(loginStatus({})).not.toMatch(/undefined|Invalid Date/);
  });
  it("supports the legacy single-clock schema", () => {
    expect(
      loginStatus({
        maintenance: { status: "degraded", nextAttemptAt: 1700000000 },
      }),
    ).toContain(new Date(1700000000 * 1000).toLocaleString());
  });
  it("shows the latest page failure even when an older maintenance check passed", () => {
    expect(
      loginStatus({
        maintenance: { status: "healthy" },
        page_diagnostic: {
          kind: "unrecognized",
          code: "page_tokens_missing",
          at: 1700000000,
        },
      }),
    ).toContain("unrecognized / page_tokens_missing");
  });
});
