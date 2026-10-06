import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountGate } from "../src/gate";
import { eventStream } from "../src/sse";
afterEach(() => vi.useRealTimers());
describe("bounded account gate", () => {
  it("hands off in FIFO order without an unlocked gap", async () => {
    const gate = new AccountGate(),
      signal = new AbortController().signal,
      order: number[] = [];
    gate.enter();
    const a = gate.acquire(signal, 1000, 4).then(() => order.push(1));
    const b = gate.acquire(signal, 1000, 4).then(() => order.push(2));
    expect(gate.snapshot().queued).toBe(2);
    gate.release();
    expect(gate.busy).toBe(true);
    await a;
    expect(order).toEqual([1]);
    expect(() => gate.enter()).toThrow();
    gate.release();
    await b;
    expect(order).toEqual([1, 2]);
    gate.release();
    expect(gate.snapshot()).toEqual({
      busy: false,
      busy_since: null,
      queued: 0,
    });
  });
  it("caps waiting memory and never releases an active owner on queue timeout", async () => {
    vi.useFakeTimers();
    const gate = new AccountGate(),
      signal = new AbortController().signal;
    gate.enter();
    const waiting = gate.acquire(signal, 100, 1);
    const rejected = expect(waiting).rejects.toMatchObject({
      code: "account_queue_timeout",
    });
    await expect(gate.acquire(signal, 100, 1)).rejects.toMatchObject({
      code: "account_queue_full",
      retryAfter: 5,
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(gate.busy).toBe(true);
    expect(gate.snapshot().queued).toBe(0);
    gate.release();
  });
  it("removes cancelled queued work without submitting it", async () => {
    const gate = new AccountGate(),
      cancel = new AbortController();
    gate.enter();
    const waiting = gate.acquire(cancel.signal, 1000, 4);
    const rejection = expect(waiting).rejects.toMatchObject({
      code: "request_cancelled",
    });
    cancel.abort();
    await rejection;
    expect(gate.snapshot().queued).toBe(0);
    expect(gate.busy).toBe(true);
    gate.release();
    await expect(gate.acquire(cancel.signal, 1000, 4)).rejects.toMatchObject({
      code: "request_cancelled",
    });
    expect(gate.busy).toBe(false);
  });
  it("allows disabling waiting while retaining the active lock", async () => {
    const gate = new AccountGate();
    gate.enter();
    await expect(
      gate.acquire(new AbortController().signal, 0, 4),
    ).rejects.toMatchObject({ code: "account_busy" });
    expect(gate.busy).toBe(true);
    gate.release();
  });
});
describe("SSE lifetime lock release", () => {
  it("releases exactly once when a deadline interrupts an unread SSE write", async () => {
    const deadline = new AbortController(),
      done = vi.fn();
    const stream = eventStream(
      async (sink) => {
        await sink.send({ text: "stalled" });
      },
      done,
      deadline.signal,
    );
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    deadline.abort();
    await stream.done;
    expect(done).toHaveBeenCalledTimes(1);
    await expect(stream.response.text()).rejects.toBeDefined();
  });
  it("keeps cancellation wired through pending close", async () => {
    const deadline = new AbortController(),
      done = vi.fn();
    // The final pending write models a heartbeat racing with successful work.
    const stream = eventStream(
      async (sink) => {
        void sink.comment("pending").catch(() => {});
      },
      done,
      deadline.signal,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(done).not.toHaveBeenCalled();
    deadline.abort();
    await stream.done;
    expect(done).toHaveBeenCalledTimes(1);
    await expect(stream.response.text()).rejects.toBeDefined();
  });
});
