import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { Pool } from "pg";
import { AgentAuthorityStore, parseMandateInput, parseAgentCheckout } from "../dist/persistence/agentAuthority.js";
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
import { RiskProtectionStore, decryptRiskRecord } from "../dist/persistence/riskProtection.js";
import { AgentEvidenceStore } from "../dist/persistence/agentEvidence.js";
import { MerchantQuoteRegistry, merchantQuoteBytes } from "../dist/crypto/merchantQuotes.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
const authorityKey = { keyId: "agent_authority_test_v1", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
const authorityEvidence = () => new AgentEvidenceStore(new TransactionKeyRing(authorityKey.keyId, [authorityKey]));
const policy = { mode: "budgeted", currency: "INR", perPaymentLimitMinor: 100, totalBudgetMinor: 1000,
  allowedReceiverWalletIds: ["agent_receiver"], ttlSeconds: 3600 };

function checkout(expiresAt = new Date(Date.now() + 120000).toISOString()) {
  return { version: 1, merchantWalletId: "agent_receiver", quoteId: "quote_001", quoteVersion: 1,
    subtotalMinor: 90, feeMinor: 10, totalMinor: 100, currency: "INR", expiresAt,
    fundingSource: { type: "internal_wallet", walletId: "agent_owner" } };
}

function merchantFixture(status = "active") {
  const pair = generateKeyPairSync("ed25519");
  const entry = { keyId: "merchant_key_001", merchantWalletId: "agent_receiver", status,
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  return { entry, registry: new MerchantQuoteRegistry(JSON.stringify([entry])),
    proof: value => ({ keyId: entry.keyId, signature: sign(null, merchantQuoteBytes(value, entry.keyId), pair.privateKey).toString("base64") }) };
}

test("signed merchant checkout survives authenticated HTTP approval, execution and protected receipt reads", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner, token }) => {
    const merchant = merchantFixture(), store = executionStore(pool, undefined, false, undefined, authorityEvidence(), merchant.registry);
    const setup = await intentSetup(store, owner), value = checkout();
    const execution = await store.issueCredential(owner, setup.agent.agentId, { scope: "payments:execute" });
    const context = { config: loadServerConfig(), agentStore: store, rateLimiter: new PostgresRateLimiter(pool),
      authResolver: createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] }) };
    const call = async (method, path, body, bearer) => {
      const req = Readable.from(body ? [JSON.stringify(body)] : []);
      req.method = method; req.headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
      req.socket = { remoteAddress: "192.0.2.1" };
      const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      assert.equal(await handleAgentRoutes(req, res, new URL(`http://localhost${path}`), context), true);
      return res.body;
    };
    const { intent } = await call("POST", "/v2/agent/intents", { ...setup.input, checkout: value, merchantQuoteProof: merchant.proof(value) }, setup.credential.token);
    assert.equal(intent.quoteAssurance, "configured_merchant_signature");
    const request = { requestFingerprint: intent.requestFingerprint };
    await call("POST", `/v2/agents/${setup.agent.agentId}/intents/${intent.intentId}/decision`, { ...request, decision: "approve" }, token);
    await call("POST", `/v2/agent/intents/${intent.intentId}/execute`, request, execution.token);
    const { authority } = await call("GET", `/v2/agents/${setup.agent.agentId}/intents/${intent.intentId}/authority`, undefined, token);
    assert.equal(authority.status, "verified");
    assert.deepEqual(authority.receipt.checkout, value);
    assert.deepEqual(authority.receipt.merchantAttestation, intent.merchantAttestation);
    assert.deepEqual(authority.ownerEvidence.approval.record.merchantAttestation, intent.merchantAttestation);
    assert.equal(authority.ownerEvidence.approval.record.authentication.method, "owner_jwt");
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  });
});

test("registered merchants reject unsigned downgrade, tampered quotes and wrong-owner audience without holds", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const merchant = merchantFixture(), store = executionStore(pool, undefined, false, undefined, authorityEvidence(), merchant.registry);
    const setup = await intentSetup(store, owner, "budgeted"), value = checkout(), proof = merchant.proof(value);
    for (const input of [setup.input, { ...setup.input, checkout: value }])
      await assert.rejects(store.createIntent(setup.credential.token, input), { code: "merchant_quote_required" });
    await assert.rejects(store.createIntent(setup.credential.token, { ...setup.input, checkout: { ...value, subtotalMinor: 80, feeMinor: 20 }, merchantQuoteProof: proof }), { code: "merchant_quote_denied" });
    const foreign = { ...value, fundingSource: { type: "internal_wallet", walletId: "other_owner" } };
    await assert.rejects(store.createIntent(setup.credential.token, { ...setup.input, checkout: foreign, merchantQuoteProof: merchant.proof(foreign) }), { code: "checkout_funding_denied" });
    await assert.rejects(store.createIntent(setup.credential.token, { ...setup.input, checkout: value, merchantQuoteProof: { ...proof, publicKey: merchant.entry.publicKey } }), { status: 422 });
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 0);
    assert.equal((await store.listMandates(owner, setup.agent.agentId))[0].reservedBudgetMinor, 0);
  });
});

test("merchant quote is single-use across concurrent agents and versions even after rejection", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const merchant = merchantFixture(), store = executionStore(pool, undefined, false, undefined, authorityEvidence(), merchant.registry);
    const first = await intentSetup(store, owner), second = await intentSetup(store, owner);
    const value = checkout(), proof = merchant.proof(value);
    const requests = [first, second].map(setup => ({ ...setup.input, checkout: value, merchantQuoteProof: proof }));
    const results = await Promise.allSettled([store.createIntent(first.credential.token, requests[0]), store.createIntent(second.credential.token, requests[1])]);
    const winnerIndex = results.findIndex(result => result.status === "fulfilled"), winner = [first, second][winnerIndex];
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results[1 - winnerIndex].reason.code, "merchant_quote_used");
    const intent = results[winnerIndex].value;
    assert.deepEqual(await store.createIntent(winner.credential.token, requests[winnerIndex]), intent);
    const changed = { ...value, quoteVersion: 2 };
    await assert.rejects(store.createIntent(winner.credential.token, { ...requests[winnerIndex], checkout: changed, merchantQuoteProof: merchant.proof(changed) }), { code: "intent_request_reused" });
    await store.decideIntent(owner, winner.agent.agentId, intent.intentId, { decision: "reject", requestFingerprint: intent.requestFingerprint });
    await assert.rejects(store.createIntent(winner.credential.token, { ...winner.input, clientRequestId: "new_version_request", checkout: changed, merchantQuoteProof: merchant.proof(changed) }), { code: "merchant_quote_used" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 1);
  });
});

test("merchant revocation blocks fresh spending but preserves completed historical receipts and replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const merchant = merchantFixture(), store = executionStore(pool, undefined, false, undefined, authorityEvidence(), merchant.registry);
    const setup = await intentSetup(store, owner, "budgeted"), execution = await store.issueCredential(owner, setup.agent.agentId, { scope: "payments:execute" });
    const value = checkout(), input = { ...setup.input, checkout: value, merchantQuoteProof: merchant.proof(value) };
    const first = await store.createIntent(setup.credential.token, input);
    const result = await store.executeIntent(execution.token, first.intentId, { requestFingerprint: first.requestFingerprint });
    const next = { ...value, quoteId: "next_signed_quote" };
    const second = await store.createIntent(setup.credential.token, { ...input, clientRequestId: "next_signed_request", checkout: next, merchantQuoteProof: merchant.proof(next) });
    const revokedRegistry = new MerchantQuoteRegistry(JSON.stringify([{ ...merchant.entry, status: "revoked" }]));
    const revoked = executionStore(pool, undefined, false, undefined, authorityEvidence(), revokedRegistry);
    await assert.rejects(revoked.executeIntent(execution.token, second.intentId, { requestFingerprint: second.requestFingerprint }), { code: "merchant_quote_denied" });
    await assert.rejects(revoked.createIntent(setup.credential.token, { ...setup.input, clientRequestId: "downgrade_request" }), { code: "merchant_quote_required" });
    assert.deepEqual(await revoked.executeIntent(execution.token, first.intentId, { requestFingerprint: first.requestFingerprint }), result);
    assert.equal((await revoked.readAuthority(owner, setup.agent.agentId, first.intentId)).status, "verified");
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  });
});

test("enrolling a merchant blocks old unsigned approvals while allowing rejection and preserving old receipts", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const legacy = await executionSetup(pool, owner), merchant = merchantFixture();
    const enrolled = executionStore(pool, undefined, false, undefined, authorityEvidence(), merchant.registry);
    await assert.rejects(enrolled.decideIntent(owner, legacy.agent.agentId, legacy.intent.intentId, { ...legacy.request, decision: "approve" }), { code: "merchant_quote_required" });
    await legacy.store.decideIntent(owner, legacy.agent.agentId, legacy.intent.intentId, { ...legacy.request, decision: "approve" });
    await assert.rejects(enrolled.executeIntent(legacy.executionCredential.token, legacy.intent.intentId, legacy.request), { code: "merchant_quote_required" });
    assert.equal((await enrolled.decideIntent(owner, legacy.agent.agentId, legacy.intent.intentId, { ...legacy.request, decision: "reject" })).status, "rejected");
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
  });
});

test("signed quote SQL mutation guards and migration preserve proof while financial rollback permits retry", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const merchant = merchantFixture(), store = executionStore(pool, undefined, true, undefined, authorityEvidence(), merchant.registry);
    const setup = await intentSetup(store, owner, "budgeted"), value = checkout();
    const intent = await store.createIntent(setup.credential.token, { ...setup.input, checkout: value, merchantQuoteProof: merchant.proof(value) });
    const execution = await store.issueCredential(owner, setup.agent.agentId, { scope: "payments:execute" });
    const request = { requestFingerprint: intent.requestFingerprint };
    await assert.rejects(pool.query("UPDATE rail_agent_intents SET merchant_attestation=NULL WHERE intent_id=$1", [intent.intentId]), /agent_intent_history_is_immutable/);
    await assert.rejects(store.executeIntent(execution.token, intent.intentId, request), /injected_agent_evidence_failure/);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    await runMigrations(pool);
    const healthy = executionStore(pool, undefined, false, undefined, authorityEvidence(), merchant.registry);
    await healthy.executeIntent(execution.token, intent.intentId, request);
    assert.deepEqual((await healthy.readAuthority(owner, setup.agent.agentId, intent.intentId)).receipt.merchantAttestation, intent.merchantAttestation);
  });
});

test("checkout parsing rejects unverifiable claims, unsafe fees and unsupported funding", () => {
  const value = checkout();
  assert.deepEqual(parseAgentCheckout(value), value);
  for (const change of [null, [], { ...value, verified: true }, { ...value, feeMinor: -1 }, { ...value, feeMinor: 10.5 },
    { ...value, totalMinor: 99 }, { ...value, subtotalMinor: 1e12 + 1 }, { ...value, quoteVersion: 0 },
    { ...value, quoteVersion: 1.1 }, { ...value, expiresAt: "2026-02-30T00:00:00.000Z" },
    { ...value, expiresAt: "2026-01-01" }, { ...value, fundingSource: { type: "card", walletId: "agent_owner" } },
    { ...value, fundingSource: { ...value.fundingSource, verified: true } }]) {
    assert.throws(() => parseAgentCheckout(change), { status: 422 });
  }
  const parsed = parseAgentCheckout(value);
  value.fundingSource.walletId = "other_owner";
  assert.equal(parsed.fundingSource.walletId, "agent_owner");
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.fundingSource));
});

test("checkout retries bind every quote field and snapshot caller input before awaiting", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner }) => {
    const { credential, input } = await intentSetup(store, owner);
    const original = checkout(), mutable = structuredClone(original);
    const pending = store.createIntent(credential.token, { ...input, checkout: mutable });
    mutable.quoteId = "changed_quote"; mutable.fundingSource.walletId = "other_owner";
    const intent = await pending;
    assert.deepEqual(intent.checkout, original);
    assert.equal(intent.quoteAssurance, "agent_proposed_unverified");
    assert.deepEqual(await store.createIntent(credential.token, { ...input, checkout: original }), intent);
    for (const change of [{ quoteId: "quote_002" }, { quoteVersion: 2 }, { subtotalMinor: 80, feeMinor: 20 },
      { expiresAt: new Date(Date.parse(original.expiresAt) + 1000).toISOString() }]) {
      await assert.rejects(store.createIntent(credential.token, { ...input, checkout: { ...original, ...change } }), { code: "intent_request_reused" });
    }
    await assert.rejects(store.createIntent(credential.token, input), { code: "intent_request_reused" });
  });
});

test("checkout policy checks charge the total including fees and reject foreign funding", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner, pool }) => {
    const { credential, input, agent } = await intentSetup(store, owner, "budgeted", 100);
    await assert.rejects(store.createIntent(credential.token, { ...input, checkout: { ...checkout(), fundingSource: { type: "internal_wallet", walletId: "other_owner" } } }), { code: "checkout_funding_denied" });
    for (const change of [{ merchantWalletId: "other_owner" }, { currency: "USD" }, { totalMinor: 99, subtotalMinor: 89 }]) {
      await assert.rejects(store.createIntent(credential.token, { ...input, checkout: { ...checkout(), ...change } }), { status: 422 });
    }
    await assert.rejects(store.createIntent(credential.token, { ...input, amountMinor: 110, checkout: { ...checkout(), totalMinor: 110, feeMinor: 20 } }), { code: "mandate_policy_denied" });
    await store.createIntent(credential.token, { ...input, checkout: checkout() });
    await assert.rejects(store.createIntent(credential.token, { ...input, clientRequestId: "second_checkout_001", checkout: checkout() }), { code: "mandate_budget_exceeded" });
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 100);
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 1);
  });
});

test("expired quotes create no intent or budget hold and live deadlines are clipped", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner, pool }) => {
    const { credential, input, agent } = await intentSetup(store, owner);
    await assert.rejects(store.createIntent(credential.token, { ...input, checkout: checkout("2020-01-01T00:00:00.000Z") }), { code: "quote_expired" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 0);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
    const value = checkout();
    const intent = await store.createIntent(credential.token, { ...input, checkout: value });
    assert.equal(intent.expiresAt, value.expiresAt);
  });
});

test("checkout SQL guards reject rewrites and malformed direct inserts", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, owner, pool }) => {
    const { credential, input } = await intentSetup(store, owner);
    const intent = await store.createIntent(credential.token, { ...input, checkout: checkout() });
    await assert.rejects(pool.query("UPDATE rail_agent_intents SET checkout=jsonb_set(checkout,'{quoteVersion}','2') WHERE intent_id=$1", [intent.intentId]), /agent_intent_history_is_immutable/);
    // An INSERT copies a valid intent but supplies invalid checkout data, exercising CHECK independently of the UPDATE guard.
    for (const value of [null, { ...checkout(), feeMinor: null }, { ...checkout(), verified: true },
      { ...checkout(), merchantWalletId: "other_owner" }, { ...checkout(), subtotalMinor: 89 },
      { ...checkout(), fundingSource: { type: "internal_wallet", walletId: "other_owner" } }]) {
      await assert.rejects(pool.query(`INSERT INTO rail_agent_intents(intent_id,agent_id,mandate_id,owner_wallet_id,client_request_id,
        proposal_fingerprint,request_fingerprint,receiver_wallet_id,amount_minor,currency,status,created_at,expires_at,checkout)
        SELECT $2,agent_id,mandate_id,owner_wallet_id,'invalid_checkout_insert',proposal_fingerprint,request_fingerprint,
          receiver_wallet_id,amount_minor,currency,'pending',created_at,expires_at,$3::jsonb FROM rail_agent_intents WHERE intent_id=$1`,
        [intent.intentId, randomUUID(), JSON.stringify(value)]), { code: "23514" });
    }
  });
});

test("checkout approval and execution receipts retain the exact quote across migration and expiry replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const store = executionStore(pool), setup = await intentSetup(store, owner);
    const execution = await store.issueCredential(owner, setup.agent.agentId, { scope: "payments:execute" });
    const value = checkout(new Date(Date.now() + 3000).toISOString());
    const intent = await store.createIntent(setup.credential.token, { ...setup.input, checkout: value });
    const request = { requestFingerprint: intent.requestFingerprint };
    await store.decideIntent(owner, setup.agent.agentId, intent.intentId, { ...request, decision: "approve" });
    const first = await store.executeIntent(execution.token, intent.intentId, request);
    const proof = await store.readAuthority(owner, setup.agent.agentId, intent.intentId);
    assert.equal(proof.status, "verified");
    assert.deepEqual(proof.receipt.checkout, value);
    assert.deepEqual(proof.ownerEvidence.approval.record.checkout, value);
    assert.equal(proof.receipt.quoteAssurance, "agent_proposed_unverified");
    assert.equal((await pool.query("SELECT balance FROM wallets WHERE wallet_id='agent_receiver'")).rows[0].balance, "100");
    await runMigrations(pool);
    await pool.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp())) + 0.05) FROM rail_agent_intents WHERE intent_id=$1", [intent.intentId]);
    assert.deepEqual(await store.executeIntent(execution.token, intent.intentId, request), first);
    assert.deepEqual(await store.readAuthority(owner, setup.agent.agentId, intent.intentId), proof);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  });
});

test("checkout expiry during execution rolls back ledger, evidence and budget consumption", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const store = executionStore(pool, async ctx => {
      await ctx.dbClient.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp())) + 0.05) FROM rail_agent_intents WHERE intent_id=$1", [intentId]);
    });
    const setup = await intentSetup(store, owner, "budgeted");
    const execution = await store.issueCredential(owner, setup.agent.agentId, { scope: "payments:execute" });
    const intent = await store.createIntent(setup.credential.token, { ...setup.input, checkout: checkout(new Date(Date.now() + 1500).toISOString()) });
    const intentId = intent.intentId;
    await assert.rejects(store.executeIntent(execution.token, intentId, { requestFingerprint: intent.requestFingerprint }), { code: "intent_expired" });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_authority_evidence")).rowCount, 0);
    assert.equal((await pool.query("SELECT balance FROM wallets WHERE wallet_id='agent_owner'")).rows[0].balance, "10000");
    assert.equal((await pool.query("SELECT spent_budget_minor FROM rail_agent_mandates")).rows[0].spent_budget_minor, "0");
    assert.equal((await store.listMandates(owner, setup.agent.agentId))[0].reservedBudgetMinor, 0);
  });
});

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
    await work({ pool, store: new AgentAuthorityStore(pool, undefined, authorityEvidence()), owner: "agent_owner", other: "other_owner", token: generateToken("agent_user") });
  } finally {
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    if (signingSecret === undefined) delete process.env.RAIL_SIGNING_SECRET; else process.env.RAIL_SIGNING_SECRET = signingSecret;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

// Seed deadlines at creation: production authority history must never be rewritten to advance a test clock.
async function datedCredential(pool, agentId, scope = "payments:propose", seconds = -1) {
  const credentialId = randomUUID();
  const token = `rail_agent_${randomBytes(32).toString("base64url")}`;
  await pool.query(`INSERT INTO rail_agent_credentials(credential_id, agent_id, token_hash, scope, created_at, expires_at)
    VALUES ($1, $2, $3, $4, clock_timestamp() - interval '1 hour', clock_timestamp() + $5 * interval '1 second')`,
    [credentialId, agentId, createHash("sha256").update(token).digest("hex"), scope, seconds]);
  return { credentialId, token };
}

async function datedMandate(pool, owner, agentId, input, seconds = -1) {
  const mandateId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO rail_agent_mandates(mandate_id, agent_id, owner_wallet_id, mode, currency,
      per_payment_limit_minor, total_budget_minor, allowed_receiver_wallet_ids, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp() - interval '1 hour',clock_timestamp() + $9 * interval '1 second')`,
      [mandateId, agentId, owner, input.mode, input.currency, input.perPaymentLimitMinor, input.totalBudgetMinor, input.allowedReceiverWalletIds, seconds]);
    await authorityEvidence().persistOwner(client, mandateId, { walletId: owner, method: "trusted_library" });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { mandateId };
}

async function intentSetup(store, owner, mode = "approval_required", totalBudgetMinor = 1000, createMandate) {
  const agent = await store.createAgent(owner, { name: "Intent agent" });
  const credential = await store.issueCredential(owner, agent.agentId, {});
  const mandate = await (createMandate ?? ((id, input) => store.createMandate(owner, id, input)))(agent.agentId, { ...policy, mode, totalBudgetMinor });
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
    const second = await datedCredential(pool, agent.agentId);
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
    const expired = await datedMandate(pool, owner, agent.agentId, policy);
    assert.equal((await store.listMandates(owner, agent.agentId)).find(item => item.mandateId === expired.mandateId).status, "expired");
    assert.equal((await store.revokeMandate(owner, agent.agentId, mandates[1].mandateId)).status, "revoked");
    assert.deepEqual((await wallets()).rows, before);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM authorizations")).rowCount, 0);
  });
});

test("database prevents agent ownership and identity rewrites", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const agent = await store.createAgent(owner, { name: "Fixed owner" });
    for (const assignment of ["owner_wallet_id = 'other_owner'", "name = 'Impersonated owner'",
      "agent_id = gen_random_uuid()", "created_at = created_at - interval '1 hour'"]) {
      await assert.rejects(pool.query(`UPDATE rail_agents SET ${assignment} WHERE agent_id = $1`, [agent.agentId]),
        { code: "23514", message: "agent_identity_is_immutable" });
    }
    assert.equal((await store.listAgents(owner))[0].name, "Fixed owner");
  });
});

test("database prevents credential promotion, rebinding, replacement and lifetime extension", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const first = await store.createAgent(owner, { name: "First agent" });
    const second = await store.createAgent(owner, { name: "Second agent" });
    const credential = await store.issueCredential(owner, first.agentId, {});
    for (const assignment of ["scope = 'payments:execute'", `agent_id = '${second.agentId}'`,
      "token_hash = repeat('a', 64)", "credential_id = gen_random_uuid()",
      "expires_at = expires_at + interval '1 hour'", "created_at = created_at - interval '1 hour'"]) {
      await assert.rejects(pool.query(`UPDATE rail_agent_credentials SET ${assignment} WHERE credential_id = $1`, [credential.credentialId]),
        { code: "23514", message: "agent_credential_is_immutable" });
    }
    assert.equal((await store.resolveCredential(credential.token)).scope, "payments:propose");
  });
});

test("database prevents silently relaxing owner-approved mandate policy", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const agent = await store.createAgent(owner, { name: "Fixed policy" });
    const mandate = await store.createMandate(owner, agent.agentId, { ...policy, mode: "approval_required" });
    for (const assignment of ["mode = 'budgeted'", "currency = 'USD'", "per_payment_limit_minor = 200",
      "total_budget_minor = 2000", "allowed_receiver_wallet_ids = ARRAY['other_owner']",
      "owner_wallet_id = 'other_owner'", "agent_id = gen_random_uuid()", "mandate_id = gen_random_uuid()",
      "expires_at = expires_at + interval '1 hour'", "created_at = created_at - interval '1 hour'"]) {
      await assert.rejects(pool.query(`UPDATE rail_agent_mandates SET ${assignment} WHERE mandate_id = $1`, [mandate.mandateId]),
        { code: "23514", message: "agent_mandate_policy_is_immutable" });
    }
    assert.equal((await store.listMandates(owner, agent.agentId))[0].mode, "approval_required");
    await store.createMandate(owner, agent.agentId, policy);
    assert.equal((await store.listMandates(owner, agent.agentId)).length, 2);
  });
});

test("revocation cannot be reversed or rewritten and repeated owner revocation remains safe", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, mandate } = await intentSetup(store, owner);
    await store.revokeAgent(owner, agent.agentId);
    await store.revokeAgent(owner, agent.agentId);
    for (const [table, column, id] of [["rail_agents", "agent_id", agent.agentId],
      ["rail_agent_credentials", "credential_id", credential.credentialId], ["rail_agent_mandates", "mandate_id", mandate.mandateId]]) {
      for (const value of ["NULL", "revoked_at + interval '1 second'"]) {
        await assert.rejects(pool.query(`UPDATE ${table} SET revoked_at = ${value} WHERE ${column} = $1`, [id]),
          { code: "23514", message: "agent_revocation_is_permanent" });
      }
    }
    await assert.rejects(pool.query("UPDATE rail_agents SET status = 'active', revoked_at = NULL WHERE agent_id = $1", [agent.agentId]),
      { code: "23514", message: "agent_identity_is_immutable" });
    await assert.rejects(store.resolveCredential(credential.token), { status: 401 });
  });
});

test("authority history survives deletion attempts and repeated migrations", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, mandate } = await intentSetup(store, owner);
    await runMigrations(pool);
    for (const [table, column, id] of [["rail_agent_mandates", "mandate_id", mandate.mandateId],
      ["rail_agent_credentials", "credential_id", credential.credentialId], ["rail_agents", "agent_id", agent.agentId]]) {
      await assert.rejects(pool.query(`DELETE FROM ${table} WHERE ${column} = $1`, [id]),
        { code: "23514", message: "agent_control_history_is_immutable" });
    }
    assert.equal((await store.resolveCredential(credential.token)).agentId, agent.agentId);
    assert.equal((await store.listMandates(owner, agent.agentId)).length, 1);
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
      total_budget_minor, allowed_receiver_wallet_ids, created_at, expires_at, consent_receipt_version)
      SELECT gen_random_uuid(), $1, $2, 'budgeted', 'INR', 100, 1000, ARRAY['agent_receiver'], now(), now() + interval '1 day', NULL
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
    const { agent, credential, mandate, input } = await intentSetup(store, owner, "approval_required", 1000,
      (id, value) => datedMandate(pool, owner, id, value, 2));
    const intent = await store.createIntent(credential.token, input);
    await pool.query("SELECT pg_sleep(2.1)");
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

function executionStore(pool, afterPayment, failEvidence = false, riskProtection, agentEvidence = authorityEvidence(), merchantQuotes) {
  const key = { keyId: "agent_execution_v1", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
  const evidence = new TransactionEvidenceStore(new TransactionKeyRing(key.keyId, [key]));
  const pipeline = buildHardenedPaymentPipeline(noopTracer, undefined, undefined, undefined, riskProtection);
  const engine = new PaymentPipelineEngine({ idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer,
    dlq: new MemoryDeadLetterQueue(), riskProtectionRequired: Boolean(riskProtection),
    pipeline: async ctx => { await pipeline(ctx); await afterPayment?.(ctx); },
    evidence: failEvidence ? { async persist(client, txn) { await evidence.persist(client, txn); throw new Error("injected_agent_evidence_failure"); } } : evidence });
  return new AgentAuthorityStore(pool, engine, agentEvidence, merchantQuotes);
}

async function executionSetup(pool, owner, mode = "approval_required", budget = 1000, store = executionStore(pool), deadlineTarget) {
  const setup = await intentSetup(store, owner, mode, budget, deadlineTarget === "mandate"
    ? (id, value) => datedMandate(pool, owner, id, value, 2) : undefined);
  const executionCredential = deadlineTarget === "credential"
    ? await datedCredential(pool, setup.agent.agentId, "payments:execute", 2)
    : await store.issueCredential(owner, setup.agent.agentId, { scope: "payments:execute" });
  const intent = await store.createIntent(setup.credential.token, setup.input);
  const request = { requestFingerprint: intent.requestFingerprint };
  return { ...setup, store, executionCredential, intent, request };
}

test("owner JWT provenance is captured from authenticated context rather than request fields", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner, token }) => {
    const store = executionStore(pool);
    const context = { config: loadServerConfig(), agentStore: store, rateLimiter: new PostgresRateLimiter(pool),
      authResolver: createAuthResolver({ getPool: () => pool, apiKey: "unused", apiKeyScopes: [] }) };
    const agent = await store.createAgent(owner, { name: "JWT consent" });
    const call = async (path, body) => {
      const req = Readable.from([JSON.stringify(body)]); req.method = "POST";
      req.headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }; req.socket = { remoteAddress: "192.0.2.91" };
      const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      assert.equal(await handleAgentRoutes(req, res, new URL(`http://localhost${path}`), context), true);
      return res.body;
    };
    const { mandate } = await call(`/v2/agents/${agent.agentId}/mandates`, { ...policy, mode: "approval_required",
      authentication: { method: "owner_jwt", userId: "forged_user", authVersion: 999 } });
    const credential = await store.issueCredential(owner, agent.agentId, { scope: "payments:execute" });
    const intent = await store.createIntent(credential.token, { mandateId: mandate.mandateId, clientRequestId: "jwt_provenance_001",
      receiverWalletId: "agent_receiver", amountMinor: 100, currency: "INR" });
    const request = { requestFingerprint: intent.requestFingerprint };
    await call(`/v2/agents/${agent.agentId}/intents/${intent.intentId}/decision`, { decision: "approve", ...request, userId: "forged_user" });
    const rows = (await pool.query("SELECT * FROM rail_agent_owner_evidence ORDER BY purpose")).rows;
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.ok(!JSON.stringify(rows).includes("agent_user"));
    await store.executeIntent(credential.token, intent.intentId, request);
    const proof = await store.readAuthority(owner, agent.agentId, intent.intentId);
    assert.equal(proof.status, "verified");
    for (const evidence of [proof.ownerEvidence.mandate, proof.ownerEvidence.approval]) {
      assert.deepEqual(evidence.record.authentication, { walletId: owner, method: "owner_jwt", userId: "agent_user", authVersion: 0 });
    }
    assert.equal(proof.receipt.mandateConsentCommitment, proof.ownerEvidence.mandate.commitment);
    assert.equal(proof.receipt.approvalCommitment, proof.ownerEvidence.approval.commitment);
    await pool.query("UPDATE users SET auth_version=auth_version+1 WHERE user_id='agent_user'");
    assert.equal((await store.readAuthority(owner, agent.agentId, intent.intentId)).status, "verified");
  });
});

test("approval retries preserve original owner evidence and rejection keeps the previous approval history", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, input } = await intentSetup(store, owner);
    const intent = await store.createIntent(credential.token, input), request = { requestFingerprint: intent.requestFingerprint };
    await Promise.all(Array.from({ length: 5 }, () => store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "approve", ...request })));
    const original = (await pool.query("SELECT * FROM rail_agent_owner_evidence WHERE subject_id=$1", [intent.intentId])).rows;
    assert.equal(original.length, 1);
    await store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "approve", ...request });
    assert.deepEqual((await pool.query("SELECT * FROM rail_agent_owner_evidence WHERE subject_id=$1", [intent.intentId])).rows, original);
    await store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "reject", ...request });
    const after = (await pool.query("SELECT * FROM rail_agent_owner_evidence WHERE subject_id=$1 ORDER BY purpose", [intent.intentId])).rows;
    assert.equal(after.length, 2); assert.deepEqual(after[0], original[0]);
    for (const sql of ["UPDATE rail_agent_owner_evidence SET commitment=repeat('a',64)", "DELETE FROM rail_agent_owner_evidence"])
      await assert.rejects(pool.query(`${sql} WHERE subject_id=$1`, [intent.intentId]), { code: "23514" });
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
  });
});

test("budgeted payments bind advance consent without fabricating a per-payment owner decision", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, intent, executionCredential, request } = await executionSetup(pool, owner, "budgeted");
    await store.executeIntent(executionCredential.token, intent.intentId, request);
    const proof = await store.readAuthority(owner, agent.agentId, intent.intentId);
    assert.equal(proof.status, "verified"); assert.equal(proof.ownerEvidence.mandate.record.decision, "mandate_consent");
    assert.equal(proof.ownerEvidence.mandate.record.authentication.method, "trusted_library");
    assert.ok(!proof.ownerEvidence.approval && !proof.receipt.approvalCommitment);
    assert.equal((await pool.query("SELECT * FROM rail_agent_owner_evidence WHERE intent_id=$1", [intent.intentId])).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_evidence_nonces")).rowCount, 2);
  });
});

test("missing consent and decision writers cannot commit authority or move funds", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const real = executionStore(pool);
    const agent = await real.createAgent(owner, { name: "Missing consent" });
    const missing = Object.create(authorityEvidence()); missing.persistOwner = async () => {};
    const store = executionStore(pool, undefined, false, undefined, missing);
    await assert.rejects(store.createMandate(owner, agent.agentId, policy), { code: "23514", message: "agent_mandate_consent_required" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_mandates")).rowCount, 0);
    const setup = await executionSetup(pool, owner, "approval_required", 1000, real);
    await assert.rejects(store.decideIntent(owner, setup.agent.agentId, setup.intent.intentId, { decision: "approve", ...setup.request }),
      { code: "23514", message: "agent_owner_decision_required" });
    assert.equal((await real.listIntents(owner, setup.agent.agentId))[0].status, "pending");
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
  });
});

test("stale or mismatched owner principal rolls back decisions instead of recording false authentication", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, owner }) => {
    const { agent, credential, input } = await intentSetup(store, owner);
    const intent = await store.createIntent(credential.token, input);
    const request = { decision: "approve", requestFingerprint: intent.requestFingerprint };
    await assert.rejects(store.decideIntent(owner, agent.agentId, intent.intentId, request, { walletId: "other_owner", method: "trusted_library" }), /agent_owner_context_invalid/);
    await pool.query("UPDATE users SET auth_version=1 WHERE user_id='agent_user'");
    await assert.rejects(store.decideIntent(owner, agent.agentId, intent.intentId, request,
      { walletId: owner, method: "owner_jwt", userId: "agent_user", authVersion: 0 }), { status: 401 });
    assert.equal((await store.listIntents(owner, agent.agentId))[0].status, "pending");
    assert.equal((await pool.query("SELECT * FROM rail_agent_owner_evidence WHERE intent_id=$1", [intent.intentId])).rowCount, 0);
  });
});

test("corrupted original approval blocks execution and does not create an execution receipt", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, intent, executionCredential, request } = await executionSetup(pool, owner);
    await store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "approve", ...request });
    await pool.query("ALTER TABLE rail_agent_owner_evidence DISABLE TRIGGER rail_agent_owner_evidence_immutable");
    await pool.query("UPDATE rail_agent_owner_evidence SET envelope=jsonb_set(envelope,'{ciphertext}','\"YWJj\"'::jsonb) WHERE subject_id=$1", [intent.intentId]);
    await pool.query("ALTER TABLE rail_agent_owner_evidence ENABLE TRIGGER rail_agent_owner_evidence_immutable");
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), { status: 503, code: "agent_owner_evidence_unavailable" });
    await assert.rejects(store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "approve", ...request }), { status: 503 });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_authority_evidence")).rowCount, 0);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].spentBudgetMinor, 0);
  });
});

test("legacy mandate cannot authorize new proposals and is not advertised as executable", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const store = executionStore(pool), agent = await store.createAgent(owner, { name: "Legacy consent" });
    const credential = await store.issueCredential(owner, agent.agentId, {}), mandateId = randomUUID();
    await pool.query(`INSERT INTO rail_agent_mandates(mandate_id,agent_id,owner_wallet_id,mode,currency,per_payment_limit_minor,
      total_budget_minor,allowed_receiver_wallet_ids,created_at,expires_at,consent_receipt_version)
      VALUES ($1,$2,$3,'budgeted','INR',100,1000,ARRAY['agent_receiver'],clock_timestamp(),clock_timestamp()+interval '1 hour',NULL)`, [mandateId, agent.agentId, owner]);
    await runMigrations(pool);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].executionEnabled, false);
    await assert.rejects(store.createIntent(credential.token, { mandateId, clientRequestId: "legacy_consent_001",
      receiverWalletId: "agent_receiver", amountMinor: 100, currency: "INR" }), { status: 409, code: "new_agent_owner_consent_required" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 0);
  });
});

test("emergency mandate revocation remains available without authority keys and preserves original consent", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { agent, mandate, store } = await executionSetup(pool, owner, "budgeted");
    const original = (await pool.query("SELECT * FROM rail_agent_owner_evidence WHERE mandate_id=$1", [mandate.mandateId])).rows;
    const unavailable = new AgentAuthorityStore(pool);
    await unavailable.revokeMandate(owner, agent.agentId, mandate.mandateId);
    assert.equal((await store.listIntents(owner, agent.agentId))[0].status, "rejected");
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 0);
    assert.deepEqual((await pool.query("SELECT * FROM rail_agent_owner_evidence WHERE mandate_id=$1", [mandate.mandateId])).rows, original);
  });
});

test("agent authority receipts explain both consent modes and preserve original ciphertext on concurrent replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner, other }) => {
    for (const mode of ["approval_required", "budgeted"]) {
      const { store, agent, mandate, intent, executionCredential, request } = await executionSetup(pool, owner, mode);
      assert.equal((await store.readAuthority(owner, agent.agentId, intent.intentId)).status, "not_executed");
      if (mode === "approval_required") await store.decideIntent(owner, agent.agentId, intent.intentId, { decision: "approve", ...request });
      await store.executeIntent(executionCredential.token, intent.intentId, request);
      const before = (await pool.query("SELECT * FROM rail_agent_authority_evidence WHERE intent_id=$1", [intent.intentId])).rows[0];
      assert.equal(before.envelope.purpose, "agent-authority-v1");
      assert.ok(!JSON.stringify(before.envelope).includes("agent_receiver"));
      await Promise.all(Array.from({ length: 5 }, () => store.executeIntent(executionCredential.token, intent.intentId, request)));
      const proof = await store.readAuthority(owner, agent.agentId, intent.intentId);
      assert.equal(proof.status, "verified");
      assert.equal(proof.receipt.assurance, "server_observed_authority");
      assert.equal(proof.receipt.consentSource, mode === "budgeted" ? "advance_budget_mandate" : "exact_approved_intent");
      assert.equal(proof.receipt.intentFingerprint, intent.requestFingerprint);
      assert.equal(proof.receipt.credentialId, executionCredential.credentialId);
      assert.equal(proof.receipt.policy.totalBudgetMinor, mandate.totalBudgetMinor);
      assert.deepEqual(proof.receipt.policy.allowedReceiverWalletIds, ["agent_receiver"]);
      assert.deepEqual((await pool.query("SELECT * FROM rail_agent_authority_evidence WHERE intent_id=$1", [intent.intentId])).rows[0], before);
      await assert.rejects(store.readAuthority(other, agent.agentId, intent.intentId), { status: 404 });
      const otherAgent = await store.createAgent(owner, { name: "Receipt isolation" });
      await assert.rejects(store.readAuthority(owner, otherAgent.agentId, intent.intentId), { status: 404 });
      for (const operation of ["UPDATE rail_agent_authority_evidence SET commitment=repeat('a',64)", "DELETE FROM rail_agent_authority_evidence"]) {
        await assert.rejects(pool.query(`${operation} WHERE intent_id=$1`, [intent.intentId]), { code: "23514" });
      }
      await assert.rejects(pool.query("UPDATE rail_agent_intents SET authority_receipt_version=NULL WHERE intent_id=$1", [intent.intentId]), { code: "23514" });
    }
    assert.equal((await pool.query("SELECT record_count FROM rail_agent_evidence_key_usage")).rows[0].record_count, "5");
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT count(*) FROM rail_agent_authority_evidence")).rows[0].count, "2");
  });
});

test("required agent authority write failure rolls back financial state, evidence, replay and key quota", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, intent, executionCredential, request } = await executionSetup(pool, owner, "budgeted");
    await pool.query(`CREATE FUNCTION fail_authority_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected_authority_write_failure'; END $$;
      CREATE TRIGGER fail_authority_write BEFORE INSERT ON rail_agent_authority_evidence FOR EACH ROW EXECUTE FUNCTION fail_authority_write()`);
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), /injected_authority_write_failure/);
    for (const table of ["ledger_entries", "authorizations", "rail_transaction_evidence", "rail_agent_authority_evidence", "rail_idempotency"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    assert.equal((await pool.query("SELECT record_count FROM rail_agent_evidence_key_usage")).rows[0].record_count, "1");
    assert.equal((await store.listIntents(owner, agent.agentId))[0].status, "approved");
    assert.equal((await store.listMandates(owner, agent.agentId))[0].reservedBudgetMinor, 100);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].spentBudgetMinor, 0);
    await pool.query("DROP TRIGGER fail_authority_write ON rail_agent_authority_evidence");
    await store.executeIntent(executionCredential.token, intent.intentId, request);
    assert.equal((await store.readAuthority(owner, agent.agentId, intent.intentId)).status, "verified");
  });
});

test("database rejects committing a new agent execution without its required authority receipt", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const missing = Object.create(authorityEvidence()); missing.persist = async () => {};
    const store = executionStore(pool, undefined, false, undefined, missing);
    const { agent, intent, executionCredential, request } = await executionSetup(pool, owner, "budgeted", 1000, store);
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), { code: "23514", message: "agent_authority_evidence_missing_or_mismatched" });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].spentBudgetMinor, 0);
    assert.equal((await store.listIntents(owner, agent.agentId))[0].status, "approved");
  });
});

test("authority key rotation retains old verification and missing keys never yield verified replay", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, intent, executionCredential, request } = await executionSetup(pool, owner, "budgeted");
    await store.executeIntent(executionCredential.token, intent.intentId, request);
    const next = { keyId: "agent_authority_rotated", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
    const retained = executionStore(pool, undefined, false, undefined, new AgentEvidenceStore(new TransactionKeyRing(next.keyId, [authorityKey, next])));
    assert.equal((await retained.readAuthority(owner, agent.agentId, intent.intentId)).status, "verified");
    await retained.executeIntent(executionCredential.token, intent.intentId, request);
    const lost = executionStore(pool, undefined, false, undefined, new AgentEvidenceStore(new TransactionKeyRing(next.keyId, [next])));
    assert.deepEqual(await lost.readAuthority(owner, agent.agentId, intent.intentId), { status: "verification_unavailable", reason: "key_unavailable" });
    await assert.rejects(lost.executeIntent(executionCredential.token, intent.intentId, request), { status: 503 });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.equal((await pool.query("SELECT * FROM rail_agent_authority_evidence")).rowCount, 1);
  });
});

test("agent authority key quota rolls back rejected spending and never evicts committed receipts", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const store = executionStore(pool, undefined, false, undefined, new AgentEvidenceStore(new TransactionKeyRing(authorityKey.keyId, [authorityKey], 3)));
    const first = await executionSetup(pool, owner, "budgeted", 1000, store);
    const second = await executionSetup(pool, owner, "budgeted", 1000, store);
    await store.executeIntent(first.executionCredential.token, first.intent.intentId, first.request);
    await assert.rejects(store.executeIntent(second.executionCredential.token, second.intent.intentId, second.request), /agent_authority_key_rotation_required/);
    assert.equal((await pool.query("SELECT * FROM rail_agent_authority_evidence")).rowCount, 1);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.equal((await store.listMandates(owner, second.agent.agentId))[0].spentBudgetMinor, 0);
    assert.equal((await store.readAuthority(owner, first.agent.agentId, first.intent.intentId)).status, "verified");
  });
});

test("authority explanation endpoint is owner JWT only, scoped and non-cacheable", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner, token }) => {
    const { store, agent, intent, executionCredential, request } = await executionSetup(pool, owner, "budgeted");
    await store.executeIntent(executionCredential.token, intent.intentId, request);
    const context = { config: loadServerConfig(), agentStore: store, rateLimiter: new PostgresRateLimiter(pool),
      authResolver: createAuthResolver({ getPool: () => pool, apiKey: "unused", apiKeyScopes: [] }) };
    const url = new URL(`http://localhost/v2/agents/${agent.agentId}/intents/${intent.intentId}/authority`);
    for (const bearer of [executionCredential.token, token]) {
      const req = Readable.from([]); req.method = "GET"; req.headers = { authorization: `Bearer ${bearer}` }; req.socket = { remoteAddress: "192.0.2.90" };
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      if (bearer === token) {
        assert.equal(await handleAgentRoutes(req, res, url, context), true);
        assert.equal(res.status, 200); assert.equal(res.headers["Cache-Control"], "no-store");
        assert.equal(res.body.authority.status, "verified");
        assert.ok(!JSON.stringify(res.body).includes(executionCredential.token));
      } else await assert.rejects(handleAgentRoutes(req, res, url, context), { status: 401 });
    }
  });
});

test("agent spending fails closed when authority protection is not configured", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const store = executionStore(pool, undefined, false, undefined, null);
    const agent = await store.createAgent(owner, { name: "Unconfigured authority" });
    assert.equal(agent.executionEnabled, false);
    await assert.rejects(store.issueCredential(owner, agent.agentId, { scope: "payments:execute" }), { status: 503 });
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 0);
  });
});

test("corrupted authority storage is unavailable and cannot turn replay into another transfer", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const { store, agent, intent, executionCredential, request } = await executionSetup(pool, owner, "budgeted");
    await store.executeIntent(executionCredential.token, intent.intentId, request);
    // Administrator-only corruption fixture; ordinary runtime UPDATE remains blocked.
    await pool.query("ALTER TABLE rail_agent_authority_evidence DISABLE TRIGGER rail_agent_evidence_immutable");
    await pool.query("UPDATE rail_agent_authority_evidence SET envelope=jsonb_set(envelope,'{ciphertext}','\"YWJj\"'::jsonb) WHERE intent_id=$1", [intent.intentId]);
    await pool.query("ALTER TABLE rail_agent_authority_evidence ENABLE TRIGGER rail_agent_evidence_immutable");
    assert.deepEqual(await store.readAuthority(owner, agent.agentId, intent.intentId), { status: "verification_unavailable", reason: "verification_failed" });
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), { status: 503 });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].spentBudgetMinor, 100);
  });
});

test("legacy unexecuted intents require a new request rather than invented historical authority evidence", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    // Seed the pre-upgrade nullable marker at creation; immutable history is not rewritten.
    await pool.query("ALTER TABLE rail_agent_intents ALTER COLUMN authority_receipt_version DROP DEFAULT");
    const { store, intent, executionCredential, request } = await executionSetup(pool, owner, "budgeted");
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT authority_receipt_version FROM rail_agent_intents WHERE intent_id=$1", [intent.intentId])).rows[0].authority_receipt_version, null);
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), { status: 409, code: "new_agent_intent_required" });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_authority_evidence")).rowCount, 0);
  });
});

test("protected agent risk failure preserves held budget and retry commits one encrypted observation", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, owner }) => {
    const key = { keyId: "agent_risk_v1", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
    const protection = new RiskProtectionStore(new TransactionKeyRing(key.keyId, [key]));
    const store = executionStore(pool, undefined, false, protection);
    const { agent, executionCredential, intent, request } = await executionSetup(pool, owner, "budgeted", 100, store);
    await pool.query(`CREATE FUNCTION reject_risk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'agent_risk_write_failure'; END $$;
      CREATE TRIGGER reject_risk BEFORE INSERT ON rail_protected_risk FOR EACH ROW EXECUTE FUNCTION reject_risk()`);
    await assert.rejects(store.executeIntent(executionCredential.token, intent.intentId, request), /agent_risk_write_failure/);
    const held = (await store.listMandates(owner, agent.agentId))[0];
    assert.equal(held.reservedBudgetMinor, 100); assert.equal(held.spentBudgetMinor, 0);
    for (const table of ["ledger_entries", "rail_protected_risk", "rail_risk_key_usage", "rail_transaction_evidence", "rail_idempotency"])
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    await pool.query("DROP TRIGGER reject_risk ON rail_protected_risk");
    const results = await Promise.all(Array.from({ length: 6 }, () => store.executeIntent(executionCredential.token, intent.intentId, request)));
    assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])));
    const row = (await pool.query("SELECT * FROM rail_protected_risk")).rows[0];
    const decoded = decryptRiskRecord(row.envelope, { txId: row.tx_id, requestFingerprint: row.request_fingerprint }, key);
    assert.equal(decoded.features.agentBudgetExposure, 1);
    assert.equal((await pool.query("SELECT feature_snapshot FROM rail_risk_observations")).rows[0].feature_snapshot, null);
    assert.equal((await pool.query("SELECT * FROM rail_protected_risk")).rowCount, 1);
    assert.equal((await store.listMandates(owner, agent.agentId))[0].spentBudgetMinor, 100);
  }, 1);
});

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
      const store = executionStore(pool, async ctx => { await ctx.dbClient.query("SELECT pg_sleep(2.1)"); });
      setup = await executionSetup(pool, owner, "budgeted", 1000, store, target);
      await assert.rejects(store.executeIntent(setup.executionCredential.token, setup.intent.intentId, setup.request), { status: target === "credential" ? 401 : 409 });
      assert.equal((await store.listMandates(owner, setup.agent.agentId))[0].spentBudgetMinor, 0);
      assert.equal((await store.listIntents(owner, setup.agent.agentId))[0].status, target === "mandate" ? "expired" : "approved");
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
