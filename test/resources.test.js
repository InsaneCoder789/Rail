import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough, Readable } from "node:stream";
import { once } from "node:events";
import { readJsonBody, SlidingWindowRateLimiter } from "../dist/server/http.js";
import { loadServerConfig } from "../dist/server/config.js";
import { handleRequest } from "../dist/server/server.js";
import { MemoryIdempotencyStore } from "../dist/pipeline/idempotency.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";

test("body parsing enforces deadlines and cleans up listeners", async () => {
  const req = new PassThrough();
  req.write("{");
  await assert.rejects(readJsonBody(req, 100, 20), { status: 408, code: "body_timeout" });
  for (const name of ["data", "end", "error", "close", "aborted"]) assert.equal(req.listenerCount(name), 0);
  assert.equal(req.destroyed, false);
  req.destroy();
});

test("interrupted request bodies reject rather than waiting for the deadline", async () => {
  const req = new PassThrough();
  const pending = readJsonBody(req, 100, 1000);
  req.emit("aborted");
  await assert.rejects(pending, { code: "request_aborted" });
  req.destroy();
  assert.equal(await readJsonBody(Readable.from(["{}"]), 2), "{}");
});

async function requestAgainstServer(write, limits) {
  const config = { ...loadServerConfig(), ...limits };
  const context = { config, eventStore: { emitSystemError() {} } };
  const server = http.createServer((req, res) => { void handleRequest(req, res, context); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: server.address().port, method: "POST",
        path: "/auth/login", agent: false, headers: { "content-type": "application/json" } }, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }));
        response.on("error", reject);
      });
      request.setTimeout(2000, () => request.destroy(new Error("test request timed out")));
      request.on("error", reject);
      write(request);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test("oversized HTTP bodies receive a complete 413 JSON response before disconnect", async () => {
  const result = await requestAgainstServer(request => request.end(JSON.stringify({ data: "x".repeat(1000) })), { maxRequestBodyBytes: 64 });
  assert.equal(result.status, 413);
  assert.equal(result.body.error, "payload_too_large");
  assert.equal(result.headers.connection, "close");
});

test("stalled HTTP bodies receive a complete 408 JSON response", async () => {
  const result = await requestAgainstServer(request => request.write("{"), { requestBodyTimeoutMs: 30 });
  assert.equal(result.status, 408);
  assert.equal(result.body.error, "body_timeout");
  assert.equal(result.headers.connection, "close");
});

test("memory replay capacity fails closed without evicting successful or inflight payments", async () => {
  const store = new MemoryIdempotencyStore(1);
  let finish;
  const first = store.dedupe("first", "first_fp", () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  await assert.rejects(store.dedupe("second", "second_fp", async () => ({ status: "accepted" })), { code: "MEMORY_IDEMPOTENCY_CAPACITY" });
  finish({ status: "accepted" });
  const result = await first;
  result.status = "rejected";
  const replay = store.getCompleted("first");
  replay.status = "rejected";
  assert.equal((await store.dedupe("first", "first_fp", () => { throw new Error("must not run"); })).status, "accepted");
  await assert.rejects(store.dedupe("second", "second_fp", async () => ({ status: "accepted" })), { code: "MEMORY_IDEMPOTENCY_CAPACITY" });
});

test("synchronous idempotency failures release capacity and permit retries", async () => {
  const store = new MemoryIdempotencyStore(1);
  await assert.rejects(store.dedupe("first", "fp", () => { throw new Error("synchronous_failure"); }), /synchronous_failure/);
  assert.equal((await store.dedupe("first", "fp", async () => ({ status: "accepted" }))).status, "accepted");
});

test("memory diagnostic dead letters stay bounded and cannot be mutated through snapshots", () => {
  const queue = new MemoryDeadLetterQueue(2);
  for (let i = 0; i < 3; i++) queue.push({ idempotencyKey: String(i), txId: String(i), error: "failure" });
  assert.deepEqual(queue.snapshot().map(item => item.txId), ["1", "2"]);
  queue.snapshot()[0].error = "modified";
  assert.equal(queue.snapshot()[0].error, "failure");
  assert.throws(() => new MemoryDeadLetterQueue(0), /invalid_dlq_capacity/);
});

test("memory quota capacity denies new identities without erasing existing limits", async () => {
  const limiter = new SlidingWindowRateLimiter(1);
  assert.equal(limiter.consume("first", 1, 50).retryAfterSeconds, 0);
  assert.equal(limiter.consume("second", 1, 50).remaining, 0);
  assert.ok(limiter.consume("first", 1, 50).retryAfterSeconds > 0);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(limiter.consume("second", 1, 50).retryAfterSeconds, 0);
  assert.throws(() => limiter.consume("invalid", Infinity, 50), /invalid_rate_limit_policy/);
});
