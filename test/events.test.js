import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createEventStore } from "../dist/server/events.js";
import { handleEventRoutes } from "../dist/server/routes/eventRoutes.js";
import { SlidingWindowRateLimiter } from "../dist/server/http.js";

function fixture(store, writeResult = true) {
  const req = { method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  const res = new EventEmitter();
  res.messages = [];
  res.setHeader = () => {};
  res.writeHead = status => { res.status = status; res.headersSent = true; };
  res.write = data => { res.messages.push(data); return writeResult; };
  res.end = data => { if (data) res.messages.push(data); res.writableEnded = true; res.emit("close"); };
  const context = {
    config: { disableSse: false, allowedOrigins: [], trustProxyHeaders: false },
    eventStore: store, rateLimiter: new SlidingWindowRateLimiter(),
    authResolver: { async resolveAuthenticatedWallet() { return "wallet_test"; } },
  };
  return { req, res, context };
}

test("event writes propagate persistence failures and never fall back to volatile history", async () => {
  const failure = new Error("database_unavailable");
  const store = createEventStore(() => ({ async query() { throw failure; } }));
  await assert.rejects(store.insertOutboxEvent({ type: "payment.accepted", payload: {} }), failure);
  await assert.rejects(store.listVisibleEvents({ walletId: "wallet_test" }), failure);
  await assert.rejects(createEventStore(() => null).listVisibleEvents({ walletId: "wallet_test" }), { code: "event_store_unavailable" });
});

test("event pagination rejects malformed and oversized query values", async () => {
  const store = createEventStore(() => { throw new Error("should_not_query"); });
  for (const limit of [0, 101, NaN, Infinity, 1.5]) {
    await assert.rejects(store.listVisibleEvents({ walletId: "wallet_test" }, limit), { code: "invalid_event_limit" });
  }
  for (const cursor of ["", "0", "01", "-1", "1.5", "9223372036854775808", "1;DELETE FROM outbox"]) {
    await assert.rejects(store.listVisibleEvents({ walletId: "wallet_test" }, 20, cursor), { code: "invalid_event_cursor" });
  }
});

test("stream admission caps each wallet and frees slots on disconnect", () => {
  const store = createEventStore(() => null);
  const first = { viewer: { walletId: "wallet_test" } };
  const second = { viewer: { walletId: "wallet_test" } };
  const third = { viewer: { walletId: "wallet_test" } };
  assert.equal(store.addSseClient(first), true);
  assert.equal(store.addSseClient(second), true);
  assert.equal(store.addSseClient(third), false);
  store.removeSseClient(first);
  assert.equal(store.addSseClient(third), true);
  for (let i = 0; i < 62; i++) assert.equal(store.addSseClient({ viewer: { walletId: `other_${i}` } }), true);
  assert.equal(store.addSseClient({ viewer: { walletId: "over_capacity" } }), false);
});

test("initial SSE read failures release admission before sending headers", async () => {
  const store = createEventStore(() => ({ async query() { throw new Error("read_failed"); } }));
  for (let i = 0; i < 3; i++) {
    const { req, res, context } = fixture(store);
    await assert.rejects(handleEventRoutes(req, res, new URL("http://local/v1/events/stream"), context), /read_failed/);
    assert.equal(res.headersSent, undefined);
    assert.equal(res.listenerCount("close"), 0);
  }
});

test("slow SSE consumers close without accumulating a live stream", async () => {
  const store = createEventStore(() => ({ async query() { return { rows: [] }; } }));
  for (let i = 0; i < 3; i++) {
    const { req, res, context } = fixture(store, false);
    assert.equal(await handleEventRoutes(req, res, new URL("http://local/v1/events/stream"), context), true);
    assert.equal(res.writableEnded, true);
    assert.equal(res.listenerCount("close"), 0);
    assert.equal(res.listenerCount("error"), 0);
  }
});

test("SSE polls committed events and closes on a later credential failure", async () => {
  let queries = 0;
  const store = createEventStore(() => ({ async query() {
    queries++;
    return { rows: [{ id: String(queries), type: "payment.accepted", payload: { walletId: "wallet_test" }, occurred_at: new Date() }] };
  } }));
  const { req, res, context } = fixture(store);
  let authChecks = 0;
  context.authResolver.resolveAuthenticatedWallet = async () => {
    if (++authChecks >= 3) throw new Error("credentials_revoked");
    return "wallet_test";
  };
  let timeout;
  try {
    const closed = new Promise((resolve, reject) => {
      res.once("close", resolve);
      timeout = setTimeout(() => reject(new Error("stream did not close after revoked credentials")), 8000);
    });
    await handleEventRoutes(req, res, new URL("http://local/v1/events/stream"), context);
    await closed;
    assert.equal(queries, 2);
    assert.ok(res.messages.some(message => message.startsWith("id: 2\n")));
    assert.equal(res.writableEnded, true);
    assert.equal(res.listenerCount("close"), 0);
  } finally { clearTimeout(timeout); res.end(); }
});

test("REST event history passes the cursor and returns a stable next-page boundary", async () => {
  const store = { async listVisibleEvents(viewer, limit, before) {
    assert.equal(viewer.walletId, "wallet_test");
    assert.equal(limit, 1);
    assert.equal(before, "5");
    return [{ id: "4", type: "payment.accepted", payload: {} }];
  } };
  const { req, res, context } = fixture(store);
  await handleEventRoutes(req, res, new URL("http://local/v1/events?limit=1&before=5"), context);
  assert.equal(JSON.parse(res.messages[0]).nextBefore, "4");
});
