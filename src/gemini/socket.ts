import { ApiError } from "../util";

// A small transport interface makes framing/cancellation testable without a live socket.
export interface UpstreamSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  close(): Promise<void>;
}
export type Connector = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on"; allowHalfOpen: false },
) => UpstreamSocket;
const MAX_HEADERS = 64 * 1024;
const MAX_LINE = 8192;
// Gemini /app currently sends a ~21 KiB CSP header. Keep status/chunk lines
// small, allow bounded 32 KiB header fields, and retain the 64 KiB total cap.
const MAX_HEADER_LINE = 32 * 1024;
const MAX_BODY = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function failure(code = "upstream_transport") {
  return new ApiError(
    502,
    code,
    "Gemini TLS/HTTP transport failed; no automatic replay was attempted",
  );
}
function allowedHost(host: string) {
  return (
    [
      "gemini.google.com",
      "accounts.google.com",
      "push.clients6.google.com",
    ].includes(host) ||
    /^(lh[3-6]\.googleusercontent\.com|work\.fife\.usercontent\.google\.com|contribution\.usercontent\.google\.com)$/.test(
      host,
    )
  );
}
function requestBytes(
  body: BodyInit | null | undefined,
): Uint8Array | undefined {
  if (body == null) return;
  if (typeof body === "string" || body instanceof URLSearchParams)
    return encoder.encode(String(body));
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw failure("unsupported_upstream_body");
}

/** One HTTPS request, one socket. Never follows redirects, switches IPs or replays. */
export function socketTransport(
  connector?: Connector,
  timeoutMs = 240000,
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (input instanceof Request) throw failure("unsupported_upstream_request");
    const url = new URL(String(input));
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !allowedHost(url.hostname)
    )
      throw failure("unsafe_upstream_url");
    const method = (init.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "POST"].includes(method))
      throw failure("unsupported_upstream_method");
    const bytes = requestBytes(init.body);
    if ((bytes?.length || 0) > 32 * 1024 * 1024 || (method !== "POST" && bytes))
      throw failure("unsupported_upstream_body");
    const headers = new Headers(init.headers);
    for (const k of [
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "accept-encoding",
      "proxy-authorization",
      "upgrade",
      "expect",
    ])
      headers.delete(k);
    headers.set("Host", url.hostname);
    headers.set("Connection", "close");
    headers.set("Accept-Encoding", "identity");
    if (method === "POST")
      headers.set("Content-Length", String(bytes?.length || 0));
    let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
    head += "\r\n";
    if (encoder.encode(head).length > MAX_HEADERS)
      throw failure("upstream_headers_too_large");
    if (init.signal?.aborted) throw failure("upstream_aborted");
    const connect = connector || (await import("cloudflare:sockets")).connect;
    // The signal may have fired during the module import.
    if (init.signal?.aborted) throw failure("upstream_aborted");
    let socket: UpstreamSocket;
    try {
      socket = connect(
        { hostname: url.hostname, port: 443 },
        { secureTransport: "on", allowHalfOpen: false },
      );
    } catch {
      throw failure();
    }
    void socket.closed.catch(() => {});
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let aborted: ApiError | undefined;
    let done = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let rejectAbort!: (error: ApiError) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    void abortPromise.catch(() => {});
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
      void reader?.cancel().catch(() => {});
      void socket.close().catch(() => {});
    };
    const abort = (code: string) => {
      if (done) return;
      aborted = failure(code);
      rejectAbort(aborted);
      try {
        controller?.error(aborted);
      } catch {
        /* already cancelled */
      }
      cleanup();
    };
    const onAbort = () => abort("upstream_aborted");
    const timer = setTimeout(() => abort("upstream_timeout"), timeoutMs);
    init.signal?.addEventListener("abort", onAbort, { once: true });
    if (init.signal?.aborted) onAbort();
    const wait = <T>(promise: Promise<T>) =>
      Promise.race([promise, abortPromise]);
    let pending = new Uint8Array(0);
    const fill = async () => {
      if (aborted) throw aborted;
      const next = await wait(reader!.read());
      if (next.done) return false;
      const joined = new Uint8Array(pending.length + next.value.length);
      joined.set(pending);
      joined.set(next.value, pending.length);
      pending = joined;
      return true;
    };
    const take = (size: number) => {
      const part = pending.slice(0, size);
      pending = pending.subarray(size);
      return part;
    };
    const line = async (max = MAX_LINE) => {
      for (;;) {
        let end = -1;
        for (let i = 0; i + 1 < pending.length; i++)
          if (pending[i] === 13 && pending[i + 1] === 10) {
            end = i;
            break;
          }
        if (end >= 0) {
          if (end > max) throw failure("invalid_upstream_framing");
          const value = decoder.decode(take(end));
          take(2);
          return value;
        }
        if (pending.length > max || !(await fill()))
          throw failure("invalid_upstream_framing");
      }
    };
    try {
      await wait(socket.opened);
      const writer = socket.writable.getWriter();
      try {
        await wait(writer.write(encoder.encode(head)));
        if (bytes?.length) await wait(writer.write(bytes));
      } finally {
        writer.releaseLock();
      }
      reader = socket.readable.getReader();
      let status = 0;
      let responseHeaders = new Headers();
      let headerBytes = 0;
      for (let informational = 0; informational < 6; informational++) {
        const statusLine = await line();
        headerBytes += statusLine.length + 2;
        const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(
          statusLine,
        );
        if (!match) throw failure("invalid_upstream_framing");
        status = Number(match[1]);
        responseHeaders = new Headers();
        for (;;) {
          const value = await line(MAX_HEADER_LINE);
          headerBytes += value.length + 2;
          if (headerBytes > MAX_HEADERS)
            throw failure("upstream_headers_too_large");
          if (!value) break;
          const split = value.indexOf(":");
          if (
            split < 1 ||
            !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(value.slice(0, split))
          )
            throw failure("invalid_upstream_framing");
          responseHeaders.append(
            value.slice(0, split),
            value.slice(split + 1).trim(),
          );
        }
        if (status >= 200) break;
        if (status === 101 || informational === 5)
          throw failure("invalid_upstream_framing");
      }
      const transfer = responseHeaders.get("transfer-encoding");
      const length = responseHeaders.get("content-length");
      if (
        (transfer && transfer.toLowerCase() !== "chunked") ||
        (transfer && length) ||
        (length !== null &&
          (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
      )
        throw failure("invalid_upstream_framing");
      if (
        method === "HEAD" ||
        status === 204 ||
        status === 205 ||
        status === 304
      ) {
        cleanup();
        return new Response(null, { status, headers: responseHeaders });
      }
      const contentEncoding = (
        responseHeaders.get("content-encoding") || "identity"
      ).toLowerCase();
      if (!["identity", "gzip", "deflate"].includes(contentEncoding))
        throw failure("unsupported_upstream_encoding");
      let remaining = length === null ? null : Number(length);
      if (remaining !== null && remaining > MAX_BODY)
        throw failure("upstream_body_too_large");
      let chunkLeft = 0,
        needsChunkEnd = false,
        total = 0;
      const chunked = transfer !== null;
      responseHeaders.delete("transfer-encoding");
      responseHeaders.delete("connection");
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      let stream = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
          },
          async pull(c) {
            try {
              if (aborted) throw aborted;
              if (chunked) {
                if (needsChunkEnd) {
                  if ((await line()) !== "")
                    throw failure("invalid_upstream_framing");
                  needsChunkEnd = false;
                }
                if (chunkLeft === 0) {
                  const sizeLine = await line();
                  if (!/^[0-9a-f]+(?:;[^\r\n]*)?$/i.test(sizeLine))
                    throw failure("invalid_upstream_framing");
                  chunkLeft = parseInt(sizeLine.split(";")[0], 16);
                  if (
                    !Number.isSafeInteger(chunkLeft) ||
                    chunkLeft + total > MAX_BODY
                  )
                    throw failure("upstream_body_too_large");
                  if (chunkLeft === 0) {
                    // Consume bounded trailers, never expose them as auth headers.
                    let trailerBytes = 0;
                    for (;;) {
                      const t = await line();
                      trailerBytes += t.length + 2;
                      if (trailerBytes > MAX_HEADERS)
                        throw failure("upstream_headers_too_large");
                      if (!t) break;
                    }
                    c.close();
                    cleanup();
                    return;
                  }
                }
              } else if (remaining === 0) {
                c.close();
                cleanup();
                return;
              }
              while (!pending.length) {
                if (!(await fill())) {
                  if (chunked || remaining !== null)
                    throw failure("upstream_truncated");
                  c.close();
                  cleanup();
                  return;
                }
              }
              const size = Math.min(
                pending.length,
                65536,
                chunked ? chunkLeft : (remaining ?? 65536),
              );
              total += size;
              if (total > MAX_BODY) throw failure("upstream_body_too_large");
              const part = take(size);
              if (chunked) {
                chunkLeft -= size;
                needsChunkEnd = chunkLeft === 0;
              } else if (remaining !== null) remaining -= size;
              c.enqueue(part);
            } catch (e) {
              try {
                c.error(aborted || (e instanceof ApiError ? e : failure()));
              } finally {
                cleanup();
              }
            }
          },
          cancel() {
            cleanup();
          },
        },
        { highWaterMark: 0 },
      );
      if (contentEncoding !== "identity")
        stream = stream.pipeThrough(
          new DecompressionStream(contentEncoding as "gzip" | "deflate"),
        );
      return new Response(stream, { status, headers: responseHeaders });
    } catch (e) {
      cleanup();
      throw aborted || (e instanceof ApiError ? e : failure());
    }
  }) as typeof fetch;
}
