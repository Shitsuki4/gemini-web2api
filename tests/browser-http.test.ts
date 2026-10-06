import { afterEach, describe, expect, it, vi } from "vitest";
import { browserError, fetchOnce, responseJson } from "../public/http.js";
afterEach(() => vi.unstubAllGlobals());
describe("browser transport failures without replay", () => {
  it("never retries an uncertain generation", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", f);
    await expect(
      fetchOnce("/v1/chat/completions", { method: "POST" }, "generate"),
    ).rejects.toThrow("请求可能已到达服务器，未自动重发");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("tells admin writers to inspect state instead of repeating an action", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", f);
    await expect(
      fetchOnce("/admin/keys", { method: "POST" }, "write"),
    ).rejects.toThrow("操作可能已经生效");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("does not call a transport failure login expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(fetchOnce("/admin/config", {}, "read")).rejects.toThrow(
      "这不等于 Gemini 登录失效",
    );
  });
  it("preserves explicit cancellation without retry", async () => {
    const e = new DOMException("cancelled", "AbortError");
    const f = vi.fn().mockRejectedValue(e);
    vi.stubGlobal("fetch", f);
    await expect(
      fetchOnce("/v1/chat/completions", {}, "generate"),
    ).rejects.toBe(e);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("preserves HTTP errors and rejects redirect-following with credentials", async () => {
    const r = new Response('{"error":{"code":"unauthorized"}}', {
      status: 401,
    });
    const f = vi.fn().mockResolvedValue(r);
    vi.stubGlobal("fetch", f);
    expect(
      await fetchOnce("/v1/models", {
        headers: { Authorization: "Bearer example" },
        redirect: "follow",
      }),
    ).toBe(r);
    expect(f.mock.calls[0][1].redirect).toBe("error");
    expect((await responseJson(r)).error.code).toBe("unauthorized");
  });
  it("does not reveal raw HTML in an edge/proxy error", async () => {
    const r = new Response("<html>PRIVATE_EDGE_DATA</html>", { status: 502 });
    const e = await responseJson(r).catch((e) => e);
    expect(e.message).toContain("HTTP 502");
    expect(e.message).not.toContain("PRIVATE_EDGE_DATA");
  });
  it("labels download failures without suggesting a new generation", () => {
    expect(browserError(new TypeError("Load failed"), "download")).toContain(
      "不要因此重新提交生成",
    );
  });
  it("does not hide upstream errors or unrelated programming TypeErrors", () => {
    expect(browserError(Error("upstream_http_429"), "generate")).toBe(
      "upstream_http_429",
    );
    expect(browserError(new TypeError("not a function"))).toBe(
      "not a function",
    );
  });
  it("labels a stream connection loss and does not retry the body", async () => {
    const read = vi.fn().mockRejectedValue(new TypeError("terminated"));
    await expect(
      responseJson({ json: read, status: 200 }, "generate"),
    ).rejects.toThrow("未自动重发");
    expect(read).toHaveBeenCalledTimes(1);
    expect(browserError(new TypeError("network error"), "generate")).toContain(
      "未自动重发",
    );
  });
});
