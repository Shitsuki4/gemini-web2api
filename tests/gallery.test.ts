import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactPath, fetchArtifact } from "../public/media.js";
const id = "acc_" + "a".repeat(32) + ".file_" + "b".repeat(32);
afterEach(() => vi.unstubAllGlobals());
describe("authenticated gallery download", () => {
  it("rejects external URLs and path injection before attaching a key", () => {
    for (const bad of [
      "https://evil.example/",
      id + "/../",
      null,
      id + "?key=x",
    ])
      expect(() => artifactPath(bad)).toThrow();
  });
  it("fetches only same-origin files with a header key, without redirects", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("BYTES", { headers: { "content-type": "image/jpeg" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    const blob = await fetchArtifact(id, "test-key");
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(5);
    expect(fetcher).toHaveBeenCalledWith(`/v1/files/${id}/content`, {
      headers: { Authorization: "Bearer test-key" },
      redirect: "error",
      signal: undefined,
    });
  });
  it("does not render HTML or SVG as generated media", async () => {
    for (const type of ["text/html", "image/svg+xml"]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response("<script>", { headers: { "content-type": type } }),
          ),
      );
      await expect(fetchArtifact(id, "key")).rejects.toThrow("不是支持");
    }
  });
  it("shows expired/unauthorized download errors rather than a broken image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "File expired" } }), {
          status: 404,
        }),
      ),
    );
    await expect(fetchArtifact(id, "key")).rejects.toThrow("File expired");
  });
  it("bounds downloads even when content-length is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    await expect(fetchArtifact(id, "key")).rejects.toThrow("20 MiB");
  });
});
