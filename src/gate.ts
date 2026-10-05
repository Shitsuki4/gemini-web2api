import { ApiError } from "./util";

// A bounded, in-memory FIFO of requests NOT yet submitted upstream. No replay,
// persistent jobs, preemption, or resetting a lock while its owner still runs.
export class AccountGate {
  private active = false;
  private startedAt = 0;
  private waiting: { grant: () => void }[] = [];
  get busy() {
    return this.active;
  }
  snapshot() {
    return {
      busy: this.active,
      busy_since: this.active ? this.startedAt : null,
      queued: this.waiting.length,
    };
  }
  enter() {
    if (this.active)
      throw new ApiError(
        429,
        "account_busy",
        "Account has an active request; wait for it to finish",
        5,
      );
    this.active = true;
    this.startedAt = Math.floor(Date.now() / 1000);
  }
  acquire(
    signal: AbortSignal,
    waitMs: number,
    capacity: number,
  ): Promise<void> {
    if (signal.aborted)
      return Promise.reject(
        new ApiError(
          499,
          "request_cancelled",
          "Request cancelled before submission",
        ),
      );
    if (!this.active) {
      this.enter();
      return Promise.resolve();
    }
    if (waitMs <= 0)
      return Promise.reject(
        new ApiError(
          429,
          "account_busy",
          "Account has an active request; wait for it to finish",
          5,
        ),
      );
    if (this.waiting.length >= capacity)
      return Promise.reject(
        new ApiError(
          429,
          "account_queue_full",
          "Account waiting queue is full; no generation was submitted. Wait for pending requests to finish",
          5,
        ),
      );
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
      };
      const cancel = () => {
        remove();
        reject(
          new ApiError(
            499,
            "request_cancelled",
            "Request cancelled while waiting; no generation was submitted",
          ),
        );
      };
      const entry = {
        grant: () => {
          remove();
          this.enter();
          resolve();
        },
      };
      const timer = setTimeout(() => {
        remove();
        reject(
          new ApiError(
            429,
            "account_queue_timeout",
            "Account remained busy for the queue wait limit; no generation was submitted. Wait for the active request to finish",
            5,
          ),
        );
      }, waitMs);
      this.waiting.push(entry);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  release() {
    this.active = false;
    this.startedAt = 0;
    this.waiting[0]?.grant();
  }
}
