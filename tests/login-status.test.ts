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
