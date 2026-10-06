import { ApiError } from "./util";
export interface EventSink {
  send: (data: unknown, event?: string) => Promise<void>;
  comment: (text: string) => Promise<void>;
}
export function eventStream(
  run: (sink: EventSink, signal: AbortSignal) => Promise<void>,
  onDone: () => void,
  requestSignal: AbortSignal,
) {
  const abort = new AbortController();
  let streamController!: TransformStreamDefaultController<Uint8Array>;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const writer = transform.writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;
  const cancel = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    const reason = new DOMException("Aborted", "AbortError");
    // writer.abort alone may wait behind an in-flight transform/queued close.
    // Error both stream sides synchronously to unblock backpressured writes.
    streamController.error(reason);
    void writer.abort(reason).catch(() => {});
  };
  if (requestSignal.aborted) cancel();
  else requestSignal.addEventListener("abort", cancel, { once: true });
  writer.closed.catch(cancel);
  const write = (s: string) => writer.write(encoder.encode(s));
  const sink: EventSink = {
    send: (data, event) =>
      write(
        (event ? `event: ${event}\n` : "") +
          `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
      ),
    comment: (text) => write(`: ${text}\n\n`),
  };
  // Only one heartbeat write may be outstanding; a slow client cannot grow an unbounded queue.
  let heartbeatPending = false;
  const timer = setInterval(() => {
    if (closed || heartbeatPending) return;
    heartbeatPending = true;
    sink
      .comment("ping")
      .catch(cancel)
      .finally(() => (heartbeatPending = false));
  }, 10000);
  const done = (async () => {
    try {
      await run(sink, abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) {
        const error =
          e instanceof ApiError
            ? e
            : new ApiError(502, "upstream_error", "Upstream stream failed");
        await sink
          .send(
            {
              error: {
                message: error.message,
                type: "api_error",
                code: error.code,
              },
            },
            "error",
          )
          .catch(() => {});
      }
    } finally {
      closed = true;
      clearInterval(timer);
      try {
        // Keep cancellation/deadline wired until pending downstream writes and
        // close settle; otherwise an unread response can hold the account lock.
        await writer.close().catch(() => {});
      } finally {
        requestSignal.removeEventListener("abort", cancel);
        onDone();
      }
    }
  })();
  return {
    done,
    response: new Response(transform.readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    }),
  };
}
