import { isRetryable } from "./errors.js";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 25,
  maxDelayMs: 750,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number, policy: RetryPolicy): number {
  const raw = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * policy.baseDelayMs);
  return Math.min(policy.maxDelayMs, raw + jitter);
}

export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 ||
      !Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0 ||
      !Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error("INVALID_RETRY_POLICY");
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    signal.throwIfAborted();
    try {
      return await fn(attempt, signal);
    } catch (err) {
      lastErr = err;
      if (attempt === policy.maxAttempts) throw err;
      if (!isRetryable(err)) throw err;
      await sleep(backoffMs(attempt, policy), signal);
    }
  }
  throw lastErr;
}
