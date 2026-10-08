import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { Semaphore } from "../dist/pipeline/backpressure.js";
import { withRetry } from "../dist/pipeline/retry.js";
import { PipelineError } from "../dist/pipeline/errors.js";

test("queued semaphore waiter retains its slot against a new caller", async () => {
  const semaphore = new Semaphore(1, 2);
  const release = await semaphore.acquire();
  const waiting = semaphore.acquire();
  release();
  release();
  let barged = false;
  const newcomer = semaphore.acquire().then((done) => { barged = true; return done; });
  const releaseWaiting = await waiting;
  assert.equal(barged, false);
  releaseWaiting();
  const releaseNewcomer = await newcomer;
  assert.equal(barged, true);
  releaseNewcomer();
});

test("semaphore rejects excess queued work and invalid capacities", async () => {
  const semaphore = new Semaphore(1, 1);
  const release = await semaphore.acquire();
  const waiting = semaphore.acquire();
  await assert.rejects(semaphore.acquire(), { code: "BACKPRESSURE" });
  release();
  (await waiting)();
  assert.throws(() => new Semaphore(NaN));
  assert.throws(() => new Semaphore(1.5));
});

const policy = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 };
test("pre-aborted retry never invokes work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts++; }, policy, controller.signal), { message: "cancelled" });
  assert.equal(attempts, 0);
});

test("abort during retryable failure prevents another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(withRetry(async () => {
    attempts++;
    controller.abort(new Error("cancelled"));
    throw new PipelineError("transient", "TRANSIENT", true);
  }, policy, controller.signal), { message: "cancelled" });
  assert.equal(attempts, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("successful retry delays clean up abort listeners", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await withRetry(async () => {
    if (++attempts < 4) throw new PipelineError("transient", "TRANSIENT", true);
  }, policy, controller.signal);
  assert.equal(attempts, 4);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(withRetry(async () => {}, { ...policy, maxAttempts: 0 }, controller.signal),
    { message: "INVALID_RETRY_POLICY" });
});
