import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import dotenv from "dotenv";
import { Pool } from "pg";
import { loadServerConfig } from "../dist/server/config.js";
import { SlidingWindowRateLimiter, RequestError, applyCors } from "../dist/server/http.js";
import { handlePaymentRoutes } from "../dist/server/routes/paymentRoutes.js";
import { handleEventRoutes } from "../dist/server/routes/eventRoutes.js";
import { handleAgentRoutes } from "../dist/server/routes/agentRoutes.js";
import { handleAuthRoutes } from "../dist/server/routes/authRoutes.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";
import { runMigrations } from "../dist/persistence/migrate.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;

test("allowed frontends can read quota and retry headers without widening CORS origins", () => {
  const headers = {};
  const res = { setHeader(key, value) { headers[key] = value; } };
  applyCors({ headers: { origin: "https://frontend.example" } }, res, ["https://frontend.example"]);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://frontend.example");
  assert.equal(headers["Access-Control-Expose-Headers"], "X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After");
  const denied = {};
  applyCors({ headers: { origin: "https://untrusted.example" } }, { setHeader(key, value) { denied[key] = value; } }, ["https://frontend.example"]);
  assert.equal(denied["Access-Control-Allow-Origin"], undefined);
  assert.equal(denied["Access-Control-Expose-Headers"], undefined);
});
const paymentPaths = ["/v1/payments/authorize", "/v1/payments/execute",
  "/v1/offline/tokens/issue", "/v1/sync/transactions",
  "/v1/payments/short/risk", "/v1/payments/short/evidence"];

function fixture(rateLimiter = new SlidingWindowRateLimiter()) {
  const config = loadServerConfig();
  const calls = { auth: 0, work: 0 };
  const context = { rateLimiter, config: { ...config, disableSse: false, agentApiOrigin: "http://localhost",
    rateLimits: { ...config.rateLimits, authorizeMax: 2, executeMax: 2, tokenIssueMax: 2, syncMax: 2, loginMax: 2 } },
    authResolver: {
      async resolveAuthenticatedWallet(req) { calls.auth++; if (req.headers.authorization === "bad") throw new RequestError(401, "unauthorized", "invalid"); return req.headers.authorization; },
      async resolveOwnerWallet(req) { calls.auth++; if (req.headers.authorization === "bad") throw new RequestError(401, "unauthorized", "invalid"); return req.headers.authorization; },
      requireApiKey(req) { calls.auth++; if (req.headers.authorization === "bad") throw new RequestError(401, "unauthorized", "invalid"); return true; },
    },
    agentProofs: { async authenticate(token) { calls.auth++; if (!token) throw new RequestError(401, "unauthorized", "invalid"); return { agentId: "trusted_agent" }; } },
    agentStore: { async resolveCredential(token) { calls.auth++; if (!token) throw new RequestError(401, "unauthorized", "invalid"); return { agentId: "trusted_agent" }; },
      async createIntent() { calls.work++; return {}; }, async listAgents() { calls.work++; return []; }, async listAgentIntents() { calls.work++; return []; } },
    eventStore: { async listVisibleEvents() { calls.work++; return []; } },
    engine: { async execute() { calls.work++; throw new Error("unexpected_payment_work"); } },
    offlineTokenStore: { async issue() { calls.work++; throw new Error("unexpected_token_work"); } },
  };
  return { context, calls };
}

async function request(handler, path, context, { ip = "192.0.2.1", identity = "wallet_owner", body = "{", contentType = "application/json" } = {}) {
  const req = Readable.from([body]);
  req.method = path.includes("/short/") || path === "/v1/events" || path === "/v1/events/stream" || path === "/v2/agents" || path === "/v2/agent/identity" ? "GET" : "POST";
  req.url = path;
  req.headers = { authorization: identity, "content-type": contentType };
  req.socket = { remoteAddress: ip };
  const headers = {};
  const res = { status: 200, setHeader(key, value) { headers[key] = value; },
    writeHead(status) { this.status = status; }, end() {} };
  try { await handler(req, res, new URL(`http://local${path}`), context); }
  catch (error) { if (!(error instanceof RequestError)) throw error; res.status = error.status; }
  return { status: res.status, headers };
}

for (const path of paymentPaths) {
  test(`independent payment quotas resist IP and payload rotation: ${path}`, async () => {
    const { context, calls } = fixture();
    const limit = path.includes("/short/") ? 30 : 2;
    for (let i = 0; i < limit; i++) {
      const result = await request(handlePaymentRoutes, path, context, { ip: `192.0.2.${i + 1}`,
        body: JSON.stringify({ walletId: `wallet_${i}`, deviceId: `device_${i}` }) });
      assert.ok([400, 422].includes(result.status));
    }
    const blocked = await request(handlePaymentRoutes, path, context, { ip: "198.51.100.1" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers["X-RateLimit-Remaining"], "0");
    assert.ok(Number(blocked.headers["Retry-After"]) > 0);
    assert.equal(calls.work, 0);
  });
  test(`payment source quotas reject invalid credentials before authentication: ${path}`, async () => {
    const { context, calls } = fixture();
    const limit = path.includes("/short/") ? 30 : 2;
    for (let i = 0; i < limit; i++) assert.equal((await request(handlePaymentRoutes, path, context, { identity: "bad" })).status, 401);
    assert.equal((await request(handlePaymentRoutes, path, context, { identity: "other_owner" })).status, 429);
    assert.equal(calls.auth, limit);
    assert.equal(calls.work, 0);
  });
}

test("event polling wallet quota survives IP rotation and source quotas precede auth", async () => {
  const { context, calls } = fixture();
  for (let i = 0; i < 60; i++) assert.equal((await request(handleEventRoutes, "/v1/events", context, { ip: `192.0.2.${i + 1}` })).status, 200);
  assert.equal((await request(handleEventRoutes, "/v1/events", context, { ip: "198.51.100.1" })).status, 429);
  assert.equal(calls.work, 60);
  const invalid = fixture();
  for (let i = 0; i < 60; i++) assert.equal((await request(handleEventRoutes, "/v1/events", invalid.context, { identity: "bad" })).status, 401);
  assert.equal((await request(handleEventRoutes, "/v1/events", invalid.context)).status, 429);
  assert.equal(invalid.calls.auth, 60);
});

test("event stream source limits apply even when serverless streaming is unavailable", async () => {
  const { context, calls } = fixture(); context.config.disableSse = true;
  for (let i = 0; i < 6; i++) assert.equal((await request(handleEventRoutes, "/v1/events/stream", context)).status, 501);
  assert.equal((await request(handleEventRoutes, "/v1/events/stream", context)).status, 429);
  assert.equal(calls.auth, 0);
});

test("registration and login malformed bodies and content types consume source quotas", async () => {
  for (const path of ["/auth/register", "/auth/login"]) {
    const { context } = fixture();
    assert.equal((await request(handleAuthRoutes, path, context)).status, 400);
    assert.equal((await request(handleAuthRoutes, path, context, { contentType: "text/plain" })).status, 415);
    assert.equal((await request(handleAuthRoutes, path, context)).status, 429);
  }
});

test("logout invalid credentials cannot bypass source quotas", async () => {
  const { context } = fixture();
  for (let i = 0; i < 2; i++) assert.equal((await request(handleAuthRoutes, "/auth/logout-all", context, { identity: "bad" })).status, 401);
  assert.equal((await request(handleAuthRoutes, "/auth/logout-all", context)).status, 429);
});

test("agent owner and credential identity quotas are independent of source IP", async () => {
  for (const [path, limit, identity] of [["/v2/agents", 20, "wallet_owner"],
    ["/v2/agent/intents", 20, `DPoP rail_agent_${"a".repeat(43)}`],
    ["/v2/agent/identity", 20, `DPoP rail_agent_${"a".repeat(43)}`]]) {
    const { context } = fixture();
    for (let i = 0; i < limit; i++) assert.notEqual((await request(handleAgentRoutes, path, context, { identity, body: "{}", ip: `192.0.2.${i + 1}` })).status, 429);
    const blocked = await request(handleAgentRoutes, path, context, { identity, body: "{}", ip: "198.51.100.1" });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["Retry-After"]) > 0);
  }
});

test("agent management source quota bounds invalid owner resolution", async () => {
  const { context, calls } = fixture();
  for (let i = 0; i < 30; i++) assert.equal((await request(handleAgentRoutes, "/v2/agents", context, { identity: "bad" })).status, 401);
  assert.equal((await request(handleAgentRoutes, "/v2/agents", context)).status, 429);
  assert.equal(calls.auth, 30);
});

test("PostgreSQL quota validation rejects unsafe inputs before connecting", async () => {
  const limiter = new PostgresRateLimiter({ connect() { throw new Error("unexpected_connection"); } });
  for (const [key, limit, window] of [["", 1, 1], ["x".repeat(1025), 1, 1], ["x", 0, 1], ["x", 1.5, 1],
    ["x", 2147483648, 1], ["x", 1, NaN], ["x", 1, 2147483648]]) {
    await assert.rejects(limiter.consume(key, limit, window), /invalid_rate_limit_parameters/);
  }
});

test("PostgreSQL quota failures set SQL deadlines and discard clients after failed rollback", async () => {
  const statements = [];
  const client = new EventEmitter();
  let discarded;
  client.query = async sql => {
    statements.push(sql);
    if (sql.includes("INSERT INTO") || sql === "ROLLBACK") throw new Error("database_unavailable");
    return { rows: [] };
  };
  client.release = value => { discarded = value; };
  const limiter = new PostgresRateLimiter({ async connect() { return client; } });
  await assert.rejects(limiter.consume("valid_bucket", 2, 60_000), /database_unavailable/);
  assert.equal(discarded, true);
  assert.ok(statements.includes("SET LOCAL lock_timeout = '5s'"));
  assert.ok(statements.includes("SET LOCAL statement_timeout = '15s'"));
  assert.equal(client.listenerCount("error"), 0);
});

test("real PostgreSQL route quotas remain shared across instances and application clock skew", { skip: !databaseUrl }, async () => {
  const schema = `ci_quota_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await runMigrations(pool);
    const first = fixture(new PostgresRateLimiter(pool)), second = fixture(new PostgresRateLimiter(pool));
    const paths = ["/v1/payments/authorize", "/v1/payments/execute", "/v1/offline/tokens/issue", "/v1/sync/transactions"];
    for (const path of paths) {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => request(handlePaymentRoutes, path,
        i % 2 ? first.context : second.context, { ip: `192.0.2.${i + 1}`, body: JSON.stringify({ deviceId: `device_${i}`, walletId: `wallet_${i}` }) })));
      assert.equal(results.filter(item => item.status === 422).length, 2);
      assert.equal(results.filter(item => item.status === 429).length, 6);
    }
    const limiter = new PostgresRateLimiter(pool);
    await limiter.consume("clock_test", 1, 60_000);
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 86_400_000;
      assert.equal((await limiter.consume("clock_test", 1, 60_000)).remaining, 0);
      assert.ok((await limiter.consume("clock_test", 1, 60_000)).retryAfterSeconds > 0);
    } finally { Date.now = originalNow; }
    await pool.query("UPDATE rail_rate_limit_buckets SET window_started_at = clock_timestamp() - interval '2 minutes' WHERE bucket_key = 'clock_test'");
    assert.equal((await limiter.consume("clock_test", 1, 60_000)).retryAfterSeconds, 0);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
