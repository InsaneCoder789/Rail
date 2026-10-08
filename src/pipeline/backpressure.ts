import { PipelineError } from "./errors.js";

/** Bounded concurrency and FIFO waiting with reserved slot handoff. */
export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number, private readonly maxQueued = 1024) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 ||
        !Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new Error("invalid_semaphore_capacity");
    this.max = maxConcurrent;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaseOnce();
    }
    if (this.waiters.length >= this.maxQueued) {
      throw new PipelineError("concurrency queue is full", "BACKPRESSURE", true);
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // The active slot remains owned by the waiter until its acquire resumes.
      if (next) next();
      else this.active--;
    };
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
