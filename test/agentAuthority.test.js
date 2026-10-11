import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
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
import { PaymentPipelineEngine } from "../dist/pipeline/engine.js";
import { PostgresIdempotencyStore } from "../dist/persistence/postgresIdempotency.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";
import { TransactionEvidenceStore } from "../dist/persistence/transactionEvidence.js";
import { findReconciliationIssues } from "../dist/persistence/reconciliation.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
const policy = { mode: "budgeted", currency: "INR", perPaymentLimitMinor: 100, totalBudgetMinor: 1000,
  allowedReceiverWalletIds: ["agent_receiver"], ttlSeconds: 3600 };

async function fixture(work, max = 2, ownerBalance = 10000) {
  const schema = `ci_agents_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max, options: `-c search_path=${schema}` });
  const secret = process.env.JWT_SECRET;
  const signingSecret = process.env.RAIL_SIGNING_SECRET;
  process.env.JWT_SECRET = secret || "agent_test_jwt_secret_01234567890123456789";
  process.env.RAIL_SIGNING_SECRET = "agent_signing_secret_01234567890123456789";
  try {
    await runMigrations(pool);
    await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO wallets(wallet_id, balance) VALUES ('agent_owner', $1), ('other_owner', 10000), ('agent_receiver', 0)", [ownerBalance]);
    await pool.query("INSERT INTO users(user_id, password_hash, wallet_id) VALUES ('agent_user', 'unused_fixture_hash', 'agent_owner')");
    await work({ pool, store: new AgentAuthorityStore(pool), owner: "agent_owner", other: "other_owner", token: generateToken("agent_user") });
  } finally {
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    if (signingSecret === undefined) delete process.env.RAIL_SIGNING_SECRET; else process.env.RAIL_SIGNING_SECRET = signingSecret;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

async function intentSetup(store, owner, mode = "approval_required", totalBudgetMinor = 1000) {
  const agent = await store.createAgent(owner, { name: "Intent agent" });
  const credential = await store.issueCredential(owner, agent.agentId, {});
  const mandate = await store.createMandate(owner, agent.agentId, { ...policy, mode, totalBudgetMinor });
  const input = { mandateId: mandate.mandateId, clientRequestId: "intent_request_001", receiverWalletId: "agent_receiver", amountMinor: 100, currency: "INR", ttlSeconds: 300 };
  return { agent, credential, mandate, input };
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
    await assert.rejects(store.issueCredential(owner, agent.agentId, { scope: "payments:admin" }), { status: 422 });
    await assert.rejects(store.issueCredential(owner, agent.agentId, { scope: "payments:execute" }), { status: 503 });
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
      VALUES ($1, $2, $3, 'payments:admin', now(), now() + interval '1 day')`,
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

test("concurrent intent retries reserve budget once and preserve the exact request fingerprint", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { credential, mandate, input } = await intentSetup(store, owner);
    const before = (await pool.query("SELECT wallet_id, balance, reserved FROM wallets ORDER BY wallet_id")).rows;
    const intents = await Promise.all(Array.from({ length: 8 }, () => store.createIntent(credential.token, input)));
    assert.ok(intents.every(intent => JSON.stringify(intent) === JSON.stringify(intents[0])));
    assert.equal(intents[0].status, "pending");
    assert.equal(intents[0].executionEnabled, false);
    assert.match(intents[0].requestFingerprint, /^[a-f0-9]{64}$/);
    assert.equal((await pool.query("SELECT reserved_budget_minor FROM rail_agent_mandates WHERE mandate_id = $1", [mandate.mandateId])).rows[0].reserved_budget_minor, "100");
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 1);
    assert.deepEqual((await pool.query("SELECT wallet_id, balance, reserved FROM wallets ORDER BY wallet_id")).rows, before);
    assert.equal((await pool.query("SELECT * FROM authorizations")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    for (const change of [{ amountMinor: 99 }, { currency: "USD" }, { ttlSeconds: 301 },
      { receiverWalletId: "other_owner" }, { mandateId: randomUUID() }]) {
      await assert.rejects(store.createIntent(credential.token, { ...input, ...change }), { status: 409, code: "intent_request_reused" });
    }
  });
});

test("owner decisions bind to the exact intent and never resurrect rejected requests", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner, other }) => {
    const { agent, credential, input } = await intentSetup(store, owner);
    const intent = await store.createIntent(credential.token, input);
    await assert.rejects(store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "approve", requestFingerprint: "a".repeat(64) }), { code: "intent_fingerprint_mismatch" });
    await assert.rejects(store.decideIntent(other, agent.agentId, intent.intentId, { decision: "approve", requestFingerprint: intent.requestFingerprint }), { status: 404 });
    const approve = { decision: "approve", requestFingerprint: intent.requestFingerprint };
    assert.equal((await store.decideIntent(owner, agent.agentId, intent.intentId, approve)).status, "approved");
    assert.equal((await store.decideIntent(owner, agent.agentId, intent.intentId, approve)).status, "approved");
    const rejected = await Promise.all(Array.from({ length: 4 }, () => store.decideIntent(owner, agent.agentId, intent.intentId,
      { decision: "reject", requestFingerprint: intent.requestFingerprint })));
    assert.ok(rejected.every(item => item.status === "rejected" && item.reason === "owner_rejected"));
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
    assert.equal((await store.decideIntent(owner, agent.agentId, intent.intentId, approve)).status, "rejected");
  });
});

test("budgeted intents receive preapproval but concurrent proposals cannot exceed mandate headroom", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, input } = await intentSetup(store, owner, "budgeted", 200);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.createIntent(credential.token, { ...input, clientRequestId: `budget_intent_${i}` })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
    assert.ok(results.filter(result => result.status === "fulfilled").every(result => result.value.status === "approved"));
    assert.ok(results.filter(result => result.status === "rejected").every(result => result.reason.code === "mandate_budget_exceeded"));
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 200);
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 2);
  });
});

test("mandate expiry releases intent budget and cannot renew old request IDs", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, mandate, input } = await intentSetup(store, owner);
    const intent = await store.createIntent(credential.token, input);
    // Historical fixture simulates an elapsed mandate deadline, without changing intent history.
    await pool.query("UPDATE rail_agent_mandates SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE mandate_id = $1", [mandate.mandateId]);
    assert.equal((await store.listIntents(owner, agent.agentId))[0].status, "expired");
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
    assert.equal((await store.createIntent(credential.token, input)).status, "expired");
    assert.equal((await store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "approve", requestFingerprint: intent.requestFingerprint })).status, "expired");
    await assert.rejects(store.createIntent(credential.token, { ...input, clientRequestId: "expired_new_request" }), { code: "mandate_inactive" });
  });
});

test("agent and mandate revocation release held intent budgets exactly once", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner }) => {
    for (const revoke of ["agent", "mandate"]) {
      const { agent, credential, mandate, input } = await intentSetup(store, owner);
      await store.createIntent(credential.token, input);
      if (revoke === "agent") {
        await store.revokeAgent(owner, agent.agentId);
        await store.revokeAgent(owner, agent.agentId);
      } else {
        await store.revokeMandate(owner, agent.agentId, mandate.mandateId);
        await store.revokeMandate(owner, agent.agentId, mandate.mandateId);
      }
      const intent = (await store.listIntents(owner, agent.agentId))[0];
      assert.equal(intent.status, "rejected");
      assert.equal(intent.reason, `${revoke}_revoked`);
      assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
    }
  });
});

test("intent creation and decisions roll back budget and state on failed audit writes", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, input } = await intentSetup(store, owner);
    await pool.query(`CREATE FUNCTION fail_intent_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type LIKE 'agent.intent%' THEN RAISE EXCEPTION 'injected_intent_audit_failure'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER fail_intent_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_intent_audit()");
    await assert.rejects(store.createIntent(credential.token, input), /injected_intent_audit_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 0);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
    await pool.query("DROP TRIGGER fail_intent_audit ON outbox");
    const intent = await store.createIntent(credential.token, input);
    await pool.query("CREATE TRIGGER fail_intent_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_intent_audit()");
    await assert.rejects(store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "reject", requestFingerprint: intent.requestFingerprint }), /injected_intent_audit_failure/);
    assert.equal((await store.listIntents(owner, agent.agentId))[0].status, "pending");
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 100);
  });
});

test("database rejects intent mutation, deletion and inconsistent budget counters", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { credential, mandate, input } = await intentSetup(store, owner);
    const intent = await store.createIntent(credential.token, input);
    await assert.rejects(pool.query("UPDATE rail_agent_intents SET amount_minor = 99 WHERE intent_id = $1", [intent.intentId]), /agent_intent_history_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_agent_intents SET request_fingerprint = $2 WHERE intent_id = $1", [intent.intentId, "f".repeat(64)]), /agent_intent_history_is_immutable/);
    await assert.rejects(pool.query("DELETE FROM rail_agent_intents WHERE intent_id = $1", [intent.intentId]), /agent_intent_history_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_agent_mandates SET reserved_budget_minor = 0 WHERE mandate_id = $1", [mandate.mandateId]), /agent_budget_reservation_mismatch/);
  });
});

test("revoked credentials and out-of-policy proposals cannot create new reservations", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner }) => {
    const { agent, credential, input } = await intentSetup(store, owner);
    for (const change of [{ amountMinor: 101 }, { receiverWalletId: owner }, { currency: "USD" }]) {
      await assert.rejects(store.createIntent(credential.token, { ...input, ...change }), { code: "mandate_policy_denied" });
    }
    for (const change of [{ ttlSeconds: 901 }, { ttlSeconds: null }, { clientRequestId: "bad" }, { amountMinor: -1 }]) {
      await assert.rejects(store.createIntent(credential.token, { ...input, ...change }), { status: 422 });
    }
    await store.revokeCredential(owner, agent.agentId, credential.credentialId);
    await assert.rejects(store.createIntent(credential.token, input), { status: 401 });
    await assert.rejects(store.listAgentIntents(credential.token), { status: 401 });
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
  });
});

test("agent intent endpoints separate proposal credentials from owner approvals", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner, token }) => {
    const { agent, credential, input } = await intentSetup(store, owner);
    const context = { config: loadServerConfig(), agentStore: store, rateLimiter: new PostgresRateLimiter(pool),
      authResolver: createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] }) };
    const call = async (method, path, body, bearer) => {
      const req = Readable.from(body ? [JSON.stringify(body)] : []);
      req.method = method;
      req.headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
      req.socket = { remoteAddress: "192.0.2.1" };
      const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      assert.equal(await handleAgentRoutes(req, res, new URL(`http://localhost${path}`), context), true);
      return res.body;
    };
    const { intent } = await call("POST", "/v2/agent/intents", input, credential.token);
    assert.equal(intent.status, "pending");
    assert.equal((await call("GET", "/v2/agent/intents", undefined, credential.token)).intents.length, 1);
    const path = `/v2/agents/${agent.agentId}/intents/${intent.intentId}/decision`;
    const decision = { decision: "approve", requestFingerprint: intent.requestFingerprint };
    await assert.rejects(call("POST", path, decision, credential.token), { status: 401 });
    assert.equal((await call("POST", path, decision, token)).intent.status, "approved");
    assert.equal((await call("GET", `/v2/agents/${agent.agentId}/intents`, undefined, token)).intents[0].status, "approved");
    await assert.rejects(call("POST", "/v2/agent/intents", input, token), { status: 401 });
  });
});

test("reading mandates releases elapsed intent deadlines without changing live reservations", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, mandate, input } = await intentSetup(store, owner);
    const live = await store.createIntent(credential.token, input);
    const elapsedId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Insert historical data instead of bypassing the immutable-history trigger.
      await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_agent_intents(intent_id, agent_id, mandate_id, owner_wallet_id, client_request_id,
          proposal_fingerprint, request_fingerprint, receiver_wallet_id, amount_minor, currency, status, created_at, expires_at)
        SELECT $1, agent_id, mandate_id, owner_wallet_id, 'elapsed_intent_request', proposal_fingerprint,
          request_fingerprint, receiver_wallet_id, amount_minor, currency, 'pending', now - interval '2 minutes', now - interval '1 minute'
        FROM rail_agent_intents, timestamp WHERE intent_id = $2`, [elapsedId, live.intentId]);
      await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor + 100 WHERE mandate_id = $1", [mandate.mandateId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 100);
    const intents = await store.listIntents(owner, agent.agentId);
    assert.equal(intents.find(intent => intent.intentId === live.intentId).status, "pending");
    assert.equal(intents.find(intent => intent.intentId === elapsedId).status, "expired");
    assert.equal((await store.decideIntent(owner, agent.agentId, elapsedId,
      { decision: "approve", requestFingerprint: live.requestFingerprint })).status, "expired");
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 100);
  });
});

test("concurrent revocation and proposals leave no live intents or reserved budget", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner }) => {
    const { agent, credential, input } = await intentSetup(store, owner);
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, (_, i) => store.createIntent(credential.token, { ...input, clientRequestId: `revocation_race_${i}` })),
      store.revokeAgent(owner, agent.agentId)
    ]);
    assert.equal(results[results.length - 1].status, "fulfilled");
    assert.ok(results.slice(0, -1).every(result => result.status === "fulfilled" || result.reason.status === 401));
    assert.ok((await store.listIntents(owner, agent.agentId)).every(intent => intent.status === "rejected"));
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
    await assert.rejects(store.createIntent(credential.token, input), { status: 401 });
  });
});

test("agent intent quotas remain shared when request source addresses change", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { credential, input } = await intentSetup(store, owner);
    const context = { config: loadServerConfig(), agentStore: store, rateLimiter: new PostgresRateLimiter(pool) };
    for (let i = 0; i < 21; i++) {
      const req = Readable.from([JSON.stringify(input)]);
      req.method = "POST";
      req.headers = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
      req.socket = { remoteAddress: `192.0.2.${i + 1}` };
      const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      const call = () => handleAgentRoutes(req, res, new URL("http://localhost/v2/agent/intents"), context);
      if (i < 20) {
        assert.equal(await call(), true);
        assert.equal(res.status, 200);
      } else await assert.rejects(call(), { status: 429 });
    }
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 1);
    assert.equal((await pool.query("SELECT reserved_budget_minor FROM rail_agent_mandates")).rows[0].reserved_budget_minor, "100");
  });
});

function executionStore(pool, afterPayment, failEvidence = false) {
  const key = { keyId: "agent_execution_v1", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
  const evidence = new TransactionEvidenceStore(new TransactionKeyRing(key.keyId, [key]));
  const pipeline = buildHardenedPaymentPipeline(noopTracer);
  const engine = new PaymentPipelineEngine({ idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer,
    dlq: new MemoryDeadLetterQueue(), pipeline: async ctx => { await pipeline(ctx); await afterPayment?.(ctx); },
    evidence: failEvidence ? { async persist(client, txn) { await evidence.persist(client, txn); throw new Error("injected_agent_evidence_failure"); } } : evidence });
  return new AgentAuthorityStore(pool, engine);
}

async function executionSetup(pool, owner, mode = "approval_required", budget = 1000, store = executionStore(pool)) {
  const setup = await intentSetup(store, owner, mode, budget);
  const executionCredential = await store.issueCredential(owner, setup.agent.agentId, { scope: "payments:execute" });
  const intent = await store.createIntent(setup.credential.token, setup.input);
  const request = { requestFingerprint: intent.requestFingerprint };
  return { ...setup, store, executionCredential, intent, request };
}

test("agent execution fails closed with a missing or short signing secret", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const store = executionStore(pool);
    const agent = await store.createAgent(owner, { name: "Secret guard agent" });
    const secret = process.env.RAIL_SIGNING_SECRET;
    try {
      for (const value of [undefined, "short", " ".repeat(40)]) {
        if (value === undefined) delete process.env.RAIL_SIGNING_SECRET;
        else process.env.RAIL_SIGNING_SECRET = value;
        await assert.rejects(store.issueCredential(owner, agent.agentId, { scope: "payments:execute" }),
          { status: 503, code: "agent_execution_unavailable" });
        assert.equal((await store.listAgents(owner))[0].executionEnabled, false);
      }
    } finally {
      process.env.RAIL_SIGNING_SECRET = secret;
    }
    assert.equal((await pool.query("SELECT count(*) FROM rail_agent_credentials")).rows[0].count, "0");
  });
});

test("agent execution requires an explicit spend scope and exact owner approval", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, credential, executionCredential, intent, request } = await executionSetup(pool, owner);
    assert.equal(executionCredential.executionEnabled, true);
    assert.equal(credential.executionEnabled, false);
    await assert.rejects(store.executeIntent(credential.token, intent.intentId, request), { status: 403 });
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), { code: "intent_not_approved" });
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, { ...request, amountMinor: 1 }), { status: 422 });
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, { requestFingerprint: "f".repeat(64) }), { code: "intent_fingerprint_mismatch" });
    await store.decideIntent(owner, agent.agentId, intent.intentId, { ...request, decision: "approve" });
    const signaturePolicy = process.env.RAIL_REQUIRE_TX_SIGNATURE;
    try {
      process.env.RAIL_REQUIRE_TX_SIGNATURE = "true";
      assert.equal((await store.executeIntent(executionCredential.token, intent.intentId, request)).result.status, "accepted");
    } finally {
      if (signaturePolicy === undefined) delete process.env.RAIL_REQUIRE_TX_SIGNATURE; else process.env.RAIL_REQUIRE_TX_SIGNATURE = signaturePolicy;
    }
    assert.deepEqual(await findReconciliationIssues(pool), []);
  });
});

test("agent execution and concurrent replay consume money and total budget exactly once", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, executionCredential, intent, request, credential, input } = await executionSetup(pool, owner, "budgeted", 100);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.executeIntent(executionCredential.token, intent.intentId, request)));
    assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])));
    assert.equal(results[0].intent.status, "executed");
    assert.equal(results[0].intent.paymentTxId, `rail_agent:${intent.intentId}`);
    const mandate = (await store.listMandates(owner, agent.agentId))[0];
    assert.equal(mandate.reservedBudgetMinor, 0);
    assert.equal(mandate.spentBudgetMinor, 100);
    for (const table of ["authorizations", "rail_payment_executions", "rail_idempotency", "rail_transaction_evidence", "rail_risk_observations"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 1, table);
    const risk = (await pool.query("SELECT * FROM rail_risk_observations")).rows[0];
    assert.equal(risk.feature_snapshot.agentBudgetExposure, 1);
    assert.ok(risk.assessment.reasons.includes("high_agent_budget_exposure"));
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.deepEqual((await pool.query("SELECT wallet_id, balance, reserved FROM wallets WHERE wallet_id <> 'other_owner' ORDER BY wallet_id")).rows,
      [{ wallet_id: "agent_owner", balance: "9900", reserved: "0" }, { wallet_id: "agent_receiver", balance: "100", reserved: "0" }]);
    assert.equal((await pool.query("SELECT * FROM outbox WHERE type = 'agent.intent_executed'")).rowCount, 1);
    await assert.rejects(store.createIntent(credential.token, { ...input, clientRequestId: "after_budget_consumed" }), { code: "mandate_budget_exceeded" });
    assert.equal((await store.decideIntent(owner, agent.agentId, intent.intentId, { ...request, decision: "reject" })).status, "executed");
    assert.deepEqual(await findReconciliationIssues(pool), []);
  }, 1);
});

test("agent evidence failure rolls back authority, ledger and consumed budget", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const failing = executionStore(pool, undefined, true);
    const { agent, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted", 1000, failing);
    await assert.rejects(failing.executeIntent(executionCredential.token, intent.intentId, request), /injected_agent_evidence_failure/);
    const mandate = (await failing.listMandates(owner, agent.agentId))[0];
    assert.equal(mandate.reservedBudgetMinor, 100);
    assert.equal(mandate.spentBudgetMinor, 0);
    assert.equal((await failing.listIntents(owner, agent.agentId))[0].status, "approved");
    for (const table of ["authorizations", "ledger_entries", "rail_payment_executions", "rail_idempotency", "rail_transaction_evidence", "rail_risk_observations"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    assert.equal((await executionStore(pool).executeIntent(executionCredential.token, intent.intentId, request)).result.status, "accepted");
  });
});

test("agent execution audit failure rolls back the whole payment and permits retry", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted");
    await pool.query(`CREATE FUNCTION reject_agent_execution_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'agent.intent_executed' THEN RAISE EXCEPTION 'injected_agent_audit_failure'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER reject_agent_execution_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_agent_execution_audit()");
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), /injected_agent_audit_failure/);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].spentBudgetMinor, 0);
    for (const table of ["authorizations", "ledger_entries", "rail_payment_executions", "rail_idempotency", "rail_transaction_evidence"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    await pool.query("DROP TRIGGER reject_agent_execution_audit ON outbox");
    assert.equal((await store.executeIntent(executionCredential.token, intent.intentId, request)).intent.status, "executed");
    assert.deepEqual(await findReconciliationIssues(pool), []);
  });
});

test("agent execution isolates agents and rejects revoked credentials even for completed replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner, other }) => {
    const first = await executionSetup(pool, owner, "budgeted");
    const second = await executionSetup(pool, other, "budgeted");
    await assert.rejects(second.store.executeIntent(second.executionCredential.token, first.intent.intentId, first.request), { status: 404 });
    await first.store.executeIntent(first.executionCredential.token, first.intent.intentId, first.request);
    await first.store.revokeCredential(owner, first.agent.agentId, first.executionCredential.credentialId);
    await assert.rejects(first.store.executeIntent(first.executionCredential.token, first.intent.intentId, first.request), { status: 401 });
    assert.equal((await first.store.listIntents(owner, first.agent.agentId))[0].status, "executed");
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  });
});

test("agent execution rechecks credential and mandate deadlines after financial work", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    for (const target of ["credential", "mandate"]) {
      let setup;
      const store = executionStore(pool, async ctx => {
        if (target === "credential") await ctx.dbClient.query("UPDATE rail_agent_credentials SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE credential_id = $1", [setup.executionCredential.credentialId]);
        else await ctx.dbClient.query("UPDATE rail_agent_mandates SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE mandate_id = $1", [setup.mandate.mandateId]);
      });
      setup = await executionSetup(pool, owner, "budgeted", 1000, store);
      await assert.rejects(store.executeIntent(setup.executionCredential.token, setup.intent.intentId, setup.request), { status: target === "credential" ? 401 : 409 });
      assert.equal((await store.listMandates(owner, setup.agent.agentId))[0].spentBudgetMinor, 0);
      assert.equal((await store.listIntents(owner, setup.agent.agentId))[0].status, "approved");
    }
    assert.equal((await pool.query("SELECT * FROM authorizations")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
  });
});

test("agent policy headroom cannot substitute for available wallet funds", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted");
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), { code: "insufficient_funds" });
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 100);
    assert.equal((await pool.query("SELECT * FROM authorizations")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
  }, 2, 0);
});

test("database prevents unbacked agent execution and rewriting consumed budget or receipts", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, mandate, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted");
    await assert.rejects(pool.query("UPDATE rail_agent_mandates SET spent_budget_minor = 1 WHERE mandate_id = $1", [mandate.mandateId]), /agent_budget_reservation_mismatch/);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor = 0, spent_budget_minor = 100 WHERE mandate_id = $1", [mandate.mandateId]);
      await client.query("UPDATE rail_agent_intents SET status = 'executed', payment_tx_id = $2, executed_at = clock_timestamp() WHERE intent_id = $1", [intent.intentId, `rail_agent:${intent.intentId}`]);
      await assert.rejects(client.query("COMMIT"));
    } finally { await client.query("ROLLBACK"); client.release(); }
    await store.executeIntent(executionCredential.token, intent.intentId, request);
    await assert.rejects(pool.query("UPDATE rail_agent_intents SET status = 'approved', payment_tx_id = NULL, executed_at = NULL WHERE intent_id = $1", [intent.intentId]), /agent_intent_history_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_agent_mandates SET spent_budget_minor = 0 WHERE mandate_id = $1", [mandate.mandateId]), /agent_budget_reservation_mismatch/);
    await runMigrations(pool);
    assert.equal((await store.executeIntent(executionCredential.token, intent.intentId, request)).intent.status, "executed");
  });
});

test("agent execution HTTP endpoint returns only committed receipts under agent quotas", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner, token }) => {
    const { store, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted");
    const context = { config: loadServerConfig(), agentStore: store, rateLimiter: new PostgresRateLimiter(pool) };
    const call = async bearer => {
      const req = Readable.from([JSON.stringify(request)]);
      req.method = "POST";
      req.headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
      req.socket = { remoteAddress: "192.0.2.40" };
      const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      assert.equal(await handleAgentRoutes(req, res, new URL(`http://localhost/v2/agent/intents/${intent.intentId}/execute`), context), true);
      return res;
    };
    await assert.rejects(call(token), { status: 401 });
    const response = await call(executionCredential.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.intent.status, "executed");
    assert.equal((await pool.query("SELECT * FROM rail_transaction_evidence")).rowCount, 1);
    assert.deepEqual((await call(executionCredential.token)).body, response.body);
    for (let i = 2; i < 20; i++) assert.equal((await call(executionCredential.token)).status, 200);
    await assert.rejects(call(executionCredential.token), { status: 429 });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  });
});

test("concurrent agent revocation and execution produce either one committed payment or none", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted");
    const [execution, revocation] = await Promise.allSettled([
      store.executeIntent(executionCredential.token, intent.intentId, request), store.revokeAgent(owner, agent.agentId)
    ]);
    assert.equal(revocation.status, "fulfilled");
    if (execution.status === "rejected") assert.equal(execution.reason.status, 401);
    const committed = execution.status === "fulfilled";
    const mandate = (await store.listMandates(owner, agent.agentId))[0];
    assert.equal(mandate.spentBudgetMinor, committed ? 100 : 0);
    assert.equal(mandate.reservedBudgetMinor, 0);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, committed ? 2 : 0);
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), { status: 401 });
    assert.deepEqual(await findReconciliationIssues(pool), []);
  });
});

test("agent intent expiry during financial work rolls back money before releasing its hold", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    let financialWorkRan = false;
    const store = executionStore(pool, async ctx => {
      financialWorkRan = ctx.result.status === "accepted";
      await ctx.dbClient.query("SELECT pg_sleep(1.1)");
    });
    const setup = await executionSetup(pool, owner, "budgeted", 1000, store);
    const id = randomUUID(), createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 1000).toISOString();
    const fingerprint = createHash("sha256").update(JSON.stringify(["rail:agent-intent:v1", id, setup.agent.agentId,
      setup.mandate.mandateId, owner, "agent_receiver", 100, "INR", createdAt, expiresAt])).digest("hex");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A short-lived fixture avoids changing immutable intent timestamps or waiting a minute.
      await client.query(`INSERT INTO rail_agent_intents(intent_id, agent_id, mandate_id, owner_wallet_id, client_request_id,
        proposal_fingerprint, request_fingerprint, receiver_wallet_id, amount_minor, currency, status, created_at, expires_at)
        VALUES ($1,$2,$3,$4,'short_deadline_fixture',$5,$5,'agent_receiver',100,'INR','approved',$6,$7)`,
        [id, setup.agent.agentId, setup.mandate.mandateId, owner, fingerprint, createdAt, expiresAt]);
      await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor + 100 WHERE mandate_id = $1", [setup.mandate.mandateId]);
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
    await assert.rejects(store.executeIntent(setup.executionCredential.token, id, { requestFingerprint: fingerprint }), { code: "intent_expired" });
    assert.equal(financialWorkRan, true);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM authorizations")).rowCount, 0);
    assert.equal((await store.listIntents(owner, setup.agent.agentId)).find(intent => intent.intentId === id).status, "expired");
    assert.equal((await store.listMandates(owner, setup.agent.agentId))[0].spentBudgetMinor, 0);
  });
});

test("agent final commit failures never return an accepted receipt or consume budget", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted");
    await pool.query(`CREATE FUNCTION reject_agent_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'agent.intent_executed' THEN RAISE EXCEPTION 'injected_agent_commit_failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER reject_agent_commit AFTER INSERT ON outbox
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_agent_commit()`);
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), /injected_agent_commit_failure/);
    assert.equal((await store.listIntents(owner, agent.agentId))[0].status, "approved");
    assert.equal((await store.listMandates(owner, agent.agentId))[0].spentBudgetMinor, 0);
    for (const table of ["authorizations", "ledger_entries", "rail_payment_executions", "rail_transaction_evidence", "rail_idempotency"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
  });
});
