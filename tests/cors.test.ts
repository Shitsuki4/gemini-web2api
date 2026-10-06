import { describe, expect, it } from "vitest";
import { apiCorsHeaders, apiPreflight, isPublicApi } from "../src/cors";
function preflight(headers: Record<string, string> = {}) {
  return apiPreflight(
    new Request("https://gateway.test/v1/models", {
      method: "OPTIONS",
      headers: { Origin: "https://client.test", ...headers },
    }),
  );
}
describe("inference-only CORS", () => {
  it("never marks admin, health or lookalike paths as public API", () => {
    for (const path of [
      "/admin/config",
      "/healthz",
      "/v1",
      "/v1evil/models",
      "/",
      "/v1betaevil/x",
    ])
      expect(isPublicApi(path)).toBe(false);
    for (const path of [
      "/v1/models",
      "/v1/chat/completions",
      "/v1/files/x/content",
      "/v1beta/models/x:generateContent",
    ])
      expect(isPublicApi(path)).toBe(true);
  });
  it("permits a bearer preflight without an authentication credential", () => {
    const r = preflight({
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "authorization,content-type,x-session-id",
    });
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Allow-Headers")).toContain(
      "authorization",
    );
    expect(r.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(r.headers.get("Access-Control-Max-Age")).toBe("600");
  });
  it("supports browser SDK field names, case folding and cache variance", () => {
    const r = preflight({
      "Access-Control-Request-Headers":
        "X-Stainless-Lang, x-client-version, Authorization, authorization",
    });
    const allowed = r.headers.get("Access-Control-Allow-Headers")!.split(", ");
    expect(allowed).toContain("x-stainless-lang");
    expect(allowed).toContain("x-client-version");
    expect(allowed.filter((x) => x === "authorization")).toHaveLength(1);
    expect(r.headers.get("Vary")).toContain("Access-Control-Request-Headers");
  });
  it("rejects methods the API does not implement", () => {
    for (const method of ["PUT", "PATCH", "DELETE", "TRACE"])
      expect(() =>
        preflight({ "Access-Control-Request-Method": method }),
      ).toThrow("Unsupported API method");
  });
  it("rejects malformed or oversized reflected headers", () => {
    for (const bad of [
      "authorization: secret",
      "x bad",
      "a,,b",
      "x/evil",
      "a".repeat(2049),
      Array(33).fill("x").join(","),
    ])
      expect(() =>
        preflight({ "Access-Control-Request-Headers": bad }),
      ).toThrow("Invalid preflight headers");
  });
  it("exposes session, retry and download metadata, but no cookie credentials", () => {
    const h = new Headers(apiCorsHeaders());
    expect(h.get("Access-Control-Expose-Headers")).toContain("X-Session-Id");
    expect(h.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    expect(h.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    expect(h.has("Access-Control-Allow-Credentials")).toBe(false);
  });
});
