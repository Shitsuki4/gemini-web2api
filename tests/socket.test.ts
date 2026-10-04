import { describe, it, expect, vi } from "vitest";
import {
  socketTransport,
  type Connector,
  type UpstreamSocket,
} from "../src/gemini/socket";
import { gzipSync } from "node:zlib";
const enc = new TextEncoder();
const target = "https://gemini.google.com/app";
function mock(wire: string | Uint8Array, piece = 65536, hanging = false) {
  const bytes = typeof wire === "string" ? enc.encode(wire) : wire;
  let offset = 0,
    reads = 0,
    closed = 0,
    cancelled = 0;
  const written: Uint8Array[] = [];
  const socket: UpstreamSocket = {
    opened: Promise.resolve({}),
    closed: Promise.resolve(),
    readable: new ReadableStream(
      {
        pull(c) {
          reads++;
          if (offset < bytes.length) {
            c.enqueue(bytes.slice(offset, offset + piece));
            offset += piece;
          } else if (!hanging) c.close();
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
    writable: new WritableStream({
      write(b) {
        written.push(b);
      },
    }),
    async close() {
      closed++;
    },
  };
  const connect = vi.fn<Connector>(() => socket);
  return {
    connect,
    fetch: socketTransport(connect, 5000),
    socket,
    get closed() {
      return closed;
    },
    get cancelled() {
      return cancelled;
    },
    get reads() {
      return reads;
    },
    get request() {
      return written.map((b) => new TextDecoder().decode(b)).join("");
    },
  };
}
describe("native TLS HTTP transport", () => {
  it("writes verified TLS with correct UTF-8 length and ignores framing overrides", async () => {
    const m = mock("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", 1);
    const r = await m.fetch(target, {
      method: "POST",
      body: "中文",
      headers: {
        Host: "evil.test",
        "Content-Length": "1",
        "Transfer-Encoding": "chunked",
        Cookie: "x=secret",
      },
    });
    expect(await r.text()).toBe("ok");
    expect(m.connect).toHaveBeenCalledWith(
      { hostname: "gemini.google.com", port: 443 },
      { secureTransport: "on", allowHalfOpen: false },
    );
    expect(m.request).toContain("content-length: 6\r\n");
    expect(m.request).toContain("host: gemini.google.com\r\n");
    expect(m.request).toContain("cookie: x=secret\r\n");
    expect(m.request).not.toContain("evil.test");
    expect(m.request).not.toContain("transfer-encoding");
    expect(m.closed).toBe(1);
  });
  it("parses split chunked UTF-8, extensions, trailers and interim responses", async () => {
    const m = mock(
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n6;test=1\r\n中文\r\n1\r\n!\r\n0\r\nX-Trailer: yes\r\n\r\n",
      1,
    );
    const r = await m.fetch(target);
    expect(await r.text()).toBe("中文!");
    expect(r.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(r.headers.has("transfer-encoding")).toBe(false);
    expect(r.headers.has("x-trailer")).toBe(false);
    expect(m.closed).toBe(1);
  });
  it("does not follow redirects or replay a POST", async () => {
    const m = mock(
      "HTTP/1.1 302 Found\r\nLocation: https://www.google.com/sorry/index?secret=test\r\nContent-Length: 4\r\n\r\nbody",
    );
    const r = await m.fetch(target, { method: "POST", body: "prompt" });
    expect(r.status).toBe(302);
    await r.body!.cancel();
    expect(m.connect).toHaveBeenCalledTimes(1);
    expect(m.closed).toBe(1);
  });
  it("streams close-delimited responses", async () => {
    const m = mock("HTTP/1.0 200 OK\r\n\r\nhello", 2);
    expect(await (await m.fetch(target)).text()).toBe("hello");
    expect(m.closed).toBe(1);
  });
  it("honors backpressure and closes an abandoned response", async () => {
    const header = "HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n";
    const m = mock(header + "a".repeat(100000), header.length);
    const r = await m.fetch(target);
    expect(m.reads).toBe(1);
    const reader = r.body!.getReader();
    expect((await reader.read()).value!.length).toBe(header.length);
    expect(m.reads).toBe(2);
    await reader.cancel();
    expect(m.closed).toBe(1);
    expect(m.cancelled).toBe(1);
  });
  for (const response of [
    "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nshort",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\nshort",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxXX0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nINVALID\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n",
  ])
    it("rejects truncated or invalid body framing", async () => {
      const m = mock(response, 3);
      const r = await m.fetch(target);
      await expect(r.text()).rejects.toThrow();
      expect(m.closed).toBe(1);
    });
  for (const h of [
    "Content-Length: 1\r\nTransfer-Encoding: chunked",
    "Content-Length: 1\r\nContent-Length: 1",
    "Content-Length: -2",
    "Content-Length: 99999999999999999999999",
    "Transfer-Encoding: gzip, chunked",
    "Bad Header: x",
    " folded",
    "Content-Encoding: br",
    "X-Long: " + "x".repeat(32768),
  ])
    it("rejects ambiguous/unsupported/oversized headers", async () => {
      const m = mock("HTTP/1.1 200 OK\r\n" + h + "\r\n\r\n");
      await expect(m.fetch(target)).rejects.toThrow();
      expect(m.closed).toBe(1);
    });
  it("accepts Gemini-sized CSP fields without relaxing chunk-line limits", async () => {
    const csp = "script-src " + "x".repeat(21000);
    const m = mock(
      "HTTP/1.1 200 OK\r\nContent-Security-Policy: " +
        csp +
        "\r\nContent-Length: 2\r\n\r\nOK",
      4096,
    );
    const r = await m.fetch(target);
    expect(r.headers.get("content-security-policy")).toBe(csp);
    expect(await r.text()).toBe("OK");
    const bad = mock(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1;" +
        "x".repeat(8200) +
        "\r\na\r\n0\r\n\r\n",
    );
    await expect((await bad.fetch(target)).text()).rejects.toThrow();
  });
  it("bounds total header bytes", async () => {
    const m = mock(
      "HTTP/1.1 200 OK\r\n" +
        ("X-Header: " + "x".repeat(4000) + "\r\n").repeat(20) +
        "\r\n",
    );
    await expect(m.fetch(target)).rejects.toThrow();
    expect(m.closed).toBe(1);
  });
  it("decodes gzip when upstream ignores identity", async () => {
    const data = gzipSync("compressed 中文");
    const head = enc.encode(
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${data.length}\r\n\r\n`,
    );
    const wire = new Uint8Array(head.length + data.length);
    wire.set(head);
    wire.set(data, head.length);
    const m = mock(wire, 3);
    const r = await m.fetch(target);
    expect(await r.text()).toBe("compressed 中文");
    expect(r.headers.has("content-length")).toBe(false);
  });
  it("returns bodyless responses and closes sockets", async () => {
    const m = mock("HTTP/1.1 204 No Content\r\n\r\n");
    const r = await m.fetch(target);
    expect(r.body).toBeNull();
    expect(m.closed).toBe(1);
  });
  it("does not open sockets for an aborted request or unsafe target", async () => {
    const m = mock("");
    const ac = new AbortController();
    ac.abort();
    await expect(m.fetch(target, { signal: ac.signal })).rejects.toThrow();
    for (const u of [
      "http://gemini.google.com",
      "https://evil.test/",
      "https://user:pass@gemini.google.com",
      "https://gemini.google.com:444/",
      "https://127.0.0.1/",
    ])
      await expect(m.fetch(u)).rejects.toThrow();
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("aborts while waiting for headers, without secret-bearing errors", async () => {
    const m = mock("", 1, true);
    const ac = new AbortController();
    const p = m.fetch(target, {
      signal: ac.signal,
      headers: { Cookie: "TOP_SECRET" },
    });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "upstream_aborted" });
    expect(m.closed).toBe(1);
  });
  it("aborts a pending body read", async () => {
    const m = mock(
      "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n",
      65536,
      true,
    );
    const ac = new AbortController();
    const r = await m.fetch(target, { signal: ac.signal });
    const body = r.text();
    ac.abort();
    await expect(body).rejects.toMatchObject({ code: "upstream_aborted" });
    expect(m.closed).toBe(1);
  });
  it("times out a stalled handshake and closes it once", async () => {
    const m = mock("");
    m.socket.opened = new Promise(() => {});
    await expect(socketTransport(m.connect, 20)(target)).rejects.toMatchObject({
      code: "upstream_timeout",
    });
    expect(m.closed).toBe(1);
  });
  it("sanitizes transport errors and never retries after failed writes", async () => {
    const m = mock("");
    m.socket.writable = new WritableStream({
      write() {
        throw Error("TOP_SECRET https://google.com/token");
      },
    });
    await expect(m.fetch(target)).rejects.toMatchObject({
      code: "upstream_transport",
    });
    expect(m.connect).toHaveBeenCalledTimes(1);
    expect(m.closed).toBe(1);
  });
});
