import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { Pool } from "pg";
import { AgentAuthorityStore, parseMandateInput } from "../dist/persistence/agentAuthority.js";
import { runMigrations, ensureOutboxSchema } from "../dist/persistence/migrate.js";
import { createAuthResolver } from "../dist/server/authentication.js";
import { generateToken } from "../dist/auth/jwt.js";
import { handleAgentRoutes } from "../dist/server/routes/agentRoutes.js";
import { loadServerConfig } from "../dist/server/config.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
const policy = { mode: "budgeted", currency: "INR", perPaymentLimitMinor: 100, totalBudgetMinor: 1000,
  allowedReceiverWalletIds: ["agent_receiver"], ttlSeconds: 3600 };

async function fixture(work) {
  const schema = `ci_agents_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret || "agent_test_jwt_secret_01234567890123456789";
  try {
    await runMigrations(pool);
    await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO wallets(wallet_id, balance) VALUES ('agent_owner', 10000), ('other_owner', 10000), ('agent_receiver', 0)");
    await pool.query("INSERT INTO users(user_id, password_hash, wallet_id) VALUES ('agent_user', 'unused_fixture_hash', 'agent_owner')");
    await work({ pool, store: new AgentAuthorityStore(pool), owner: "agent_owner", other: "other_owner", token: generateToken("agent_user") });
  } finally {
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test("mandate parsing rejects malformed modes, money, TTL and recipient lists", () => {
  assert.deepEqual(parseMandateInput(policy), policy);
  assert.equal(parseMandateInput({ ...policy, mode: "approval_required" }).mode, "approval_required");
  for (const input of [null, [], { ...policy, mode: { toString: "bad" } }, { ...policy, mode: "unrestricted" },
    { ...policy, perPaymentLimitMinor: NaN }, { ...policy, totalBudgetMinor: 1 }, { ...policy, totalBudgetMinor: 1e12 + 1 },
    { ...policy, ttlSeconds: 0 }, { ...policy, ttlSeconds: Infinity }, { ...policy, ttlSeconds: 2592001 },
    { ...policy, currency: "usd" }, { ...policy, allowedReceiverWalletIds: [] },
    { ...policy, allowedReceiverWalletIds: ["agent_receiver", "agent_receiver"] }, { ...policy, allowedReceiverWalletIds: [null] }]) {
    assert.throws(() => parseMandateInput(input), { status: 422, code: "invalid_agent_request" });
  }
});

test("agent credentials are hashed, narrowly scoped, returned once and excluded from audit metadata", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const agent = await store.createAgent(owner, { name: "Invoice assistant" });
    const credential = await store.issueCredential(owner, agent.agentId, { ttlSeconds: 3600 });
    assert.match(credential.token, /^rail_agent_[A-Za-z0-9_-]{43}$/);
    assert.equal(credential.scope, "payments:propose");
    assert.equal(credential.executionEnabled, false);
    const persisted = (await pool.query("SELECT * FROM rail_agent_credentials")).rows[0];
    assert.equal(persisted.token_hash, createHash("sha256").update(credential.token).digest("hex"));
    assert.ok(!JSON.stringify(persisted).includes(credential.token));
    const identity = await store.resolveCredential(credential.token);
    assert.equal(identity.agentId, agent.agentId);
    assert.equal(identity.executionEnabled, false);
    assert.ok(!("token" in identity) && !("tokenHash" in identity));
    const metadata = await store.listCredentials(owner, agent.agentId);
    assert.equal(metadata[0].credentialId, credential.credentialId);
    assert.ok(!JSON.stringify(metadata).includes(credential.token));
    assert.ok(!JSON.stringify((await pool.query("SELECT payload FROM outbox")).rows).includes(credential.token));
    await assert.rejects(store.issueCredential(owner, agent.agentId, { scope: "payments:execute" }), { status: 422 });
    const resolver = createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] });
    await assert.rejects(resolver.resolveAuthenticatedWallet({ headers: { authorization: `Bearer ${credential.token}` } }), { status: 401 });
    await assert.rejects(resolver.resolveOwnerWallet({ headers: { "x-rail-api-key": credential.token } }), { status: 401 });
  });
});

test("owners cannot inspect, issue, revoke or attach mandates to another owner's agent", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner, other }) => {
    const agent = await store.createAgent(owner, { name: "Private agent" });
    const credential = await store.issueCredential(owner, agent.agentId, {});
    const mandate = await store.createMandate(owner, agent.agentId, policy);
    assert.deepEqual(await store.listAgents(other), []);
    for (const call of [() => store.issueCredential(other, agent.agentId, {}), () => store.listCredentials(other, agent.agentId),
      () => store.revokeCredential(other, agent.agentId, credential.credentialId), () => store.revokeAgent(other, agent.agentId),
      () => store.createMandate(other, agent.agentId, policy), () => store.listMandates(other, agent.agentId),
      () => store.revokeMandate(other, agent.agentId, mandate.mandateId)]) {
      await assert.rejects(call(), { status: 404, code: "agent_not_found" });
    }
    assert.equal((await store.resolveCredential(credential.token)).agentId, agent.agentId);
  });
});

test("credential revocation and database-clock expiry immediately invalidate subsequent authentication", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const agent = await store.createAgent(owner, { name: "Revocation test" });
    const first = await store.issueCredential(owner, agent.agentId, {});
    await store.revokeCredential(owner, agent.agentId, first.credentialId);
    const before = (await store.listCredentials(owner, agent.agentId))[0].revokedAt;
    await store.revokeCredential(owner, agent.agentId, first.credentialId);
    assert.equal((await store.listCredentials(owner, agent.agentId))[0].revokedAt, before);
    await assert.rejects(store.resolveCredential(first.token), { status: 401 });
    const second = await store.issueCredential(owner, agent.agentId, {});
    await pool.query("UPDATE rail_agent_credentials SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE credential_id = $1", [second.credentialId]);
    await assert.rejects(store.resolveCredential(second.token), { status: 401 });
    for (const token of [undefined, "bad", first.token + "\n"]) await assert.rejects(store.resolveCredential(token), { status: 401 });
  });
});

test("agent revocation serializes against issuance and cascades credential and mandate revocation", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const agent = await store.createAgent(owner, { name: "Concurrent revoke" });
    const credential = await store.issueCredential(owner, agent.agentId, {});
    const mandate = await store.createMandate(owner, agent.agentId, policy);
    const outcomes = await Promise.allSettled([store.issueCredential(owner, agent.agentId, {}), store.revokeAgent(owner, agent.agentId)]);
    assert.equal(outcomes[1].status, "fulfilled");
    if (outcomes[0].status === "fulfilled") await assert.rejects(store.resolveCredential(outcomes[0].value.token), { status: 401 });
    await assert.rejects(store.resolveCredential(credential.token), { status: 401 });
    await assert.rejects(store.issueCredential(owner, agent.agentId, {}), { status: 409, code: "agent_revoked" });
    await assert.rejects(store.createMandate(owner, agent.agentId, policy), { status: 409 });
    assert.equal((await store.listMandates(owner, agent.agentId))[0].status, "revoked");
    const row = (await pool.query("SELECT * FROM rail_agent_mandates WHERE mandate_id = $1", [mandate.mandateId])).rows[0];
    assert.ok(row.revoked_at);
    const repeated = await store.revokeAgent(owner, agent.agentId);
    assert.equal(repeated.status, "revoked");
  });
});

test("mandates bind valid receivers, owner currency, approval mode and bounded budgets without moving funds", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const wallets = () => pool.query("SELECT wallet_id, balance, reserved FROM wallets ORDER BY wallet_id");
    const before = (await wallets()).rows;
    const agent = await store.createAgent(owner, { name: "Budget policy" });
    for (const mode of ["budgeted", "approval_required"]) {
      const mandate = await store.createMandate(owner, agent.agentId, { ...policy, mode });
      assert.equal(mandate.mode, mode);
      assert.equal(mandate.executionEnabled, false);
      assert.equal(mandate.totalBudgetMinor, 1000);
    }
    for (const value of [{ ...policy, currency: "USD" }, { ...policy, allowedReceiverWalletIds: [owner] },
      { ...policy, allowedReceiverWalletIds: ["missing_wallet"] }]) await assert.rejects(store.createMandate(owner, agent.agentId, value), { status: 422 });
    const mandates = await store.listMandates(owner, agent.agentId);
    await pool.query("UPDATE rail_agent_mandates SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE mandate_id = $1", [mandates[0].mandateId]);
    assert.equal((await store.listMandates(owner, agent.agentId)).find(item => item.mandateId === mandates[0].mandateId).status, "expired");
    assert.equal((await store.revokeMandate(owner, agent.agentId, mandates[1].mandateId)).status, "revoked");
    assert.deepEqual((await wallets()).rows, before);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM authorizations")).rowCount, 0);
  });
});

test("control changes roll back when their durable audit event cannot be stored", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    await pool.query(`CREATE FUNCTION fail_agent_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type LIKE 'agent.%' THEN RAISE EXCEPTION 'injected_agent_audit_failure'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER fail_agent_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_agent_audit()");
    await assert.rejects(store.createAgent(owner, { name: "Will roll back" }), /injected_agent_audit_failure/);
    assert.deepEqual(await store.listAgents(owner), []);
    await pool.query("DROP TRIGGER fail_agent_audit ON outbox");
    const agent = await store.createAgent(owner, { name: "Retry succeeds" });
    await pool.query("CREATE TRIGGER fail_agent_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_agent_audit()");
    await assert.rejects(store.issueCredential(owner, agent.agentId, {}), /injected_agent_audit_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 0);
    await assert.rejects(store.revokeAgent(owner, agent.agentId), /injected_agent_audit_failure/);
    assert.equal((await store.listAgents(owner))[0].status, "active");
  });
});

test("concurrent agent creation cannot bypass the owner lifetime capacity", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const outcomes = await Promise.allSettled(Array.from({ length: 55 }, (_, i) => store.createAgent(owner, { name: `Agent ${i}` })));
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 50);
    assert.ok(outcomes.filter(result => result.status === "rejected").every(result => result.reason.code === "agent_capacity"));
    assert.equal((await pool.query("SELECT * FROM rail_agents WHERE owner_wallet_id = $1", [owner])).rowCount, 50);
  });
});

test("credential and mandate capacities bound retained control-plane records", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const agent = await store.createAgent(owner, { name: "Capacity agent" });
    await pool.query(`INSERT INTO rail_agent_credentials(credential_id, agent_id, token_hash, scope, created_at, expires_at)
      SELECT gen_random_uuid(), $1, md5(i::text) || md5(i::text), 'payments:propose', now(), now() + interval '1 day' FROM generate_series(1,100) i`, [agent.agentId]);
    await assert.rejects(store.issueCredential(owner, agent.agentId, {}), { status: 409, code: "credential_capacity" });
    await pool.query(`INSERT INTO rail_agent_mandates(mandate_id, agent_id, owner_wallet_id, mode, currency, per_payment_limit_minor,
      total_budget_minor, allowed_receiver_wallet_ids, created_at, expires_at)
      SELECT gen_random_uuid(), $1, $2, 'budgeted', 'INR', 100, 1000, ARRAY['agent_receiver'], now(), now() + interval '1 day'
      FROM generate_series(1,100)`, [agent.agentId, owner]);
    await assert.rejects(store.createMandate(owner, agent.agentId, policy), { status: 409, code: "mandate_capacity" });
  });
});

test("owner endpoints use JWT-only authority and an IP-independent shared management quota", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, token }) => {
    const context = { config: loadServerConfig(), agentStore: store, rateLimiter: new PostgresRateLimiter(pool),
      authResolver: createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] }) };
    let ip = 0;
    const call = async (method, path, body, authorization = `Bearer ${token}`, extra = {}) => {
      const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
      req.method = method;
      req.headers = { authorization, "content-type": "application/json", ...extra };
      req.socket = { remoteAddress: `192.0.2.${++ip}` };
      const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      assert.equal(await handleAgentRoutes(req, res, new URL(`http://localhost${path}`), context), true);
      return res;
    };
    const agent = (await call("POST", "/v2/agents", { name: "API agent" })).body.agent;
    const credential = (await call("POST", `/v2/agents/${agent.agentId}/credentials`, {})).body.credential;
    const mandate = (await call("POST", `/v2/agents/${agent.agentId}/mandates`, policy)).body.mandate;
    assert.equal((await call("GET", "/v2/agent/identity", undefined, `Bearer ${credential.token}`)).body.identity.executionEnabled, false);
    assert.equal((await call("GET", `/v2/agents/${agent.agentId}/credentials`)).body.credentials.length, 1);
    assert.equal((await call("GET", `/v2/agents/${agent.agentId}/mandates`)).body.mandates.length, 1);
    await call("POST", `/v2/agents/${agent.agentId}/mandates/${mandate.mandateId}/revoke`, {});
    await call("POST", `/v2/agents/${agent.agentId}/credentials/${credential.credentialId}/revoke`, {});
    await assert.rejects(call("GET", "/v2/agent/identity", undefined, `Bearer ${credential.token}`), { status: 401 });
    await assert.rejects(call("GET", "/v2/agents", undefined, `Bearer ${credential.token}`), { status: 401 });
    await assert.rejects(call("GET", "/v2/agents", undefined, undefined, { authorization: undefined, "x-rail-api-key": credential.token }), { status: 401 });
    // Seven owner-authorized calls above; rotating source addresses cannot create new buckets.
    for (let i = 7; i < 20; i++) await call("GET", "/v2/agents");
    await assert.rejects(call("GET", "/v2/agents"), { status: 429 });
  });
});

test("database constraints reject cross-owner mandates and overlong credential lifetimes", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner, other }) => {
    const agent = await store.createAgent(owner, { name: "Constraint test" });
    await assert.rejects(pool.query(`INSERT INTO rail_agent_mandates(mandate_id, agent_id, owner_wallet_id, mode, currency,
      per_payment_limit_minor, total_budget_minor, allowed_receiver_wallet_ids, created_at, expires_at)
      VALUES ($1, $2, $3, 'budgeted', 'INR', 100, 1000, ARRAY['agent_receiver'], now(), now() + interval '1 day')`,
      [randomUUID(), agent.agentId, other]), { code: "23503" });
    await assert.rejects(pool.query(`INSERT INTO rail_agent_credentials(credential_id, agent_id, token_hash, scope, created_at, expires_at)
      VALUES ($1, $2, $3, 'payments:propose', now(), now() + interval '31 days')`,
      [randomUUID(), agent.agentId, "a".repeat(64)]), { code: "23514" });
    await assert.rejects(pool.query(`INSERT INTO rail_agent_credentials(credential_id, agent_id, token_hash, scope, created_at, expires_at)
      VALUES ($1, $2, $3, 'payments:execute', now(), now() + interval '1 day')`,
      [randomUUID(), agent.agentId, "b".repeat(64)]), { code: "23514" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_mandates")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 0);
  });
});

test("revoked owner JWT versions cannot manage agent controls", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, token }) => {
    const resolver = createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] });
    const req = { headers: { authorization: `Bearer ${token}` } };
    assert.equal(await resolver.resolveOwnerWallet(req), "agent_owner");
    await pool.query("UPDATE users SET auth_version = auth_version + 1 WHERE user_id = 'agent_user'");
    await assert.rejects(resolver.resolveOwnerWallet(req), { status: 401 });
    const fresh = { headers: { authorization: `Bearer ${generateToken("agent_user", 1)}` } };
    assert.equal(await resolver.resolveOwnerWallet(fresh), "agent_owner");
  });
});
