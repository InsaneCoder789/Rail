import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import nodeHttp from "node:http";
import { once } from "node:events";
import { hash, compare } from "bcryptjs";
import { Pool } from "pg";
import dotenv from "dotenv";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { OwnerPasskeyStore, loadOwnerPasskeyConfig, ENROLLMENT_FINGERPRINT, RECOVERY_CODES_FINGERPRINT, revokePasskeyFingerprint } from "../dist/persistence/ownerPasskeys.js";
import { runMigrations, ensureOutboxSchema } from "../dist/persistence/migrate.js";
import { handlePasskeyRoutes } from "../dist/server/routes/passkeyRoutes.js";
import { createAuthResolver } from "../dist/server/authentication.js";
import { generateToken, verifyToken } from "../dist/auth/jwt.js";
import { loadServerConfig } from "../dist/server/config.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";
import { AgentAuthorityStore, credentialOperationFingerprint, credentialRotationFingerprint, mandateOperationFingerprint, approvalOperationFingerprint } from "../dist/persistence/agentAuthority.js";
import { AgentEvidenceStore } from "../dist/persistence/agentEvidence.js";
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";
import { TransactionEvidenceStore } from "../dist/persistence/transactionEvidence.js";
import { PaymentPipelineEngine } from "../dist/pipeline/engine.js";
import { PostgresIdempotencyStore } from "../dist/persistence/postgresIdempotency.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";
import { handleAgentRoutes } from "../dist/server/routes/agentRoutes.js";
import { createAuthorization } from "../dist/stages/authorizationStage.js";
import { PostgresOfflineTokenStore } from "../dist/persistence/postgresOfflineTokenStore.js";
import { AgentProofStore } from "../dist/persistence/agentProofs.js";
import { agentBodyDigest, agentKeyThumbprint } from "../dist/crypto/agentProof.js";
import { sharedBudgetOperationFingerprint } from "../dist/persistence/sharedBudgets.js";
import { AgentClient, AgentClientError } from "../dist/rail/agentClient.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runAgentSimulation } from "../dist/demo/runAgentSimulator.js";
import { ProviderTargetRegistry } from "../dist/domain/providerTargets.js";
import { providerPaymentConsentFingerprint } from "../dist/domain/providerPayment.js";
import { dispatchProviderBatch, LocalPaymentSimulator } from "../dist/persistence/providerWorker.js";
import { StripeTestProvider } from "../dist/rail/stripeProvider.js";
import Stripe from "stripe";
import { StripeCallbackInbox, processStripeCallbacks } from "../dist/persistence/stripeCallbacks.js";
import { authorizeProviderPaymentInTransaction, advanceProviderPaymentInTransaction, createProviderPaymentInTransaction,
  readProviderPaymentInTransaction } from "../dist/persistence/providerPayments.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
const config = { rpId: "rail.example", origin: "https://rail.example" };
const fingerprint = "a".repeat(64);
const principal = { walletId: "owner_wallet", userId: "owner_user", authVersion: 0, method: "owner_jwt", sessionFingerprint: "b".repeat(64) };
const password = "passkey_fixture_password";

async function fixture(work, ownerBalance = 0) {
  const schema = `ci_passkeys_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
  const secret = process.env.RAIL_SIGNING_SECRET;
  process.env.RAIL_SIGNING_SECRET = "passkey_engine_fixture_secret_01234567890123456789";
  try {
    await runMigrations(pool); await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO wallets(wallet_id,balance) VALUES('owner_wallet',$1),('other_wallet',0)", [ownerBalance]);
    const passwordHash = await hash(password, 4);
    await pool.query("INSERT INTO users(user_id,password_hash,wallet_id) VALUES('owner_user',$1,'owner_wallet'),('other_user',$1,'other_wallet')", [passwordHash]);
    await work({ pool, store: new OwnerPasskeyStore(pool, config) });
  } finally {
    if (secret === undefined) delete process.env.RAIL_SIGNING_SECRET; else process.env.RAIL_SIGNING_SECRET = secret;
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
}

function agentStores(pool, passkeys, targets, simulatorExecution = false) {
  const key = id => ({ keyId: id, encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) });
  const authorityKey = key("stepped_authority"), paymentKey = key("stepped_payment");
  const authority = new AgentEvidenceStore(new TransactionKeyRing(authorityKey.keyId, [authorityKey]));
  const engine = new PaymentPipelineEngine({ idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer,
    dlq: new MemoryDeadLetterQueue(), pipeline: buildHardenedPaymentPipeline(noopTracer),
    evidence: new TransactionEvidenceStore(new TransactionKeyRing(paymentKey.keyId, [paymentKey])) });
  const serializeKey = key => JSON.stringify({ activeKeyId: key.keyId, keys: [{ keyId: key.keyId,
    encryptionKey: key.encryptionKey.toString("base64"), authenticationKey: key.authenticationKey.toString("base64") }] });
  return { authority, engine, workerKeyEnvironment: { RAIL_EVIDENCE_KEY_RING: serializeKey(paymentKey),
    RAIL_RISK_RECORD_KEY_RING: serializeKey(key("stepped_risk")), RAIL_AGENT_AUTHORITY_KEY_RING: serializeKey(authorityKey) },
    strict: new AgentAuthorityStore(pool, engine, authority, undefined, { required: true, store: passkeys }, undefined, targets, simulatorExecution),
    legacy: new AgentAuthorityStore(pool, engine, authority) };
}
const mandatePolicy = { mode: "approval_required", currency: "INR", perPaymentLimitMinor: 100,
  totalBudgetMinor: 1000, allowedReceiverWalletIds: ["other_wallet"], ttlSeconds: 3600 };

function authenticator(algorithm = -7, coseOverride) {
  const pair = algorithm === -8 ? generateKeyPairSync("ed25519") : algorithm === -257 ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : generateKeyPairSync("ec", { namedCurve: "prime256v1" }), id = randomBytes(32);
  const jwk = pair.publicKey.export({ format: "jwk" });
  const bytes = value => new Uint8Array(Buffer.from(value, "base64url"));
  const fields = algorithm === -8 ? [[1, 1], [3, -8], [-1, 6], [-2, bytes(jwk.x)]] : algorithm === -257
    ? [[1, 3], [3, -257], [-1, bytes(jwk.n)], [-2, bytes(jwk.e)]]
    : [[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]];
  const cose = Buffer.from(isoCBOR.encode(coseOverride ?? new Map(fields)));
  const clientData = (type, challenge, changes) => Buffer.from(JSON.stringify({ type, challenge, origin: config.origin, crossOrigin: false, ...changes }));
  const rpHash = createHash("sha256").update(config.rpId).digest();
  return {
    id: id.toString("base64url"),
    registration(challenge, changes = {}, flags = 0x45) {
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, id, cose]);
      const object = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]));
      return { id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: clientData("webauthn.create", challenge, changes).toString("base64url"), attestationObject: Buffer.from(object).toString("base64url"), transports: ["internal"] } };
    },
    assertion(challenge, count = 1, changes = {}, flags = 0x05) {
      const client = clientData("webauthn.get", challenge, changes), counter = Buffer.alloc(4); counter.writeUInt32BE(count);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), counter]);
      const signature = sign(algorithm === -8 ? null : "sha256", Buffer.concat([authData, createHash("sha256").update(client).digest()]), pair.privateKey);
      return { id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: client.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") } };
    },
  };
}

test("safe Ed25519 and RSA passkeys pass real registration, assertions and grant consumption", { skip: !databaseUrl }, async () => {
  for (const algorithm of [-8, -257]) await fixture(async ({ pool, store }) => {
    const key = authenticator(algorithm), registration = await store.registrationOptions(principal, { password });
    await store.register(principal, { challengeId: registration.challengeId, response: key.registration(registration.options.challenge) });
    const authorization = await grant(store, key);
    assert.equal((await consume(pool, store, authorization.grantToken)).method, "passkey");
  });
});

test("owner enrollment rejects degenerate Ed25519 and weak RSA keys and consumes failed challenges", { skip: !databaseUrl }, async () => {
  const identity = Buffer.alloc(32); identity[0] = 1;
  for (const cose of [new Map([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(identity)]]),
    new Map([[1, 3], [3, -257], [-1, new Uint8Array(Buffer.alloc(256, 255))], [-2, new Uint8Array([1])]])])
    await fixture(async ({ pool, store }) => {
      const key = authenticator(-8, cose), request = await store.registrationOptions(principal, { password });
      await assert.rejects(store.register(principal, { challengeId: request.challengeId, response: key.registration(request.options.challenge) }), { code: "passkey_verification_failed" });
      assert.equal((await pool.query("SELECT * FROM rail_owner_passkeys")).rowCount, 0);
      assert.ok((await pool.query("SELECT used_at FROM rail_owner_challenges WHERE challenge_id=$1", [request.challengeId])).rows[0].used_at);
    });
});

test("legacy unsafe passkeys cannot forge assertions or consume already-stored grants", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    await enroll(store);
    const identity = Buffer.alloc(32); identity[0] = 1;
    const cose = new Map([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(identity)]]), weak = authenticator(-8, cose);
    await pool.query(`INSERT INTO rail_owner_passkeys(credential_id,user_id,public_key,sign_count,device_type,backed_up)
      VALUES($1,$2,$3,0,'singleDevice',false)`, [weak.id, principal.userId, Buffer.from(isoCBOR.encode(cose))]);
    const request = await store.authenticationOptions(principal, { operation: "agent_approval", operationFingerprint: fingerprint });
    const response = weak.assertion(request.options.challenge), signature = Buffer.alloc(64); signature[0] = 1;
    response.response.signature = signature.toString("base64url");
    await assert.rejects(store.authenticate(principal, { challengeId: request.challengeId, response }), { code: "passkey_verification_failed" });
    assert.equal((await pool.query("SELECT * FROM rail_owner_step_up_grants")).rowCount, 0);
    const pending = await store.authenticationOptions(principal, { operation: "agent_approval", operationFingerprint: fingerprint });
    await pool.query("UPDATE rail_owner_challenges SET used_at=clock_timestamp() WHERE challenge_id=$1", [pending.challengeId]);
    const token = `rail_step_up_${randomBytes(32).toString("base64url")}`, tokenHash = createHash("sha256").update(token).digest("hex");
    await pool.query(`WITH instant AS(SELECT clock_timestamp() AS now)
      INSERT INTO rail_owner_step_up_grants(token_hash,challenge_id,credential_id,user_id,auth_version,session_fingerprint,
        operation,operation_fingerprint,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,'agent_approval',$7,now,now+interval '2 minutes' FROM instant`,
      [tokenHash, pending.challengeId, weak.id, principal.userId, principal.authVersion, principal.sessionFingerprint, fingerprint]);
    await assert.rejects(consume(pool, store, token), { code: "owner_step_up_required" });
    assert.equal((await pool.query("SELECT consumed_at FROM rail_owner_step_up_grants WHERE token_hash=$1", [tokenHash])).rows[0].consumed_at, null);
  });
});
async function enroll(store, owner = principal) {
  const key = authenticator(), request = await store.registrationOptions(owner, { password });
  const result = await store.register(owner, { challengeId: request.challengeId, response: key.registration(request.options.challenge) });
  key.recoveryCodes = result.recoveryCodes;
  return key;
}
const replacementPassword = "recovered_password_0123456789";
function recoveredPrincipal(result) {
  return { ...principal, ...verifyToken(result.token), sessionFingerprint: createHash("sha256").update(result.token).digest("hex") };
}
async function recovery(store, key, owner = principal, currentPassword = password, nextPassword = replacementPassword, codeIndex = 0) {
  const result = await store.recover(owner, { password: currentPassword, newPassword: nextPassword, recoveryCode: key.recoveryCodes[codeIndex] });
  return { result, owner: recoveredPrincipal(result) };
}
async function finishRecovery(store, restored) {
  const options = await store.registrationOptions(restored.owner, { recoveryToken: restored.result.recoveryToken }), key = authenticator();
  const result = await store.register(restored.owner, { challengeId: options.challengeId, response: key.registration(options.options.challenge) });
  key.recoveryCodes = result.recoveryCodes;
  return { key, result };
}
async function grant(store, key, owner = principal, operation = "agent_approval", operationFingerprint = fingerprint, count = 1) {
  const request = await store.authenticationOptions(owner, { operation, operationFingerprint });
  return store.authenticate(owner, { challengeId: request.challengeId, response: key.assertion(request.options.challenge, count) });
}

async function providerTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    const result = await work(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function externalConsentFixture(work) {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict, authority } = agentStores(pool, store);
    const agent = await strict.createAgent(principal.walletId, { name: "External consent fixture" });
    let counter = 0;
    const permission = (operation, digest) => grant(store, key, principal, operation, digest, ++counter);
    const terms = { name: "Combined allowance", currency: "INR", totalBudgetMinor: 1000, ttlSeconds: 3600, agentIds: [agent.agentId] };
    const budgetGrant = await permission("shared_budget", sharedBudgetOperationFingerprint("create", null, terms));
    const budget = await strict.createSharedBudget(principal.walletId, { ...terms, grantToken: budgetGrant.grantToken }, principal);
    const policy = { ...mandatePolicy, mode: "budgeted", perPaymentLimitMinor: 1000, sharedBudgetId: budget.budgetId };
    const mandateGrant = await permission("agent_mandate", mandateOperationFingerprint(agent.agentId, policy));
    const mandate = await strict.createMandate(principal.walletId, agent.agentId, { ...policy, grantToken: mandateGrant.grantToken }, principal);
    const binding = () => ({ version: 1, operationId: randomUUID(), ownerWalletId: principal.walletId, agentId: agent.agentId,
      mandateId: mandate.mandateId, sharedBudgetId: budget.budgetId, intentId: randomUUID(), provider: "simulator",
      providerAccountRef: "account_fixture", merchantRef: "merchant_fixture", instrumentRef: "instrument_fixture",
      amountMinor: 100, currency: "INR", requestFingerprint: "a".repeat(64), authorizationExpiresAt: new Date(Date.now() + 60000).toISOString() });
    const approve = (value, merchant = "other_wallet") => permission("provider_payment", providerPaymentConsentFingerprint(value, merchant));
    const authorize = (value, consent, merchant = "other_wallet", owner = principal) => providerTransaction(pool, client =>
      authorizeProviderPaymentInTransaction(client, { binding: value, trustedMerchantWalletId: merchant, principal: owner, grantToken: consent?.grantToken }, store, authority));
    const change = (value, event) => providerTransaction(pool, client => advanceProviderPaymentInTransaction(client,
      { ownerWalletId: value.binding.ownerWalletId, operationId: value.binding.operationId, fingerprint: value.fingerprint }, event));
    const observe = (value, status) => ({ type: "provider_observed", observation: { operationId: value.binding.operationId,
      fingerprint: value.fingerprint, provider: value.binding.provider, providerAccountRef: value.binding.providerAccountRef,
      providerRef: `payment_${value.binding.operationId}`, amountMinor: value.binding.amountMinor, currency: value.binding.currency,
      status, final: ["succeeded", "failed", "cancelled"].includes(status) } });
    const totals = async () => (await pool.query("SELECT reserved_budget_minor,spent_budget_minor FROM rail_shared_budgets WHERE budget_id=$1", [budget.budgetId])).rows[0];
    await work({ pool, store, strict, authority, key, agent, budget, mandate, binding, permission, approve, authorize, change, observe, totals });
    assert.equal((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
    assert.deepEqual((await pool.query("SELECT balance FROM wallets ORDER BY wallet_id")).rows, [{ balance: "0" }, { balance: "0" }]);
  });
}

test("external admission requires fresh exact-payment passkey consent and replays one budget hold", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, binding, approve, authorize, permission, totals }) => {
    const input = binding();
    await assert.rejects(authorize(input), { code: "owner_step_up_required" });
    const internal = await permission("agent_approval", approvalOperationFingerprint(input.agentId, input.intentId, input.requestFingerprint));
    await assert.rejects(authorize(input, internal), { code: "owner_step_up_required" });
    const consent = await approve(input);
    await assert.rejects(authorize({ ...input, amountMinor: 101 }, consent), { code: "owner_step_up_required" });
    const admitted = await authorize(input, consent);
    assert.equal(admitted.authorizationRequired, true);
    await runMigrations(pool);
    assert.deepEqual(await authorize(input, consent), admitted);
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
    await assert.rejects(pool.query("UPDATE rail_shared_budgets SET reserved_budget_minor=99"), { code: "23514" });
    await assert.rejects(pool.query("UPDATE rail_agent_mandates SET reserved_budget_minor=99"), { code: "23514" });
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_consents")).rows[0].count, "1");
    await assert.rejects(pool.query("UPDATE rail_provider_payment_consents SET merchant_wallet_id='owner_wallet'"), { code: "23514" });
    await assert.rejects(pool.query("DELETE FROM rail_provider_payment_consents"), { code: "23514" });
  });
});

test("external admission shares the same mandate and shared envelope as internal holds", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ strict, agent, mandate, binding, approve, authorize, permission, totals }) => {
    const credential = { scope: "payments:propose" };
    const consent = await permission("agent_credential", credentialOperationFingerprint(agent.agentId, credential));
    const token = await strict.issueCredential(principal.walletId, agent.agentId, { ...credential, grantToken: consent.grantToken }, principal);
    const internal = await strict.createIntent(token.token, { mandateId: mandate.mandateId, clientRequestId: "internal_allowance_fixture", receiverWalletId: "other_wallet", amountMinor: 650, currency: "INR" });
    const large = { ...binding(), amountMinor: 400 }, grantLarge = await approve(large);
    await assert.rejects(authorize(large, grantLarge), /provider_mandate_budget_unavailable/);
    assert.deepEqual(await totals(), { reserved_budget_minor: "650", spent_budget_minor: "0" });
    const fitting = { ...binding(), amountMinor: 350 };
    await authorize(fitting, await approve(fitting));
    assert.deepEqual(await totals(), { reserved_budget_minor: "1000", spent_budget_minor: "0" });
    await strict.decideIntent(principal.walletId, agent.agentId, internal.intentId,
      { decision: "reject", requestFingerprint: internal.requestFingerprint }, principal);
    await authorize(large, grantLarge);
    assert.deepEqual(await totals(), { reserved_budget_minor: "750", spent_budget_minor: "0" });
  });
});

test("parallel exact external approvals cannot oversubscribe an allowance", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ binding, approve, authorize, totals }) => {
    const first = { ...binding(), amountMinor: 650 }, second = { ...binding(), amountMinor: 650 };
    const firstGrant = await approve(first), secondGrant = await approve(second);
    const results = await Promise.allSettled([authorize(first, firstGrant), authorize(second, secondGrant)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.deepEqual(await totals(), { reserved_budget_minor: "650", spent_budget_minor: "0" });
  });
});

test("agent revocation cancels unsubmitted external work but preserves unknown liabilities for reconciliation", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, strict, agent, binding, approve, authorize, change, observe, totals }) => {
    const a = binding(), b = binding();
    const unsubmitted = await authorize(a, await approve(a));
    const held = await authorize(b, await approve(b));
    const submitted = await change(held, { type: "begin_submission", idempotencyWindowMs: 60000 });
    const unknown = await change(submitted, { type: "submission_uncertain" });
    await strict.revokeAgent(principal.walletId, agent.agentId);
    const cancelled = await providerTransaction(pool, client => readProviderPaymentInTransaction(client, principal.walletId, unsubmitted.binding.operationId));
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
    await assert.rejects(change(unknown, { type: "retry_submission" }), /PROVIDER_AUTHORITY_WITHDRAWN/);
    const final = await change(unknown, observe(unknown, "succeeded"));
    assert.equal(final.status, "succeeded");
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "100" });
    assert.deepEqual(await change(final, observe(final, "succeeded")), final);
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "100" });
  });
});

test("external confirmation after owner recovery preserves liabilities without retaining spending authority", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, store, key, binding, approve, authorize, change, observe, totals }) => {
    const terms = binding(), admitted = await authorize(terms, await approve(terms));
    const submitted = await change(admitted, { type: "begin_submission", idempotencyWindowMs: 60000 });
    await recovery(store, key);
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
    await assert.rejects(change(submitted, { type: "retry_submission" }), /PROVIDER_AUTHORITY_WITHDRAWN/);
    await change(submitted, observe(submitted, "failed"));
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_consents")).rows[0].count, "1");
  });
});

test("external admission failure rolls back grant consumption, journal and both budget counters", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, store, authority, binding, approve, authorize, totals }) => {
    const input = binding(), consent = await approve(input);
    await assert.rejects(providerTransaction(pool, async client => {
      await authorizeProviderPaymentInTransaction(client, { binding: input, trustedMerchantWalletId: "other_wallet", principal, grantToken: consent.grantToken }, store, authority);
      throw new Error("external_commit_failure_fixture");
    }), /external_commit_failure_fixture/);
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payments")).rows[0].count, "0");
    await authorize(input, consent);
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
  });
});

test("external deferred commit failure restores exact consent and allows the same payment to retry", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, binding, approve, authorize, totals }) => {
    const input = binding(), consent = await approve(input);
    await pool.query(`CREATE FUNCTION reject_external_commit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'external_deferred_failure_fixture'; END $$;
      CREATE CONSTRAINT TRIGGER reject_external_commit_fixture AFTER INSERT ON rail_provider_payment_consents
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_external_commit_fixture()`);
    await assert.rejects(authorize(input, consent), /external_deferred_failure_fixture/);
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payments")).rows[0].count, "0");
    await pool.query("DROP TRIGGER reject_external_commit_fixture ON rail_provider_payment_consents");
    await authorize(input, consent);
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
  });
});

test("external expiry releases only unsubmitted holds and keeps an expired unknown payment reconcilable", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ strict, agent, binding, approve, authorize, change, observe, totals }) => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const first = { ...binding(), authorizationExpiresAt: expiresAt }, second = { ...binding(), authorizationExpiresAt: expiresAt };
    await authorize(first, await approve(first));
    const held = await authorize(second, await approve(second));
    const submitted = await change(held, { type: "begin_submission", idempotencyWindowMs: 60000 });
    const unknown = await change(submitted, { type: "submission_uncertain" });
    await new Promise(resolve => setTimeout(resolve, 2100));
    await strict.listMandates(principal.walletId, agent.agentId);
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
    await assert.rejects(change(unknown, { type: "retry_submission" }), /PROVIDER_AUTHORIZATION_EXPIRED/);
    await change(unknown, observe(unknown, "failed"));
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
  });
});

test("external required-operation markers cannot commit without their exact consent record", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, binding, totals }) => {
    await assert.rejects(providerTransaction(pool, client =>
      createProviderPaymentInTransaction(client, binding(), { authorizationRequired: true })), /provider_owner_consent_binding_invalid/);
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payments")).rows[0].count, "0");
  });
});

test("external policy errors restore consent when the outer transaction catches them and continues", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, store, authority, binding, approve, totals }) => {
    const input = binding(), consent = await approve(input, "unapproved_merchant");
    await providerTransaction(pool, async client => {
      await client.query("INSERT INTO outbox(type,payload) VALUES('caller.before_external','{}')");
      await assert.rejects(authorizeProviderPaymentInTransaction(client, { binding: input,
        trustedMerchantWalletId: "unapproved_merchant", principal, grantToken: consent.grantToken }, store, authority), /PROVIDER_POLICY_DENIED/);
      assert.equal((await client.query("SELECT consumed_at FROM rail_owner_step_up_grants WHERE token_hash=$1",
        [createHash("sha256").update(consent.grantToken).digest("hex")])).rows[0].consumed_at, null);
    });
    assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE type='caller.before_external'")).rows[0].count, "1");
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
  });
});

test("external unknown holds survive membership withdrawal and confirmed cancellation releases them once", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ strict, agent, budget, binding, approve, authorize, change, observe, totals }) => {
    const terms = binding(), admitted = await authorize(terms, await approve(terms));
    const started = await change(admitted, { type: "begin_submission", idempotencyWindowMs: 60000 });
    const unknown = await change(started, { type: "submission_uncertain" });
    await strict.changeSharedBudget(principal.walletId, budget.budgetId, "member_remove", { agentId: agent.agentId }, principal);
    assert.deepEqual(await totals(), { reserved_budget_minor: "100", spent_budget_minor: "0" });
    await assert.rejects(change(unknown, { type: "retry_submission" }), { code: "shared_budget_inactive" });
    const cancelled = await change(unknown, observe(unknown, "cancelled"));
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
    assert.deepEqual(await change(cancelled, observe(cancelled, "cancelled")), cancelled);
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "0" });
  });
});

test("external budget revocation releases only unsubmitted holds and preserves committed spending", { skip: !databaseUrl }, async () => {
  await externalConsentFixture(async ({ pool, strict, budget, binding, approve, authorize, change, observe, totals }) => {
    const first = binding(), second = binding();
    const a = await authorize(first, await approve(first)), b = await authorize(second, await approve(second));
    const started = await change(a, { type: "begin_submission", idempotencyWindowMs: 60000 });
    await change(started, observe(started, "succeeded"));
    await strict.changeSharedBudget(principal.walletId, budget.budgetId, "revoke", {}, principal);
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "100" });
    const cancelled = await providerTransaction(pool, client => readProviderPaymentInTransaction(client, principal.walletId, b.binding.operationId));
    assert.equal(cancelled.status, "cancelled");
    await strict.changeSharedBudget(principal.walletId, budget.budgetId, "revoke", {}, principal);
    assert.deepEqual(await totals(), { reserved_budget_minor: "0", spent_budget_minor: "100" });
  });
});

test("shared budget HTTP controls require exact owner passkey consent and preserve unused grants after substitution", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "shared_owner_http_fixture_secret_01234567890123456789";
    try {
      const key = await enroll(store), { strict } = agentStores(pool, store);
      const agent = await strict.createAgent(principal.walletId, { name: "Shared HTTP agent" });
      const terms = { name: "Shared HTTP budget", currency: "INR", totalBudgetMinor: 1000, ttlSeconds: 3600, agentIds: [agent.agentId] };
      const token = generateToken(principal.userId), owner = { ...principal, sessionFingerprint: createHash("sha256").update(token).digest("hex") };
      const context = { config: loadServerConfig(), agentStore: strict, rateLimiter: new PostgresRateLimiter(pool),
        authResolver: createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] }) };
      const call = async (body, path = "/v2/budgets", method = "POST") => {
        const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); req.method = method; req.url = path;
        req.headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }; req.socket = { remoteAddress: "192.0.2.41" };
        const headers = {}, res = { setHeader(name, value) { headers[name] = value; }, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
        assert.equal(await handleAgentRoutes(req, res, new URL(`https://rail.example${path}`), context), true);
        assert.equal(headers["Cache-Control"], "no-store");
        return res;
      };
      await assert.rejects(call(terms), { code: "owner_step_up_required" });
      const permission = await grant(store, key, owner, "shared_budget", sharedBudgetOperationFingerprint("create", null, terms));
      await assert.rejects(call({ ...terms, totalBudgetMinor: 1001, grantToken: permission.grantToken }), { code: "owner_step_up_required" });
      const response = await call({ ...terms, grantToken: permission.grantToken });
      assert.equal(response.status, 201);
      assert.equal(response.body.budget.totalBudgetMinor, 1000);
      assert.equal((await call(undefined, "/v2/budgets", "GET")).body.budgets.length, 1);
      const changes = (await pool.query("SELECT * FROM rail_shared_budget_controls")).rows;
      assert.equal(changes.length, 1); assert.ok(changes[0].step_up_challenge_id);
      await assert.rejects(pool.query("UPDATE rail_shared_budget_controls SET step_up_challenge_id=NULL"), /shared_budget_history_is_immutable/);
    } finally { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; }
  });
});

test("shared budget proof-bound execution and recovery retain atomic financial and owner-consent boundaries", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential, http }) => {
    const terms = { name: "Shared signed journey", currency: "INR", totalBudgetMinor: 1000, agentIds: [agent.agentId] };
    const create = await grant(store, ownerKey, principal, "shared_budget", sharedBudgetOperationFingerprint("create", null, terms), 2);
    const budget = await strict.createSharedBudget(principal.walletId, { ...terms, grantToken: create.grantToken }, principal);
    const policy = { ...mandatePolicy, mode: "budgeted", sharedBudgetId: budget.budgetId };
    const permission = await grant(store, ownerKey, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy), 3);
    const mandate = await strict.createMandate(principal.walletId, agent.agentId, { ...policy, grantToken: permission.grantToken }, principal);
    const input = { mandateId: mandate.mandateId, clientRequestId: "shared_signed_first", receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" };
    const first = (await http("POST", "/v2/agent/intents", input, { signed: true })).body.intent;
    const request = { requestFingerprint: first.requestFingerprint };
    const executed = await http("POST", `/v2/agent/intents/${first.intentId}/execute`, request, { signed: true });
    assert.equal(executed.body.result.status, "accepted");
    await http("POST", "/v2/agent/intents", { ...input, clientRequestId: "shared_signed_pending" }, { signed: true });
    const before = (await strict.listSharedBudgets(principal.walletId, principal))[0];
    assert.deepEqual([before.reservedBudgetMinor, before.spentBudgetMinor], [100, 100]);
    const consent = await strict.readAuthority(principal.walletId, agent.agentId, first.intentId);
    assert.equal(consent.receipt.policy.sharedBudgetId, budget.budgetId);
    assert.equal(consent.ownerEvidence.mandate.record.policy.sharedBudgetId, budget.budgetId);
    const recovered = await recovery(store, ownerKey);
    const state = (await pool.query("SELECT * FROM rail_shared_budgets WHERE budget_id=$1", [budget.budgetId])).rows[0];
    assert.deepEqual([state.reserved_budget_minor, state.spent_budget_minor], ["0", "100"]);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    await assert.rejects(strict.resolveCredential(credential.token), { code: "invalid_agent_credentials" });
    assert.ok(recovered.owner.authVersion > principal.authVersion);
  }, "payments:execute", 1000);
});

test("strict shared spending rejects an unstepped latest limit until the owner approves a new revision", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, http }) => {
    const terms = { name: "Latest consent", currency: "INR", totalBudgetMinor: 1000, agentIds: [agent.agentId] };
    const create = await grant(store, ownerKey, principal, "shared_budget", sharedBudgetOperationFingerprint("create", null, terms), 2);
    const budget = await strict.createSharedBudget(principal.walletId, { ...terms, grantToken: create.grantToken }, principal);
    const policy = { ...mandatePolicy, mode: "budgeted", sharedBudgetId: budget.budgetId };
    const permission = await grant(store, ownerKey, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy), 3);
    const mandate = await strict.createMandate(principal.walletId, agent.agentId, { ...policy, grantToken: permission.grantToken }, principal);
    const legacy = agentStores(pool, store).legacy;
    await legacy.changeSharedBudget(principal.walletId, budget.budgetId, "limit", { revision: 1, totalBudgetMinor: 1001 });
    const input = { mandateId: mandate.mandateId, clientRequestId: "latest_shared_consent", receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" };
    await assert.rejects(http("POST", "/v2/agent/intents", input, { signed: true }), { code: "fresh_shared_budget_consent_required" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 0);
    const change = { revision: 2, totalBudgetMinor: 1000 };
    const authorization = await grant(store, ownerKey, principal, "shared_budget", sharedBudgetOperationFingerprint("limit", budget.budgetId, change), 4);
    await strict.changeSharedBudget(principal.walletId, budget.budgetId, "limit", { ...change, grantToken: authorization.grantToken }, principal);
    assert.equal((await http("POST", "/v2/agent/intents", input, { signed: true })).body.intent.status, "approved");
  });
});

test("three independent simulator processes coordinate a shared allowance and recover a lost execution reply through actual HTTP and PostgreSQL", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential, key, context }) => {
    const agents = [{ agent, credential, key }];
    let counter = 1;
    for (let i = 0; i < 2; i++) {
      const next = await strict.createAgent(principal.walletId, { name: `SDK independent agent ${i}` }), nextKey = generateKeyPairSync("ed25519");
      const terms = { scope: "payments:execute", ttlSeconds: 3600, publicKey: nextKey.publicKey.export({ format: "jwk" }) };
      const permission = await grant(store, ownerKey, principal, "agent_credential", credentialOperationFingerprint(next.agentId, terms), ++counter);
      agents.push({ agent: next, key: nextKey, credential: await strict.issueCredential(principal.walletId, next.agentId, { ...terms, grantToken: permission.grantToken }, principal) });
    }
    const terms = { name: "Three real clients", currency: "INR", totalBudgetMinor: 1000, agentIds: agents.map(item => item.agent.agentId) };
    const authorization = await grant(store, ownerKey, principal, "shared_budget", sharedBudgetOperationFingerprint("create", null, terms), ++counter);
    const budget = await strict.createSharedBudget(principal.walletId, { ...terms, grantToken: authorization.grantToken }, principal);
    for (const item of agents) {
      const policy = { ...mandatePolicy, mode: "budgeted", perPaymentLimitMinor: 1000, sharedBudgetId: budget.budgetId };
      const permission = await grant(store, ownerKey, principal, "agent_mandate", mandateOperationFingerprint(item.agent.agentId, policy), ++counter);
      item.mandate = await strict.createMandate(principal.walletId, item.agent.agentId, { ...policy, grantToken: permission.grantToken }, principal);
    }
    let origin, dropNextExecute = false;
    const server = nodeHttp.createServer(async (req, res) => {
      try {
        if (dropNextExecute && req.url.endsWith("/execute")) {
          dropNextExecute = false;
          // The route ends its response after commit; discard only that reply, not the payment.
          res.end = () => { res.destroy(); return res; };
        }
        if (!await handleAgentRoutes(req, res, new URL(req.url, origin), { ...context, config: { ...context.config, agentApiOrigin: origin } })) {
          res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not_found"}');
        }
      } catch (error) {
        res.writeHead(error.status ?? 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.code ?? "test_server_failure" }));
      }
    });
    server.listen(0); await once(server, "listening"); origin = `http://localhost:${server.address().port}`;
    const directory = await mkdtemp(join(tmpdir(), "rail-three-agents-"));
    try {
      const clients = agents.map(item => new AgentClient({ origin, token: item.credential.token, privateKey: item.key.privateKey, allowLocalHttp: true }));
      const amounts = [650, 350, 250];
      const requests = agents.map((item, index) => ({ mandateId: item.mandate.mandateId, clientRequestId: randomUUID(),
        receiverWalletId: "other_wallet", amountMinor: amounts[index], currency: "INR", ttlSeconds: 300 }));
      const simulate = async (index, action) => {
        const item = agents[index];
        const path = join(directory, `agent-${index}.pem`);
        await writeFile(path, item.key.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
        return new Promise((resolve, reject) => {
          // Each process receives exactly one agent's configuration, never the server environment.
          const child = spawn(process.execPath, ["dist/demo/runAgentSimulator.js", action], {
            env: { NODE_ENV: "test", RAIL_DEMO_MODE: "true", RAIL_AGENT_ORIGIN: origin, RAIL_AGENT_TOKEN: item.credential.token,
              RAIL_AGENT_PRIVATE_KEY_PATH: path, RAIL_AGENT_MANDATE_ID: requests[index].mandateId,
              RAIL_AGENT_REQUEST_ID: requests[index].clientRequestId, RAIL_AGENT_RECEIVER_WALLET_ID: "other_wallet",
              RAIL_AGENT_AMOUNT_MINOR: String(amounts[index]), RAIL_AGENT_CURRENCY: "INR" }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
          let output = "", diagnostic = "";
          child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { diagnostic += chunk; });
          child.on("error", reject); child.on("close", code => {
            try {
              assert.ok(output.length + diagnostic.length < 4096);
              if (code === 0) resolve(JSON.parse(output));
              else { const error = JSON.parse(diagnostic); reject(new AgentClientError(error.httpStatus, error.code)); }
            } catch { reject(new Error("simulator_process_failed")); }
          });
        });
      };
      const results = await Promise.allSettled(agents.map((_, index) => simulate(index, "propose")));
      const winners = results.map((result, index) => ({ result, index })).filter(item => item.result.status === "fulfilled");
      const loser = results.findIndex(result => result.status === "rejected");
      assert.equal(winners.length, 2);
      assert.ok(results[loser].reason instanceof AgentClientError);
      assert.equal(results[loser].reason.code, "shared_budget_exceeded");
      const target = winners[0].result.value;
      await assert.rejects(clients[winners[0].index].proposeIntent({ ...requests[winners[0].index], amountMinor: target.amountMinor + 1 }),
        { status: 409, code: "intent_request_reused" });
      await assert.rejects(clients[loser].executeIntent(target.intentId, target.requestFingerprint), { status: 404, code: "intent_not_found" });
      for (const { result, index } of winners) {
        if (index === winners[0].index) {
          dropNextExecute = true;
          await assert.rejects(simulate(index, "execute"), { status: 0, code: "agent_network_error" });
          assert.equal((await simulate(index, "status")).status, "executed");
        }
        const response = await simulate(index, "execute");
        assert.equal(response.status, "executed");
      }
      const total = winners.reduce((sum, item) => sum + amounts[item.index], 0);
      const current = (await strict.listSharedBudgets(principal.walletId, principal))[0];
      assert.deepEqual([current.reservedBudgetMinor, current.spentBudgetMinor, current.availableBudgetMinor], [0, total, 1000 - total]);
      assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 4);
      assert.equal((await clients[loser].listIntents()).length, 0);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
  }, "payments:execute", 1000);
});

test("failed shared budget control audit restores consumed owner consent and creates no budget", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict } = agentStores(pool, store);
    const agent = await strict.createAgent(principal.walletId, { name: "Rollback shared authority" });
    const terms = { name: "Rollback budget", currency: "INR", totalBudgetMinor: 1000, agentIds: [agent.agentId] };
    const permission = await grant(store, key, principal, "shared_budget", sharedBudgetOperationFingerprint("create", null, terms));
    await pool.query(`CREATE FUNCTION reject_shared_control() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='agent.shared_budget_created' THEN RAISE EXCEPTION 'injected_shared_control_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_shared_control BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_shared_control()`);
    const value = { ...terms, grantToken: permission.grantToken };
    await assert.rejects(strict.createSharedBudget(principal.walletId, value, principal), /injected_shared_control_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_shared_budgets")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_shared_budget_controls")).rowCount, 0);
    assert.equal((await pool.query("SELECT consumed_at FROM rail_owner_step_up_grants WHERE token_hash=$1", [createHash("sha256").update(permission.grantToken).digest("hex")])).rows[0].consumed_at, null);
    await pool.query("DROP TRIGGER reject_shared_control ON outbox");
    assert.equal((await strict.createSharedBudget(principal.walletId, value, principal)).totalBudgetMinor, 1000);
  });
});
async function consume(pool, store, token, operation = "agent_approval", expected = fingerprint, owner = principal, rollback = false) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await store.consumeGrant(client, owner, token, operation, expected); await client.query(rollback ? "ROLLBACK" : "COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function proofFixture(work, scope = "payments:propose", balance = 0, targets, simulatorExecution = false) {
  return fixture(async ({ pool, store }) => {
    const ownerKey = await enroll(store), { strict, authority, engine, workerKeyEnvironment } = agentStores(pool, store, targets, simulatorExecution);
    const agent = await strict.createAgent(principal.walletId, { name: "proof_agent" });
    const key = generateKeyPairSync("ed25519"), publicKey = key.publicKey.export({ format: "jwk" });
    const terms = { publicKey, scope, ttlSeconds: 120 };
    const authorized = await grant(store, ownerKey, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, terms));
    const credential = await strict.issueCredential(principal.walletId, agent.agentId, { ...terms, grantToken: authorized.grantToken }, principal);
    const proofs = new AgentProofStore(pool);
    const request = { method: "POST", url: "https://rail.example/v2/agent/intents", body: Buffer.from('{"amountMinor":100}') };
    function proof(nonce, changes = {}, signer = key.privateKey, spec = request, token = credential.token) {
      const header = { typ: "dpop+jwt", alg: "EdDSA", jwk: publicKey };
      const claims = { htm: spec.method, htu: spec.url, iat: Math.floor(Date.now() / 1000), jti: randomBytes(32).toString("base64url"),
        ath: createHash("sha256").update(token).digest("base64url"), nonce, rail_body_sha256: agentBodyDigest(spec.body), ...changes };
      const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
      return `${input}.${sign(null, Buffer.from(input), signer).toString("base64url")}`;
    }
    const context = { config: { ...loadServerConfig(), agentApiOrigin: "https://rail.example" }, agentProofs: proofs,
      agentStore: strict, rateLimiter: new PostgresRateLimiter(pool) };
    async function http(method, path, value, options = {}) {
      const raw = options.raw ?? (value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)));
      let signature = options.proof;
      if (options.signed) {
        const challenge = await http("POST", "/v2/agent/nonces", {});
        signature = proof(challenge.body.nonce, {}, key.privateKey, { method, url: `https://rail.example${path}`, body: raw });
      }
      const req = Readable.from(raw.length ? [raw] : []); req.url = path; req.method = method;
      req.headers = { authorization: options.authorization ?? `DPoP ${credential.token}`, host: options.host ?? "rail.example",
        ...(signature ? { dpop: signature } : {}), ...(value === undefined ? {} : { "content-type": "application/json" }) };
      req.socket = { remoteAddress: "192.0.2.1" };
      const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
      assert.equal(await handleAgentRoutes(req, res, new URL(`https://rail.example${path}`), options.context ?? context), true);
      return res;
    }
    await work({ pool, store, strict, authority, engine, workerKeyEnvironment, ownerKey, agent, credential, proofs, request, proof, key, publicKey, http, context });
  }, balance);
}

const providerTargetFixture = { version: 1, targetId: "fixture_trip", revision: 1, ownerWalletId: "owner_wallet", provider: "simulator",
  providerAccountRef: "account_fixture", instrumentRef: "instrument_fixture", merchantWalletId: "other_wallet", merchantRef: "merchant_fixture", currency: "INR", status: "active" };

async function providerProposalFixture(work, scope = "payments:propose", simulatorExecution = false, target = providerTargetFixture) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "provider_http_fixture_jwt_secret_01234567890123456789";
  try {
    await proofFixture(async fixture => {
      const { strict, store, ownerKey, agent, pool, engine, authority } = fixture;
      const terms = { name: "Signed provider proposals", currency: "INR", totalBudgetMinor: 1000, ttlSeconds: 3600, agentIds: [agent.agentId] };
      const budgetGrant = await grant(store, ownerKey, principal, "shared_budget", sharedBudgetOperationFingerprint("create", null, terms), 2);
      const budget = await strict.createSharedBudget(principal.walletId, { ...terms, grantToken: budgetGrant.grantToken }, principal);
      const policy = { ...mandatePolicy, mode: "budgeted", perPaymentLimitMinor: 1000, sharedBudgetId: budget.budgetId };
      const mandateGrant = await grant(store, ownerKey, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy), 3);
      const mandate = await strict.createMandate(principal.walletId, agent.agentId, { ...policy, grantToken: mandateGrant.grantToken }, principal);
      const token = generateToken(principal.userId), owner = { ...principal, sessionFingerprint: createHash("sha256").update(token).digest("hex") };
      let counter = 3;
      const consent = value => grant(store, ownerKey, owner, "provider_payment", value, ++counter);
      const replacement = value => new AgentAuthorityStore(pool, engine, authority, undefined, { required: true, store }, undefined,
        new ProviderTargetRegistry(JSON.stringify([value])));
      const input = { mandateId: mandate.mandateId, clientRequestId: "signed_provider_fixture", targetId: "fixture_trip", amountMinor: 100, currency: "INR" };
      await work({ ...fixture, input, budget, owner, token, consent, replacement });
    }, scope, 0, new ProviderTargetRegistry(JSON.stringify([target])), simulatorExecution);
  } finally { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; }
}

async function queuedProviderFixture(work, fault = "none") {
  await providerProposalFixture(async f => {
    await f.http("POST", "/v2/agent/provider-payments", f.input, { signed: true });
    const proposal = (await f.strict.listOwnerProviderProposals(f.owner.walletId, f.agent.agentId, f.owner))[0];
    const permission = await f.consent(proposal.consentFingerprint);
    await f.strict.authorizeProviderProposal(f.owner.walletId, f.agent.agentId, proposal.operationId,
      { requestFingerprint: proposal.requestFingerprint, grantToken: permission.grantToken }, f.owner);
    const path = `/v2/agent/provider-payments/${proposal.operationId}/execute`;
    const body = { requestFingerprint: proposal.requestFingerprint };
    const queue = () => f.http("POST", path, body, { signed: true });
    const targets = new ProviderTargetRegistry(JSON.stringify([providerTargetFixture]));
    const simulator = new LocalPaymentSimulator(f.pool, fault);
    const drain = (adapter = simulator, registry = targets, options = {}) => dispatchProviderBatch(f.pool, registry, adapter, { batchSize: 1, evidence: f.authority, ...options });
    const ready = () => f.pool.query("UPDATE outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE provider_operation_id IS NOT NULL");
    const state = async () => (await f.pool.query(`SELECT payment.status,budget.reserved_budget_minor,budget.spent_budget_minor
      FROM rail_provider_payments payment JOIN rail_shared_budgets budget ON budget.budget_id=payment.shared_budget_id
      WHERE operation_id=$1`, [proposal.operationId])).rows[0];
    await work({ ...f, proposal, path, body, queue, targets, simulator, drain, ready, state });
    assert.equal((await f.pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
  }, "payments:execute", true);
}

async function stripeQueuedFixture(work, fault = "none", enabled = true) {
  const target = { ...providerTargetFixture, provider: "stripe", providerAccountRef: "acct_fixture", merchantRef: "acct_fixture", instrumentRef: "pm_fixture" };
  await providerProposalFixture(async f => {
    await f.pool.query("CREATE TABLE stripe_test_effects(operation_id UUID PRIMARY KEY,intent JSONB NOT NULL)");
    await f.http("POST", "/v2/agent/provider-payments", f.input, { signed: true });
    const proposal = (await f.strict.listOwnerProviderProposals(f.owner.walletId, f.agent.agentId, f.owner))[0];
    const permission = await f.consent(proposal.consentFingerprint);
    await f.strict.authorizeProviderProposal(f.owner.walletId, f.agent.agentId, proposal.operationId,
      { requestFingerprint: proposal.requestFingerprint, grantToken: permission.grantToken }, f.owner);
    let creates = 0;
    const client = { accounts: { retrieve: async () => ({ id: "acct_fixture" }) },
      paymentMethods: { retrieve: async () => ({ id: "pm_fixture", livemode: false, type: "card", customer: "cus_fixture" }) },
      paymentIntents: {
        create: async params => {
          creates++;
          const intent = { id: `pi_${params.metadata.rail_operation_id.replaceAll("-", "")}`, object: "payment_intent", livemode: false,
            amount: params.amount, amount_received: params.amount, amount_capturable: 0, currency: params.currency,
            customer: params.customer, payment_method: params.payment_method, payment_method_types: ["card"],
            capture_method: "automatic", confirmation_method: "automatic", on_behalf_of: null, transfer_data: null,
            application_fee_amount: null, metadata: params.metadata, status: "succeeded" };
          await f.pool.query("INSERT INTO stripe_test_effects VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING", [proposal.operationId, JSON.stringify(intent)]);
          if (fault === "lose_reply") throw new Error("mock_stripe_reply_lost");
          return (await f.pool.query("SELECT intent FROM stripe_test_effects WHERE operation_id=$1", [proposal.operationId])).rows[0].intent;
        },
        list: async () => ({ data: (await f.pool.query("SELECT intent FROM stripe_test_effects")).rows.map(row => row.intent), has_more: false }),
        retrieve: async id => (await f.pool.query("SELECT intent FROM stripe_test_effects WHERE intent->>'id'=$1", [id])).rows[0].intent
      } };
    const adapter = () => new StripeTestProvider({ secretKey: `sk_test_${"a".repeat(32)}`, accountId: "acct_fixture",
      instruments: [{ ownerWalletId: f.owner.walletId, paymentMethodId: "pm_fixture", customerId: "cus_fixture" }] }, client);
    const targets = new ProviderTargetRegistry(JSON.stringify([target]));
    const drain = (provider = adapter()) => dispatchProviderBatch(f.pool, targets, provider, { evidence: f.authority, batchSize: 1 });
    const queue = () => f.http("POST", `/v2/agent/provider-payments/${proposal.operationId}/execute`, { requestFingerprint: proposal.requestFingerprint }, { signed: true });
    const ready = () => f.pool.query("UPDATE outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE provider_operation_id IS NOT NULL");
    const state = async () => (await f.pool.query(`SELECT payment.status,budget.reserved_budget_minor,budget.spent_budget_minor
      FROM rail_provider_payments payment JOIN rail_shared_budgets budget ON budget.budget_id=payment.shared_budget_id`)).rows[0];
    await work({ ...f, proposal, queue, drain, ready, state, adapter, client, creates: () => creates });
    assert.equal((await f.pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
  }, "payments:execute", { simulator: !enabled, stripe: enabled }, target);
}

test("Stripe test jobs are provider-isolated and atomically resolve allowance with versioned protected API evidence", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async ({ pool, queue, drain, state, strict, owner, agent, proposal, creates }) => {
    await queue(); await queue();
    assert.deepEqual(await drain(new LocalPaymentSimulator(pool)), { resolved: 0, pending: 0, lostLease: 0 });
    assert.equal((await drain()).resolved, 1);
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
    const original = await strict.readProviderOutcome(owner.walletId, agent.agentId, proposal.operationId, owner);
    assert.equal(original.status, "verified"); assert.equal(original.receipt.version, 2);
    assert.equal(original.receipt.assurance, "server_observed_stripe_test_api");
    assert.equal(original.receipt.provenance.kind, "stripe_test_api");
    await queue(); await drain(); assert.equal(creates(), 1);
    assert.deepEqual(await strict.readProviderOutcome(owner.walletId, agent.agentId, proposal.operationId, owner), original);
    await assert.rejects(pool.query("UPDATE rail_provider_payments SET outcome_provenance=NULL,revision=revision+1"), { code: "23514" });
  });
});

test("Stripe lost reply remains held and read-only recovery works after agent revocation without another charge", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async ({ queue, drain, ready, state, strict, owner, agent, creates }) => {
    await queue(); assert.equal((await drain()).pending, 1);
    assert.deepEqual(await state(), { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" });
    await strict.revokeAgent(owner.walletId, agent.agentId, owner);
    await ready(); assert.equal((await drain()).resolved, 1);
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
    assert.equal(creates(), 1);
  }, "lose_reply");
});

test("Stripe receipt failure rolls back provenance and accounting while preserving the independently stored effect", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async ({ pool, queue, drain, ready, state, creates }) => {
    await pool.query(`CREATE FUNCTION fail_stripe_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stripe_receipt_fault'; END $$;
      CREATE TRIGGER fail_stripe_receipt BEFORE INSERT ON rail_provider_outcome_evidence FOR EACH ROW EXECUTE FUNCTION fail_stripe_receipt()`);
    await queue(); assert.equal((await drain()).pending, 1);
    assert.deepEqual(await state(), { status: "submitting", reserved_budget_minor: "100", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT outcome_provenance FROM rail_provider_payments")).rows[0].outcome_provenance, null);
    await pool.query("DROP TRIGGER fail_stripe_receipt ON rail_provider_outcome_evidence");
    await ready(); assert.equal((await drain()).resolved, 1); assert.equal(creates(), 1);
  });
});

test("Stripe revocation before submission creates a cancellation receipt without inventing API evidence", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async ({ queue, drain, strict, owner, agent, proposal, creates }) => {
    await queue(); await strict.revokeAgent(owner.walletId, agent.agentId, owner);
    assert.equal((await drain()).resolved, 1); assert.equal(creates(), 0);
    const result = await strict.readProviderOutcome(owner.walletId, agent.agentId, proposal.operationId, owner);
    assert.equal(result.status, "verified"); assert.equal(result.receipt.assurance, "server_cancelled_before_submission");
    assert.equal(result.receipt.provenance, undefined);
  });
});

async function stripeCallback(f, eventId = `evt_${randomUUID().replaceAll("-", "")}`) {
  const intent = (await f.pool.query("SELECT intent FROM stripe_test_effects")).rows[0].intent;
  const raw = Buffer.from(JSON.stringify({ id: eventId, type: "payment_intent.payment_failed", livemode: false,
    data: { object: { object: "payment_intent", id: intent.id, status: "failed", amount: 1 } } }));
  const webhookSecret = `whsec_${"c".repeat(32)}`;
  const inbox = new StripeCallbackInbox(f.pool, { accountId: "acct_fixture", webhookSecret });
  await inbox.accept(raw, Stripe.webhooks.generateTestHeaderString({ payload: raw.toString(), secret: webhookSecret }));
  return eventId;
}

test("Stripe callbacks validate current API state and recover lost IDs without trusting snapshot amounts or posting money", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async f => {
    await f.queue(); await f.drain();
    const eventId = await stripeCallback(f);
    f.client.paymentIntents.list = async () => { throw new Error("customer_list_unavailable"); };
    assert.equal((await processStripeCallbacks(f.pool, f.adapter())).processed, 1);
    assert.deepEqual(await f.state(), { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" });
    const event = (await f.pool.query("SELECT * FROM rail_stripe_callback_inbox WHERE event_id=$1", [eventId])).rows[0];
    assert.equal(event.processing_result, "matched"); assert.equal(event.operation_id, f.proposal.operationId);
    assert.equal(event.request_fingerprint, f.proposal.requestFingerprint);
    assert.equal((await f.drain()).resolved, 1); assert.equal(f.creates(), 1);
    assert.deepEqual(await f.state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
    await assert.rejects(f.pool.query("UPDATE rail_stripe_callback_inbox SET operation_id=NULL"), { code: "23514" });
  }, "lose_reply");
});

test("Stripe callback hint failure rolls back job wakeup and retries without losing liability", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async f => {
    await f.queue(); await f.drain(); await stripeCallback(f);
    await f.pool.query("UPDATE outbox SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE provider_operation_id IS NOT NULL");
    await f.pool.query(`CREATE FUNCTION fail_callback_hint() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.processed_at IS NOT NULL THEN RAISE EXCEPTION 'hint_fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_callback_hint BEFORE UPDATE ON rail_stripe_callback_inbox FOR EACH ROW EXECUTE FUNCTION fail_callback_hint()`);
    assert.equal((await processStripeCallbacks(f.pool, f.adapter(), { batchSize: 1 })).pending, 1);
    assert.equal((await f.pool.query("SELECT operation_id FROM rail_stripe_callback_inbox")).rows[0].operation_id, null);
    assert.equal((await f.pool.query("SELECT next_attempt_at>clock_timestamp() AS delayed FROM outbox WHERE provider_operation_id IS NOT NULL")).rows[0].delayed, true);
    await f.pool.query("DROP TRIGGER fail_callback_hint ON rail_stripe_callback_inbox");
    await f.pool.query("UPDATE rail_stripe_callback_inbox SET next_attempt_at=clock_timestamp()-interval '1 second'");
    assert.equal((await processStripeCallbacks(f.pool, f.adapter())).processed, 1);
    assert.equal((await f.drain()).resolved, 1); assert.equal(f.creates(), 1);
  }, "lose_reply");
});

test("Stripe callback processing survives revocation and stale consumers cannot overwrite a reclaimed lease", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async f => {
    await f.queue(); await f.drain(); await stripeCallback(f);
    await f.strict.revokeAgent(f.owner.walletId, f.agent.agentId, f.owner);
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const actual = f.adapter();
    const paused = { accountId: actual.accountId, callbackSnapshot: async id => {
      const value = await actual.callbackSnapshot(id); entered(); await gate; return value;
    } };
    const old = processStripeCallbacks(f.pool, paused, { batchSize: 1, leaseMs: 30000, timeoutMs: 15000 });
    await reached;
    await f.pool.query("UPDATE rail_stripe_callback_inbox SET lease_expires_at=clock_timestamp()-interval '1 second'");
    assert.equal((await processStripeCallbacks(f.pool, actual)).processed, 1);
    release(); assert.equal((await old).lostLease, 1);
    assert.equal((await f.drain()).resolved, 1); assert.equal(f.creates(), 1);
  }, "lose_reply");
});

test("contradictory Stripe callback outcomes remain pending investigation and preserve original receipts", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async f => {
    await f.queue(); await f.drain();
    const original = await f.strict.readProviderOutcome(f.owner.walletId, f.agent.agentId, f.proposal.operationId, f.owner);
    await f.pool.query(`UPDATE stripe_test_effects SET intent=jsonb_set(jsonb_set(intent,'{status}','"canceled"'),'{amount_received}','0')`);
    await stripeCallback(f);
    assert.equal((await processStripeCallbacks(f.pool, f.adapter(), { batchSize: 1 })).pending, 1);
    const row = (await f.pool.query("SELECT processed_at,last_error FROM rail_stripe_callback_inbox")).rows[0];
    assert.equal(row.processed_at, null); assert.equal(row.last_error, "conflicting_provider_outcome");
    assert.deepEqual(await f.strict.readProviderOutcome(f.owner.walletId, f.agent.agentId, f.proposal.operationId, f.owner), original);
    assert.deepEqual(await f.state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
  });
});

test("Stripe callbacks cannot turn an approved but unsubmitted operation into execution authority", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async f => {
    await f.queue();
    // Model an out-of-band provider object, not a Rail-authorized submission.
    await f.client.paymentIntents.create({ amount: 100, currency: "inr", customer: "cus_fixture", payment_method: "pm_fixture",
      metadata: { rail_operation_id: f.proposal.operationId, rail_fingerprint: f.proposal.requestFingerprint } });
    await stripeCallback(f);
    assert.equal((await processStripeCallbacks(f.pool, f.adapter(), { batchSize: 1 })).pending, 1);
    assert.deepEqual(await f.state(), { status: "reserved", reserved_budget_minor: "100", spent_budget_minor: "0" });
    assert.equal((await f.pool.query("SELECT processed_at FROM rail_stripe_callback_inbox")).rows[0].processed_at, null);
  });
});

test("Stripe callback operation fingerprints cannot substitute another financial request", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async f => {
    await f.queue(); await f.drain();
    await f.pool.query(`UPDATE stripe_test_effects SET intent=jsonb_set(intent,'{metadata,rail_fingerprint}',to_jsonb(repeat('b',64)))`);
    await stripeCallback(f);
    assert.equal((await processStripeCallbacks(f.pool, f.adapter(), { batchSize: 1 })).pending, 1);
    assert.deepEqual(await f.state(), { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" });
    assert.equal((await f.pool.query("SELECT last_error FROM rail_stripe_callback_inbox")).rows[0].last_error, "stripe_callback_correlation_conflict");
  }, "lose_reply");
});

test("Stripe execution stays disabled when only simulator permission is enabled", { skip: !databaseUrl }, async () => {
  await stripeQueuedFixture(async ({ queue, pool, creates }) => {
    await assert.rejects(queue(), { code: "provider_target_unavailable" });
    assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE provider_operation_id IS NOT NULL")).rows[0].count, "0");
    assert.equal(creates(), 0);
  }, "none", false);
});

test("simulator execution requires execution scope and explicit enablement, never just proposal authority", { skip: !databaseUrl }, async () => {
  await providerProposalFixture(async ({ http }) => {
    await assert.rejects(http("POST", `/v2/agent/provider-payments/${randomUUID()}/execute`, { requestFingerprint: fingerprint }, { signed: true }),
      { code: "provider_execution_unavailable" });
  });
  await providerProposalFixture(async ({ http, pool }) => {
    await assert.rejects(http("POST", `/v2/agent/provider-payments/${randomUUID()}/execute`, { requestFingerprint: fingerprint }, { signed: true }),
      { code: "agent_execution_scope_required" });
    assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE provider_operation_id IS NOT NULL")).rows[0].count, "0");
  }, "payments:propose", true);
});

test("simulator queue admits exact signed approved terms once and rejects changed terms, raw fields and unapproved operations", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, http, path, body, drain, state, proposal, input }) => {
    await assert.rejects(http("POST", path, { ...body, requestFingerprint: fingerprint }, { signed: true }), { code: "provider_execution_binding_mismatch" });
    await assert.rejects(http("POST", path, { ...body, instrumentRef: "injected" }, { signed: true }), { code: "invalid_agent_request" });
    await assert.rejects(http("POST", `/v2/agent/provider-payments/${randomUUID()}/execute`, body, { signed: true }), { code: "provider_payment_not_found" });
    const unapproved = (await http("POST", "/v2/agent/provider-payments", { ...input, clientRequestId: "unapproved_execution_request" }, { signed: true })).body.proposals[0];
    await assert.rejects(http("POST", `/v2/agent/provider-payments/${unapproved.operationId}/execute`,
      { requestFingerprint: unapproved.requestFingerprint }, { signed: true }), { code: "provider_payment_not_found" });
    assert.equal((await queue()).status, 202); assert.equal((await queue()).status, 202);
    assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE provider_operation_id=$1", [proposal.operationId])).rows[0].count, "1");
    assert.deepEqual(await drain(), { resolved: 1, pending: 0, lostLease: 0 });
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
    assert.equal((await queue()).status, 202);
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "1");
    await runMigrations(pool); await ensureOutboxSchema(pool);
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "1");
    await assert.rejects(pool.query("UPDATE outbox SET provider_proof_id='changed' WHERE provider_operation_id IS NOT NULL"), /provider_job_binding_is_immutable/);
    await assert.rejects(pool.query("UPDATE outbox SET delivery_status='dead_letter' WHERE provider_operation_id IS NOT NULL"), /invalid_provider_job/);
    await assert.rejects(pool.query("DELETE FROM outbox WHERE provider_operation_id IS NOT NULL"), /provider_job_is_durable/);
  });
});

test("simulator outcome receipts bind consent and final accounting, survive replay and reject tampering", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ pool, queue, drain, strict, owner, agent, proposal }) => {
    const readReceipt = () => strict.readProviderOutcome(owner.walletId, agent.agentId, proposal.operationId, owner);
    assert.deepEqual(await readReceipt(), { status: "not_final" });
    await queue(); assert.equal((await drain()).resolved, 1);
    const original = await readReceipt();
    assert.equal(original.status, "verified");
    assert.equal(original.receipt.assurance, "local_simulator_outcome");
    assert.equal(original.receipt.paymentFingerprint, proposal.requestFingerprint);
    assert.equal(original.receipt.consentFingerprint, proposal.consentFingerprint);
    assert.equal(original.receipt.allowanceDisposition, "spent");
    const otherOwner = { ...owner, userId: "other_user", walletId: "other_wallet" };
    await assert.rejects(strict.readProviderOutcome(otherOwner.walletId, agent.agentId, proposal.operationId, otherOwner));
    await queue(); await drain();
    assert.deepEqual(await readReceipt(), original);
    const beforeMigration = (await pool.query("SELECT * FROM rail_provider_outcome_evidence")).rows;
    const historyBeforeMigration = await strict.listProviderHistory(owner.walletId, agent.agentId, proposal.operationId, owner);
    const allowanceBeforeMigration = (await pool.query("SELECT reserved_budget_minor,spent_budget_minor FROM rail_shared_budgets")).rows;
    await runMigrations(pool); await ensureOutboxSchema(pool);
    assert.deepEqual((await pool.query("SELECT * FROM rail_provider_outcome_evidence")).rows, beforeMigration);
    assert.deepEqual(await readReceipt(), original);
    assert.deepEqual(await strict.listProviderHistory(owner.walletId, agent.agentId, proposal.operationId, owner), historyBeforeMigration);
    assert.deepEqual((await pool.query("SELECT reserved_budget_minor,spent_budget_minor FROM rail_shared_budgets")).rows, allowanceBeforeMigration);
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_outcome_evidence")).rows[0].count, "1");
    await assert.rejects(strict.readProviderOutcome(owner.walletId, agent.agentId, randomUUID(), owner), { code: "provider_payment_not_found" });
    await assert.rejects(pool.query("DELETE FROM rail_provider_outcome_evidence"), /provider_outcome_evidence_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_provider_outcome_evidence SET commitment=repeat('a',64)"), /provider_outcome_evidence_is_immutable/);
    // Privileged corruption is isolated test data, not an ordinary permitted update.
    await pool.query("ALTER TABLE rail_provider_outcome_evidence DISABLE TRIGGER rail_provider_outcome_immutable");
    await pool.query("UPDATE rail_provider_outcome_evidence SET envelope=jsonb_set(envelope,'{mac}','\"tampered\"')");
    await pool.query("ALTER TABLE rail_provider_outcome_evidence ENABLE TRIGGER rail_provider_outcome_immutable");
    assert.deepEqual(await readReceipt(), { status: "verification_unavailable" });
  });
});

test("owner provider history paginates immutable revisions and isolates owners and agents", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ strict, owner, agent, proposal, queue, drain, ready, pool }) => {
    const history = page => strict.listProviderHistory(owner.walletId, agent.agentId, proposal.operationId, owner, page);
    assert.deepEqual((await history()).entries.map(entry => entry.revision), [1]);
    await queue(); await drain(); await ready(); await drain(new LocalPaymentSimulator(pool));
    const first = await history({ limit: 2 }), second = await history({ limit: 2, afterRevision: first.nextAfterRevision });
    assert.equal(first.assurance, "server_journal_history"); assert.equal(first.status, "succeeded");
    assert.deepEqual(first.entries.map(entry => entry.revision), [1, 2]);
    assert.deepEqual(second.entries.map(entry => entry.revision), [3, 4]);
    assert.equal(second.nextAfterRevision, null);
    assert.deepEqual((await history({ afterRevision: 4 })).entries, []);
    assert.ok(!JSON.stringify(first).includes("instrument_fixture"));
    assert.ok(!JSON.stringify(first).includes("providerAccountRef"));
    for (const page of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { afterRevision: -1 }, { afterRevision: 2147483648 }, { afterRevision: "1" }, { other: 1 }])
      await assert.rejects(history(page), { code: "invalid_agent_request" });
    await assert.rejects(strict.listProviderHistory(owner.walletId, randomUUID(), proposal.operationId, owner));
    const otherOwner = { ...owner, walletId: "other_wallet", userId: "other_user" };
    await assert.rejects(strict.listProviderHistory(otherOwner.walletId, agent.agentId, proposal.operationId, otherOwner));
    await assert.rejects(strict.listProviderHistory(owner.walletId, agent.agentId, randomUUID(), owner), { code: "provider_payment_not_found" });
  }, "lose_reply");
});

test("receipt write faults roll back final accounting and recover through lookup without resubmission", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ pool, queue, drain, ready, state, strict, owner, agent, proposal }) => {
    await pool.query(`CREATE FUNCTION fail_outcome_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'receipt_fault'; END $$;
      CREATE TRIGGER fail_outcome_receipt BEFORE INSERT ON rail_provider_outcome_evidence FOR EACH ROW EXECUTE FUNCTION fail_outcome_receipt()`);
    await queue(); assert.equal((await drain()).pending, 1);
    assert.deepEqual(await state(), { status: "submitting", reserved_budget_minor: "100", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_outcome_evidence")).rows[0].count, "0");
    await pool.query("DROP TRIGGER fail_outcome_receipt ON rail_provider_outcome_evidence");
    await ready(); assert.equal((await drain()).resolved, 1);
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "1");
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
    assert.equal((await strict.readProviderOutcome(owner.walletId, agent.agentId, proposal.operationId, owner)).status, "verified");
  });
});

test("uncertain simulated payments retain holds and expose no final receipt", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ pool, queue, drain, state, strict, owner, agent, proposal }) => {
    await queue(); assert.equal((await drain()).pending, 1);
    assert.deepEqual(await state(), { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" });
    assert.deepEqual(await strict.readProviderOutcome(owner.walletId, agent.agentId, proposal.operationId, owner), { status: "not_final" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_outcome_evidence")).rows[0].count, "0");
  }, "no_effect");
});

test("simulator queue insertion failure rolls back the execution proof and leaves allowance unchanged", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ pool, proofs, credential, proof, key, strict, path, body, proposal, state }) => {
    const spec = { method: "POST", url: `https://rail.example${path}`, body: Buffer.from(JSON.stringify(body)) };
    const nonce = await proofs.issueNonce(credential.token);
    const admission = await proofs.authenticate(credential.token, proof(nonce.nonce, {}, key.privateKey, spec), spec);
    await pool.query(`CREATE FUNCTION fail_payment_queue() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.provider_operation_id IS NOT NULL THEN RAISE EXCEPTION 'queue_fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_payment_queue BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_payment_queue()`);
    await assert.rejects(strict.executeProviderProposal(credential.token, proposal.operationId, body, admission), /queue_fault/);
    assert.deepEqual(await state(), { status: "reserved", reserved_budget_minor: "100", spent_budget_minor: "0" });
    await pool.query("DROP TRIGGER fail_payment_queue ON outbox");
    assert.equal((await strict.executeProviderProposal(credential.token, proposal.operationId, body, admission)).queued, true);
    await assert.rejects(strict.executeProviderProposal(credential.token, proposal.operationId, body, admission), { code: "invalid_agent_proof" });
  });
});

test("simulator concurrent workers create one durable effect and consume shared allowance once", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, drain, state }) => {
    await queue();
    const results = await Promise.all([drain(), drain(), drain()]);
    assert.equal(results.reduce((sum, result) => sum + result.resolved, 0), 1);
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "1");
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
  });
});

test("simulator target change before dispatch cancels definitely unsubmitted work and releases once", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, drain, state }) => {
    await queue();
    const changed = new ProviderTargetRegistry(JSON.stringify([{ ...providerTargetFixture, revision: 2 }]));
    assert.equal((await drain(undefined, changed)).resolved, 1);
    assert.deepEqual(await state(), { status: "cancelled", reserved_budget_minor: "0", spent_budget_minor: "0" });
    assert.equal((await drain()).resolved, 0);
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "0");
  });
});

test("simulator withdrawn execution credential prevents submission even after owner approved the proposal", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, strict, owner, agent, credential, drain, state }) => {
    await queue(); await strict.revokeCredential(owner.walletId, agent.agentId, credential.credentialId);
    assert.equal((await drain()).resolved, 1);
    assert.deepEqual(await state(), { status: "cancelled", reserved_budget_minor: "0", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "0");
  });
});

test("simulator agent revocation cancels unsubmitted work but preserves and reconciles an already uncertain liability", { skip: !databaseUrl }, async () => {
  for (const fault of ["none", "lose_reply"]) {
    await queuedProviderFixture(async ({ queue, pool, strict, owner, agent, drain, ready, state }) => {
      await queue();
      if (fault === "lose_reply") assert.equal((await drain()).pending, 1);
      await strict.revokeAgent(owner.walletId, agent.agentId);
      assert.deepEqual(await state(), fault === "lose_reply"
        ? { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" }
        : { status: "cancelled", reserved_budget_minor: "0", spent_budget_minor: "0" });
      await ready(); assert.equal((await drain(new LocalPaymentSimulator(pool))).resolved, 1);
      assert.equal((await state()).status, fault === "lose_reply" ? "succeeded" : "cancelled");
      assert.equal(Number((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count), fault === "lose_reply" ? 1 : 0);
    }, fault);
  }
});

test("simulator lost response retains hold then a fresh worker process reconciles despite target revocation", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, drain, ready, state, workerKeyEnvironment }) => {
    await queue(); assert.equal((await drain()).pending, 1);
    assert.deepEqual(await state(), { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" });
    await ready();
    const schema = (await pool.query("SELECT current_schema() AS name")).rows[0].name;
    const child = spawn(process.execPath, ["dist/persistence/runProviderWorker.js"], { env: { ...process.env, ...workerKeyEnvironment,
      DATABASE_URL: databaseUrl, PGOPTIONS: `-c search_path=${schema}`, RAIL_DEMO_MODE: "true", RAIL_PROVIDER_SIMULATOR: "true",
      NODE_ENV: "test", RAIL_PROVIDER_TARGETS: JSON.stringify([{ ...providerTargetFixture, status: "revoked" }]) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    assert.equal(await new Promise(resolve => child.on("close", resolve)), 0, output);
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "1");
  }, "lose_reply");
});

test("simulator failed transport with no known effect never resubmits or releases an uncertain hold", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, drain, ready, state }) => {
    await queue(); assert.equal((await drain()).pending, 1);
    await ready(); assert.equal((await drain(new LocalPaymentSimulator(pool))).pending, 1);
    assert.deepEqual(await state(), { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "0");
    assert.equal((await pool.query("SELECT attempt_number FROM rail_provider_payments")).rows[0].attempt_number, 1);
    assert.equal((await pool.query("SELECT delivery_status FROM outbox WHERE provider_operation_id IS NOT NULL")).rows[0].delivery_status, "pending");
  }, "no_effect");
});

test("simulator confirmed decline releases allowance without creating an internal wallet transfer", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, drain, state }) => {
    await queue(); assert.equal((await drain()).resolved, 1);
    assert.deepEqual(await state(), { status: "failed", reserved_budget_minor: "0", spent_budget_minor: "0" });
  }, "decline");
});

test("simulator stale worker cannot write outcome after a replacement lease reconciles its durable effect", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, drain, simulator, state }) => {
    await queue(); let release, reached;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
    class PausedSimulator extends LocalPaymentSimulator {
      async submit(payment) { const result = await simulator.submit(payment); reached(); await gate; return result; }
    }
    const first = drain(new PausedSimulator(pool));
    await started;
    await pool.query("UPDATE outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE provider_operation_id IS NOT NULL");
    const second = await drain(new LocalPaymentSimulator(pool));
    release();
    assert.equal(second.resolved, 1); assert.equal((await first).lostLease, 1);
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "1");
  });
});

test("simulator timeout does not trust a late response and recovers the original effect by lookup", { skip: !databaseUrl }, async () => {
  await queuedProviderFixture(async ({ queue, pool, drain, simulator, ready, state }) => {
    await queue(); let release, persisted;
    const gate = new Promise(resolve => { release = resolve; });
    const effectReady = new Promise(resolve => { persisted = resolve; });
    class SlowSimulator extends LocalPaymentSimulator {
      async submit(payment) { const result = await simulator.submit(payment); persisted(); await gate; return result; }
    }
    assert.equal((await drain(new SlowSimulator(pool), undefined, { timeoutMs: 20 })).pending, 1);
    await effectReady;
    assert.equal((await state()).status, "unknown"); release(); await ready();
    assert.equal((await drain()).resolved, 1);
    assert.deepEqual(await state(), { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" });
  });
});

for (const effectBeforeCrash of [false, true]) {
  test(`simulator process kill ${effectBeforeCrash ? "after" : "before"} effect preserves durable recovery without resubmission`, { skip: !databaseUrl }, async () => {
    await queuedProviderFixture(async ({ queue, pool, drain, state, workerKeyEnvironment }) => {
      await queue();
      const schema = (await pool.query("SELECT current_schema() AS name")).rows[0].name;
      const script = `import pg from 'pg';
        import {LocalPaymentSimulator,dispatchProviderBatch} from './dist/persistence/providerWorker.js';
        import {ProviderTargetRegistry} from './dist/domain/providerTargets.js';
        import {AgentEvidenceStore,loadAgentAuthorityKeyRing} from './dist/persistence/agentEvidence.js';
        const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
        const evidence=new AgentEvidenceStore(loadAgentAuthorityKeyRing(process.env.RAIL_AGENT_AUTHORITY_KEY_RING,[]));
        class CrashSimulator extends LocalPaymentSimulator {
          async submit(payment) {
            ${effectBeforeCrash ? "await super.submit(payment);" : ""}
            console.log('CRASH_BOUNDARY');
            return new Promise(()=>{});
          }
        }
        await dispatchProviderBatch(pool,new ProviderTargetRegistry(process.env.RAIL_PROVIDER_TARGETS),new CrashSimulator(pool),{batchSize:1,evidence});`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...workerKeyEnvironment,
        DATABASE_URL: databaseUrl, PGOPTIONS: `-c search_path=${schema}`, RAIL_PROVIDER_TARGETS: JSON.stringify([providerTargetFixture]) }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", killed = false;
      const exited = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal })));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout.on("data", data => { output += data; if (output.includes("CRASH_BOUNDARY")) { killed = true; child.kill("SIGKILL"); } });
      child.stderr.on("data", data => { output += data; });
      try {
        assert.equal((await exited).signal, "SIGKILL", output); assert.equal(killed, true, output);
      } finally { clearTimeout(timeout); child.kill("SIGKILL"); }
      assert.equal((await state()).status, "submitting");
      await pool.query("UPDATE outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE provider_operation_id IS NOT NULL");
      const recovered = await drain(new LocalPaymentSimulator(pool));
      assert.equal(recovered[effectBeforeCrash ? "resolved" : "pending"], 1);
      assert.deepEqual(await state(), effectBeforeCrash
        ? { status: "succeeded", reserved_budget_minor: "0", spent_budget_minor: "100" }
        : { status: "unknown", reserved_budget_minor: "100", spent_budget_minor: "0" });
      assert.equal(Number((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count), effectBeforeCrash ? 1 : 0);
      assert.equal((await pool.query("SELECT attempt_number FROM rail_provider_payments")).rows[0].attempt_number, 1);
    });
  });
}

test("provider proposals and simulator execution cross real loopback HTTP with DPoP and exact owner consent", { skip: !databaseUrl }, async () => {
  await providerProposalFixture(async ({ pool, context, credential, proof, key, input, agent, token, consent, budget, authority }) => {
    const runtime = { ...context, config: { ...context.config }, authResolver: createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] }) };
    const server = nodeHttp.createServer(async (req, res) => {
      try {
        if (!await handleAgentRoutes(req, res, new URL(req.url, runtime.config.agentApiOrigin), runtime)) { res.writeHead(404); res.end("{}"); }
      } catch (error) { res.writeHead(error.status ?? 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: error.code ?? "internal_error" })); }
    });
    server.listen(0, "localhost"); await once(server, "listening");
    const origin = `http://localhost:${server.address().port}`; runtime.config.agentApiOrigin = origin;
    const fetchJson = async (method, path, value, owner = false) => {
      const body = value === undefined ? undefined : JSON.stringify(value);
      const headers = { authorization: owner ? `Bearer ${token}` : `DPoP ${credential.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) };
      if (!owner) {
        const nonce = await fetch(`${origin}/v2/agent/nonces`, { method: "POST", headers: { authorization: headers.authorization, "content-type": "application/json" }, body: "{}" });
        headers.dpop = proof((await nonce.json()).nonce, {}, key.privateKey, { method, url: `${origin}${path}`, body: Buffer.from(body ?? "") });
      }
      const response = await fetch(`${origin}${path}`, { method, headers, body });
      assert.equal(response.headers.get("cache-control"), "no-store");
      return { status: response.status, body: await response.json() };
    };
    try {
      const first = await fetchJson("POST", "/v2/agent/provider-payments", input);
      assert.equal(first.status, 201); const proposal = first.body.proposals[0];
      assert.equal(proposal.status, "awaiting_owner_approval");
      assert.ok(!JSON.stringify(proposal).includes("instrument_fixture"));
      assert.ok(!JSON.stringify(proposal).includes("account_fixture"));
      assert.deepEqual((await fetchJson("POST", "/v2/agent/provider-payments", input)).body, first.body);
      assert.equal((await fetchJson("POST", "/v2/agent/provider-payments", { ...input, amountMinor: 101 })).status, 409);
      assert.equal((await fetchJson("POST", "/v2/agent/provider-payments", { ...input, instrumentRef: "attacker_selected" })).status, 422);
      const ownerPath = `/v2/agents/${agent.agentId}/provider-payments`;
      const pending = (await fetchJson("GET", ownerPath, undefined, true)).body.proposals[0];
      assert.equal(pending.binding.instrumentRef, "instrument_fixture");
      const permission = await consent(pending.consentFingerprint);
      const approval = { requestFingerprint: pending.requestFingerprint, grantToken: permission.grantToken };
      const approved = await fetchJson("POST", `${ownerPath}/${pending.operationId}/authorize`, approval, true);
      assert.equal(approved.status, 200); assert.equal(approved.body.payment.status, "reserved");
      assert.deepEqual((await fetchJson("POST", `${ownerPath}/${pending.operationId}/authorize`, approval, true)).body, approved.body);
      assert.equal((await fetchJson("GET", "/v2/agent/provider-payments")).body.proposals[0].status, "reserved");
      assert.equal((await pool.query("SELECT reserved_budget_minor FROM rail_shared_budgets WHERE budget_id=$1", [budget.budgetId])).rows[0].reserved_budget_minor, "100");
      assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_history")).rows[0].count, "1");
      assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE work_kind='provider_payment'")).rows[0].count, "0");
      assert.equal((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
      const executePath = `/v2/agent/provider-payments/${pending.operationId}/execute`;
      const executeBody = { requestFingerprint: pending.requestFingerprint };
      assert.equal((await fetchJson("POST", executePath, { ...executeBody, requestFingerprint: fingerprint })).status, 409);
      assert.equal((await fetchJson("POST", executePath, executeBody)).status, 202);
      assert.equal((await fetchJson("POST", executePath, executeBody)).status, 202);
      const resolved = await dispatchProviderBatch(pool, new ProviderTargetRegistry(JSON.stringify([providerTargetFixture])), new LocalPaymentSimulator(pool), { evidence: authority });
      assert.equal(resolved.resolved, 1);
      assert.equal((await fetchJson("GET", "/v2/agent/provider-payments")).body.proposals[0].status, "succeeded");
      const receiptPath = `${ownerPath}/${pending.operationId}/receipt`;
      assert.equal((await fetchJson("GET", receiptPath)).status, 401);
      const outcome = await fetchJson("GET", receiptPath, undefined, true);
      assert.equal(outcome.status, 200); assert.equal(outcome.body.evidence.status, "verified");
      assert.equal(outcome.body.evidence.receipt.assurance, "local_simulator_outcome");
      const history = await fetchJson("GET", `${ownerPath}/${pending.operationId}/history?limit=1`, undefined, true);
      assert.equal(history.status, 200); assert.equal(history.body.history.entries.length, 1);
      assert.equal(history.body.history.nextAfterRevision, 1);
      assert.equal((await fetchJson("GET", `${ownerPath}/${pending.operationId}/history?limit=1&limit=2`, undefined, true)).status, 422);
      assert.equal((await pool.query("SELECT count(*) FROM rail_simulator_effects")).rows[0].count, "1");
      assert.equal((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
      await runMigrations(pool);
      await assert.rejects(pool.query("UPDATE rail_provider_proposals SET target_snapshot='{}'"), { code: "23514" });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }, "payments:execute", true);
});

test("target revocation and substitution block new consent or dispatch, not historical reads or reconciliation", { skip: !databaseUrl }, async () => {
  await providerProposalFixture(async ({ http, context, input, strict, owner, agent, consent, replacement, pool }) => {
    await http("POST", "/v2/agent/provider-payments", input, { signed: true });
    const proposal = (await strict.listOwnerProviderProposals(owner.walletId, agent.agentId, owner))[0];
    const permission = await consent(proposal.consentFingerprint);
    const approve = { requestFingerprint: proposal.requestFingerprint, grantToken: permission.grantToken };
    const changedTarget = { ...providerTargetFixture, instrumentRef: "changed_instrument", revision: 2 };
    const changed = replacement(changedTarget), revoked = replacement({ ...providerTargetFixture, status: "revoked" });
    await assert.rejects(changed.authorizeProviderProposal(owner.walletId, agent.agentId, proposal.operationId, approve, owner), { code: "provider_target_changed" });
    await assert.rejects(revoked.authorizeProviderProposal(owner.walletId, agent.agentId, proposal.operationId, approve, owner), { code: "provider_target_denied" });
    const admitted = await strict.authorizeProviderProposal(owner.walletId, agent.agentId, proposal.operationId, approve, owner);
    const identity = { ownerWalletId: owner.walletId, operationId: proposal.operationId, fingerprint: proposal.requestFingerprint };
    await assert.rejects(providerTransaction(pool, client => advanceProviderPaymentInTransaction(client, identity,
      { type: "begin_submission", idempotencyWindowMs: 60000 }, new ProviderTargetRegistry(JSON.stringify([changedTarget])))), { code: "provider_target_changed" });
    assert.deepEqual(await revoked.authorizeProviderProposal(owner.walletId, agent.agentId, proposal.operationId, approve, owner), admitted);
    const started = await providerTransaction(pool, client => advanceProviderPaymentInTransaction(client, identity,
      { type: "begin_submission", idempotencyWindowMs: 60000 }, new ProviderTargetRegistry(JSON.stringify([providerTargetFixture]))));
    const resolved = await providerTransaction(pool, client => advanceProviderPaymentInTransaction(client, identity, { type: "provider_observed",
      observation: { operationId: proposal.operationId, fingerprint: proposal.requestFingerprint, provider: "simulator", providerAccountRef: "account_fixture",
        providerRef: "test_provider_object", amountMinor: 100, currency: "INR", status: "failed", final: true } }));
    assert.equal(started.status, "submitting"); assert.equal(resolved.status, "failed");
    assert.equal((await http("GET", "/v2/agent/provider-payments", undefined, { signed: true, context: { ...context, agentStore: changed } })).body.proposals[0].status, "failed");
  });
});

test("provider proposal claims cannot cross agents, reuse proof objects or survive failed admission commits", { skip: !databaseUrl }, async () => {
  await providerProposalFixture(async ({ pool, proofs, credential, proof, key, input, strict, owner, agent, http, context, replacement }) => {
    const spec = { method: "POST", url: "https://rail.example/v2/agent/provider-payments", body: Buffer.from(JSON.stringify(input)) };
    const nonce = await proofs.issueNonce(credential.token);
    const admitted = await proofs.authenticate(credential.token, proof(nonce.nonce, {}, key.privateKey, spec), spec);
    await assert.rejects(strict.createProviderProposal(credential.token, input, { ...admitted }), { code: "invalid_agent_proof" });
    await pool.query(`CREATE FUNCTION reject_provider_proposal_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'provider_proposal_write_failed'; END $$;
      CREATE TRIGGER reject_provider_proposal_fixture BEFORE INSERT ON rail_provider_proposals
      FOR EACH ROW EXECUTE FUNCTION reject_provider_proposal_fixture()`);
    await assert.rejects(strict.createProviderProposal(credential.token, input, admitted), /provider_proposal_write_failed/);
    assert.equal((await pool.query("SELECT dispatched_at FROM rail_agent_proof_nonces WHERE proof_id=$1", [admitted.proofId])).rows[0].dispatched_at, null);
    await pool.query("DROP TRIGGER reject_provider_proposal_fixture ON rail_provider_proposals");
    await strict.createProviderProposal(credential.token, input, admitted);
    await assert.rejects(strict.createProviderProposal(credential.token, input, admitted), { code: "invalid_agent_proof" });
    const foreign = await strict.createAgent("other_wallet", { name: "Other owner agent" });
    assert.deepEqual(await strict.listOwnerProviderProposals("other_wallet", foreign.agentId, { ...owner, walletId: "other_wallet", userId: "other_user" }), []);
    await assert.rejects(strict.listOwnerProviderProposals("other_wallet", agent.agentId, { ...owner, walletId: "other_wallet", userId: "other_user" }), { code: "agent_not_found" });
    await assert.rejects(http("POST", "/v2/agent/provider-payments", { ...input, clientRequestId: "foreign_target_fixture" }, { signed: true,
      context: { ...context, agentStore: replacement({ ...providerTargetFixture, ownerWalletId: "other_wallet", merchantWalletId: "merchant_other" }) } }), { code: "provider_target_denied" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_proposals")).rows[0].count, "1");
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payments")).rows[0].count, "0");
  });
});

function replacement(scope = "payments:propose") {
  const key = generateKeyPairSync("ed25519");
  return { key, terms: { scope, ttlSeconds: 120, publicKey: key.publicKey.export({ format: "jwk" }) } };
}
function replacementProof(key, credential, nonce, spec) {
  const header = { typ: "dpop+jwt", alg: "EdDSA", jwk: key.publicKey.export({ format: "jwk" }) };
  const claims = { htm: spec.method, htu: spec.url, iat: Math.floor(Date.now() / 1000), jti: randomBytes(32).toString("base64url"), nonce,
    ath: createHash("sha256").update(credential.token).digest("base64url"), rail_body_sha256: agentBodyDigest(spec.body) };
  const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString("base64url")}`;
}

test("rotation binds owner approval to predecessor, new key, scope and lifetime without escalation", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential }) => {
    const { terms } = replacement();
    const authorization = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, terms), 2);
    const rotate = value => strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, value, principal);
    await assert.rejects(rotate(terms), { code: "owner_step_up_required" });
    for (const change of [{ ...replacement().terms }, { ttlSeconds: 180 }, { scope: "payments:execute" }])
      await assert.rejects(rotate({ ...terms, ...change, grantToken: authorization.grantToken }), { code: "owner_step_up_required" });
    const elevated = { ...terms, scope: "payments:execute" };
    const wrongScope = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, elevated), 3);
    await assert.rejects(rotate({ ...elevated, grantToken: wrongScope.grantToken }), { code: "credential_scope_change_denied" });
    const result = await rotate({ ...terms, grantToken: authorization.grantToken });
    assert.equal(result.scope, credential.scope); assert.equal(result.rotatedFromCredentialId, credential.credentialId);
    const rows = (await pool.query("SELECT * FROM rail_agent_credentials ORDER BY created_at")).rows;
    assert.equal(rows.length, 2); assert.equal(+rows[0].revoked_at, +rows[1].created_at);
    assert.ok(!JSON.stringify(rows).includes(result.token));
    const events = (await pool.query("SELECT payload FROM outbox WHERE type='agent.credential_rotated'")).rows;
    assert.equal(events.length, 1); assert.ok(!JSON.stringify(events).includes(result.token));
  });
});

test("rotation withdraws old nonces and admissions, enables the new key and retains immutable lineage", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential, proofs, proof }) => {
    const get = { method: "GET", url: "https://rail.example/v2/agent/identity", body: Buffer.alloc(0) }, { nonce } = await proofs.issueNonce(credential.token);
    const oldAdmission = await proofs.authenticate(credential.token, proof(nonce, {}, undefined, get), get);
    const { key, terms } = replacement();
    const authorization = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, terms), 2);
    const result = await strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...terms, grantToken: authorization.grantToken }, principal);
    await assert.rejects(strict.resolveCredential(credential.token, oldAdmission), { code: "invalid_agent_credentials" });
    await assert.rejects(proofs.issueNonce(credential.token), { code: "invalid_agent_proof" });
    const next = await proofs.issueNonce(result.token), admission = await proofs.authenticate(result.token, replacementProof(key, result, next.nonce, get), get);
    assert.equal((await strict.resolveCredential(result.token, admission)).credentialId, result.credentialId);
    const history = await strict.listCredentials(principal.walletId, agent.agentId);
    assert.equal(history[0].replacedByCredentialId, result.credentialId); assert.equal(history[1].rotatedFromCredentialId, credential.credentialId);
    assert.ok(!JSON.stringify(history).includes(result.token));
    await assert.rejects(pool.query("UPDATE rail_agent_credentials SET rotated_from_credential_id=NULL WHERE credential_id=$1", [result.credentialId]), /agent_credential_is_immutable/);
    await runMigrations(pool);
    assert.equal((await strict.listCredentials(principal.walletId, agent.agentId))[0].replacedByCredentialId, result.credentialId);
  });
});

test("concurrent rotations produce one replacement and retain the losing grant", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential }) => {
    const first = replacement(), second = replacement();
    const grants = [await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, first.terms), 2),
      await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, second.terms), 3)];
    const results = await Promise.allSettled([first, second].map((value, i) => strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...value.terms, grantToken: grants[i].grantToken }, principal)));
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(results.find(value => value.status === "rejected").reason.code, "credential_inactive");
    assert.equal((await pool.query("SELECT count(*) FROM rail_agent_credentials WHERE rotated_from_credential_id=$1", [credential.credentialId])).rows[0].count, "1");
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_step_up_grants WHERE consumed_at IS NULL")).rows[0].count, "1");
  });
});

test("rotation audit failure rolls back revocation, new credential and grant consumption", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential, proofs }) => {
    const { terms } = replacement(), authorization = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, terms), 2);
    await pool.query("CREATE FUNCTION fail_rotation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='agent.credential_rotated' THEN RAISE EXCEPTION 'rotation_audit_failure'; END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER rotation_audit_failure BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_rotation_audit()");
    const rotate = () => strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...terms, grantToken: authorization.grantToken }, principal);
    await assert.rejects(rotate(), /rotation_audit_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 1);
    assert.equal((await pool.query("SELECT revoked_at FROM rail_agent_credentials")).rows[0].revoked_at, null);
    await proofs.issueNonce(credential.token);
    await pool.query("DROP TRIGGER rotation_audit_failure ON outbox");
    assert.ok((await rotate()).credentialId);
  });
});

test("rotation deferred commit failure restores the predecessor and permits a safe retry", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential }) => {
    const { terms } = replacement(), authorization = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, terms), 2);
    await pool.query("CREATE FUNCTION fail_rotation_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.rotated_from_credential_id IS NOT NULL THEN RAISE EXCEPTION 'rotation_commit_failure'; END IF; RETURN NULL; END $$");
    await pool.query("CREATE CONSTRAINT TRIGGER rotation_commit_failure AFTER INSERT ON rail_agent_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_rotation_commit()");
    const rotate = () => strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...terms, grantToken: authorization.grantToken }, principal);
    await assert.rejects(rotate(), /rotation_commit_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 1);
    assert.equal((await pool.query("SELECT revoked_at FROM rail_agent_credentials")).rows[0].revoked_at, null);
    await pool.query("DROP TRIGGER rotation_commit_failure ON rail_agent_credentials");
    await rotate();
  });
});

test("a lost rotation response can be resolved through owner history and fresh rotation without storing tokens", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential }) => {
    const first = replacement(), authorization = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, first.terms), 2);
    await strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...first.terms, grantToken: authorization.grantToken }, principal);
    const history = await strict.listCredentials(principal.walletId, agent.agentId), successor = history[0].replacedByCredentialId;
    assert.ok(successor); assert.ok(!JSON.stringify(history).includes("rail_agent_"));
    await assert.rejects(strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...first.terms, grantToken: authorization.grantToken }, principal), { code: "owner_step_up_required" });
    const second = replacement(), next = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, successor, second.terms), 3);
    const result = await strict.rotateCredential(principal.walletId, agent.agentId, successor, { ...second.terms, grantToken: next.grantToken }, principal);
    assert.equal(result.rotatedFromCredentialId, successor);
    assert.equal((await pool.query("SELECT count(*) FROM rail_agent_credentials WHERE revoked_at IS NULL")).rows[0].count, "1");
  });
});

test("rotation cannot revive revoked credentials, reuse keys or cross owner/session boundaries", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential, publicKey }) => {
    const reused = { scope: "payments:propose", ttlSeconds: 120, publicKey };
    const reusedGrant = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, reused), 2);
    await assert.rejects(strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...reused, grantToken: reusedGrant.grantToken }, principal), { code: "rotation_requires_fresh_key" });
    const { terms } = replacement(), authorization = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, terms), 3);
    await assert.rejects(strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...terms, grantToken: authorization.grantToken }, { ...principal, sessionFingerprint: "c".repeat(64) }), { code: "owner_step_up_required" });
    const other = { ...principal, walletId: "other_wallet", userId: "other_user" }, otherKey = await enroll(store, other);
    const otherGrant = await grant(store, otherKey, other, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, terms));
    await assert.rejects(strict.rotateCredential(other.walletId, agent.agentId, credential.credentialId, { ...terms, grantToken: otherGrant.grantToken }, other), { code: "agent_not_found" });
    await strict.revokeCredential(principal.walletId, agent.agentId, credential.credentialId);
    await assert.rejects(strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...terms, grantToken: authorization.grantToken }, principal), { code: "credential_inactive" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 1);
  });
});

test("rotated execution keys preserve original receipts and replay and produce valid new authority", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, strict, ownerKey, agent, credential, http }) => {
    const policy = { ...mandatePolicy, mode: "budgeted", totalBudgetMinor: 1000 };
    const consent = await grant(store, ownerKey, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy), 2);
    const mandate = await strict.createMandate(principal.walletId, agent.agentId, { ...policy, grantToken: consent.grantToken }, principal);
    const proposal = { mandateId: mandate.mandateId, clientRequestId: "before_rotation_request", receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" };
    const intent = (await http("POST", "/v2/agent/intents", proposal, { signed: true })).body.intent;
    const path = `/v2/agent/intents/${intent.intentId}/execute`, value = { requestFingerprint: intent.requestFingerprint };
    const first = (await http("POST", path, value, { signed: true })).body;
    const original = await strict.readAuthority(principal.walletId, agent.agentId, intent.intentId);
    const { key, terms } = replacement("payments:execute"), authorization = await grant(store, ownerKey, principal, "agent_credential", credentialRotationFingerprint(agent.agentId, credential.credentialId, terms), 3);
    const rotated = await strict.rotateCredential(principal.walletId, agent.agentId, credential.credentialId, { ...terms, grantToken: authorization.grantToken }, principal);
    const call = async (target, body) => {
      const challenge = await http("POST", "/v2/agent/nonces", {}, { authorization: `DPoP ${rotated.token}` });
      const spec = { method: "POST", url: `https://rail.example${target}`, body: Buffer.from(JSON.stringify(body)) };
      return (await http("POST", target, body, { authorization: `DPoP ${rotated.token}`, proof: replacementProof(key, rotated, challenge.body.nonce, spec) })).body;
    };
    assert.equal((await call(path, value)).result.ledgerEntryId, first.result.ledgerEntryId);
    assert.deepEqual(await strict.readAuthority(principal.walletId, agent.agentId, intent.intentId), original);
    const next = (await call("/v2/agent/intents", { ...proposal, clientRequestId: "after_rotation_request" })).intent;
    await call(`/v2/agent/intents/${next.intentId}/execute`, { requestFingerprint: next.requestFingerprint });
    const evidence = await strict.readAuthority(principal.walletId, agent.agentId, next.intentId);
    assert.equal(evidence.status, "verified");
    assert.equal(evidence.receipt.credentialId, rotated.credentialId);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 4);
    assert.equal((await pool.query("SELECT balance FROM wallets WHERE wallet_id='owner_wallet'")).rows[0].balance, "800");
  }, "payments:execute", 1000);
});

test("database rotation guards independently reject scope and lifetime forgery", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, ownerKey, agent, credential }) => {
    const { terms } = replacement();
    const fingerprint = credentialRotationFingerprint(agent.agentId, credential.credentialId, terms);
    const authorization = await grant(store, ownerKey, principal, "agent_credential", fingerprint, 2);
    const step = await consume(pool, store, authorization.grantToken, "agent_credential", fingerprint);
    const forge = (scope, seconds) => pool.query(`WITH timestamp AS (SELECT clock_timestamp() AS now), revoked AS (
      UPDATE rail_agent_credentials SET revoked_at=timestamp.now FROM timestamp WHERE credential_id=$2 RETURNING credential_id)
      INSERT INTO rail_agent_credentials(credential_id,agent_id,token_hash,scope,created_at,expires_at,
        owner_step_up_challenge_id,proof_public_key,proof_key_thumbprint,rotated_from_credential_id)
      SELECT $1,$3,$4,$5,now,now+$6*interval '1 second',$7,$8::jsonb,$9,$2 FROM timestamp WHERE EXISTS(SELECT 1 FROM revoked)`,
      [randomUUID(), credential.credentialId, agent.agentId, randomBytes(32).toString("hex"), scope, seconds,
        step.challengeId, JSON.stringify(terms.publicKey), agentKeyThumbprint(terms.publicKey)]);
    await assert.rejects(forge("payments:execute", 120), /agent_rotation_binding_invalid/);
    await assert.rejects(forge("payments:propose", 180), /agent_credential_step_up_binding_invalid/);
    assert.equal((await pool.query("SELECT revoked_at FROM rail_agent_credentials WHERE credential_id=$1", [credential.credentialId])).rows[0].revoked_at, null);
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 1);
  });
});

test("agent API origin configuration rejects spoofable, partial and noncanonical origins", () => {
  const old = process.env.RAIL_AGENT_API_ORIGIN, environment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    for (const value of ["", "https://rail.example/", "https://user:secret@rail.example", "https://rail.example/path", "https://rail.example?query=1", "http://rail.example"] ) {
      process.env.RAIL_AGENT_API_ORIGIN = value; assert.throws(() => loadServerConfig(), /INVALID_AGENT_API_ORIGIN/);
    }
    process.env.RAIL_AGENT_API_ORIGIN = "https://rail.example"; assert.equal(loadServerConfig().agentApiOrigin, "https://rail.example");
    process.env.RAIL_AGENT_API_ORIGIN = "http://localhost:8787"; assert.equal(loadServerConfig().agentApiOrigin, "http://localhost:8787");
    process.env.NODE_ENV = "production"; assert.throws(() => loadServerConfig(), /INVALID_AGENT_API_ORIGIN/);
  } finally {
    if (old === undefined) delete process.env.RAIL_AGENT_API_ORIGIN; else process.env.RAIL_AGENT_API_ORIGIN = old;
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
  }
});

test("agent HTTP routes require DPoP, exact targets and signatures against the configured origin", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ http, credential, proof, context, pool, store, ownerKey, agent, publicKey, strict }) => {
    const unavailable = new AgentAuthorityStore(pool, undefined, undefined, undefined, { required: true, store }, { required: true, ready: false });
    await assert.rejects(unavailable.issueCredential(principal.walletId, agent.agentId, { scope: "payments:propose" }, principal), { code: "agent_public_key_required" });
    const legacy = await strict.issueCredential(principal.walletId, agent.agentId, { scope: "payments:propose" }, principal);
    await assert.rejects(unavailable.resolveCredential(legacy.token), { code: "agent_public_key_required" });
    const terms = { scope: "payments:propose", ttlSeconds: 120, publicKey };
    const authorized = await grant(store, ownerKey, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, terms), 2);
    const waiting = await unavailable.issueCredential(principal.walletId, agent.agentId, { ...terms, grantToken: authorized.grantToken }, principal);
    assert.equal(waiting.proofRouteReady, false);
    await assert.rejects(http("GET", "/v2/agent/identity", undefined, { authorization: `Bearer ${credential.token}` }), { code: "invalid_agent_credentials" });
    await assert.rejects(http("GET", "/v2/agent/identity"), { code: "invalid_agent_proof" });
    await assert.rejects(http("GET", "/v2/agent/identity?admin=true"), { code: "invalid_agent_target" });
    await assert.rejects(http("GET", "/v2/agent/identity", undefined, { context: { ...context, config: { ...context.config, agentApiOrigin: undefined } } }), { code: "agent_proof_unavailable" });
    await assert.rejects(http("GET", "/v2/agent/identity", undefined, { context: { ...context, agentProofs: undefined } }), { code: "agent_proof_unavailable" });
    const { body: { nonce } } = await http("POST", "/v2/agent/nonces", {});
    const get = { method: "GET", url: "https://rail.example/v2/agent/identity", body: Buffer.alloc(0) };
    await assert.rejects(http("GET", "/v2/agent/identity", undefined, { proof: proof(nonce, { htu: "https://attacker.example/v2/agent/identity" }, undefined, get), host: "attacker.example" }), { code: "invalid_agent_proof" });
    const signed = proof(nonce, {}, undefined, get);
    assert.equal((await http("GET", "/v2/agent/identity", undefined, { proof: signed, host: "attacker.example" })).body.identity.credentialId, credential.credentialId);
    await assert.rejects(http("GET", "/v2/agent/identity", undefined, { proof: signed }), { code: "invalid_agent_proof" });
    assert.ok((await pool.query("SELECT dispatched_at FROM rail_agent_proof_nonces")).rows[0].dispatched_at);
  });
});

test("dispatch rejects copied admission objects, wrong routes and repeated capabilities", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ proofs, credential, proof, strict }) => {
    const { nonce } = await proofs.issueNonce(credential.token), get = { method: "GET", url: "https://rail.example/v2/agent/identity", body: Buffer.alloc(0) };
    const admission = await proofs.authenticate(credential.token, proof(nonce, {}, undefined, get), get);
    await assert.rejects(strict.resolveCredential(credential.token, { ...admission }), { code: "invalid_agent_proof" });
    await assert.rejects(strict.listAgentIntents(credential.token, admission), { code: "invalid_agent_proof" });
    assert.equal((await strict.resolveCredential(credential.token, admission)).credentialId, credential.credentialId);
    await assert.rejects(strict.resolveCredential(credential.token, admission), { code: "invalid_agent_proof" });
  });
});

test("failed dispatch commits roll back claims and a revoked key cannot use an admitted request", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, proofs, credential, proof, strict, agent }) => {
    const { nonce } = await proofs.issueNonce(credential.token), get = { method: "GET", url: "https://rail.example/v2/agent/identity", body: Buffer.alloc(0) };
    const admission = await proofs.authenticate(credential.token, proof(nonce, {}, undefined, get), get);
    await pool.query("CREATE FUNCTION fail_dispatch_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.dispatched_at IS NOT NULL THEN RAISE EXCEPTION 'dispatch_commit_failure'; END IF; RETURN NULL; END $$");
    await pool.query("CREATE CONSTRAINT TRIGGER dispatch_commit_failure AFTER UPDATE ON rail_agent_proof_nonces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_dispatch_commit()");
    await assert.rejects(strict.resolveCredential(credential.token, admission), /dispatch_commit_failure/);
    assert.equal((await pool.query("SELECT dispatched_at FROM rail_agent_proof_nonces")).rows[0].dispatched_at, null);
    await pool.query("DROP TRIGGER dispatch_commit_failure ON rail_agent_proof_nonces");
    await strict.revokeCredential(principal.walletId, agent.agentId, credential.credentialId);
    await assert.rejects(strict.resolveCredential(credential.token, admission), { code: "invalid_agent_credentials" });
  });
});

test("signed HTTP proposal and execution share atomic money, admission and replay boundaries", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, store, ownerKey, strict, agent, credential, http, proofs, proof }) => {
    const policy = { ...mandatePolicy, mode: "budgeted" };
    const authorization = await grant(store, ownerKey, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy), 2);
    const mandate = await strict.createMandate(principal.walletId, agent.agentId, { ...policy, grantToken: authorization.grantToken }, principal);
    const proposal = { mandateId: mandate.mandateId, clientRequestId: "proof_http_payment", receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" };
    const { body: { intent } } = await http("POST", "/v2/agent/intents", proposal, { signed: true });
    const path = `/v2/agent/intents/${intent.intentId}/execute`, value = { requestFingerprint: intent.requestFingerprint };
    const { nonce } = await proofs.issueNonce(credential.token), spec = { method: "POST", url: `https://rail.example${path}`, body: Buffer.from(JSON.stringify(value)) };
    const admission = await proofs.authenticate(credential.token, proof(nonce, {}, undefined, spec), spec);
    await assert.rejects(strict.executeIntent(credential.token, intent.intentId, { requestFingerprint: "a".repeat(64) }, admission), { code: "invalid_agent_proof" });
    const result = await strict.executeIntent(credential.token, intent.intentId, value, admission);
    assert.equal(result.result.status, "accepted");
    const replay = (await http("POST", path, value, { signed: true })).body;
    assert.equal(replay.result.ledgerEntryId, result.result.ledgerEntryId);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    assert.equal((await pool.query("SELECT balance FROM wallets WHERE wallet_id='owner_wallet'")).rows[0].balance, "900");
    assert.equal((await strict.readAuthority(principal.walletId, agent.agentId, intent.intentId)).status, "verified");
  }, "payments:execute", 1000);
});

test("agent proof enrollment binds owner step-up to the exact public key and immutable credential", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const ownerKey = await enroll(store), { strict } = agentStores(pool, store), agent = await strict.createAgent(principal.walletId, { name: "key_binding" });
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    const terms = { publicKey, scope: "payments:propose", ttlSeconds: 120 };
    const authorized = await grant(store, ownerKey, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, terms));
    await assert.rejects(strict.issueCredential(principal.walletId, agent.agentId, { ...terms, publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }), grantToken: authorized.grantToken }, principal), { code: "owner_step_up_required" });
    const result = await strict.issueCredential(principal.walletId, agent.agentId, { ...terms, grantToken: authorized.grantToken }, principal);
    assert.equal(result.proofKeyThumbprint, agentKeyThumbprint(publicKey));
    const row = (await pool.query("SELECT * FROM rail_agent_credentials WHERE credential_id=$1", [result.credentialId])).rows[0];
    assert.deepEqual(row.proof_public_key, publicKey);
    assert.ok(row.owner_step_up_challenge_id);
    await assert.rejects(strict.resolveCredential(result.token), { code: "invalid_agent_proof" });
    await assert.rejects(strict.listAgentIntents(result.token), { code: "invalid_agent_proof" });
    await assert.rejects(pool.query("UPDATE rail_agent_credentials SET proof_public_key=NULL,proof_key_thumbprint=NULL WHERE credential_id=$1", [result.credentialId]), /agent_credential_is_immutable/);
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT proof_key_thumbprint FROM rail_agent_credentials WHERE credential_id=$1", [result.credentialId])).rows[0].proof_key_thumbprint, result.proofKeyThumbprint);
  });
});

test("agent proof nonce storage is hashed, bounded across instances and credential scoped", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, proofs, credential, strict, agent }) => {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => new AgentProofStore(pool).issueNonce(credential.token)));
    assert.equal(attempts.filter(value => value.status === "fulfilled").length, 5);
    assert.ok(attempts.filter(value => value.status === "rejected").every(value => value.reason.code === "agent_proof_capacity"));
    const rows = (await pool.query("SELECT * FROM rail_agent_proof_nonces")).rows;
    assert.equal(rows.length, 5);
    const nonce = attempts.find(value => value.status === "fulfilled").value.nonce;
    assert.ok(!JSON.stringify(rows).includes(nonce));
    assert.ok(rows.every(row => new Date(row.expires_at) - new Date(row.created_at) === 60000));
    const legacy = await strict.issueCredential(principal.walletId, agent.agentId, { scope: "payments:propose" }, principal);
    await assert.rejects(proofs.issueNonce(legacy.token), { code: "invalid_agent_proof" });
    await assert.rejects(pool.query("DELETE FROM rail_agent_proof_nonces"), /active_agent_nonce_is_immutable/);
  });
});

test("agent proof admissions across database clients accept a signed nonce only once", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, proofs, credential, request, proof }) => {
    const { nonce } = await proofs.issueNonce(credential.token), signed = proof(nonce);
    const outcomes = await Promise.allSettled([proofs.authenticate(credential.token, signed, request), new AgentProofStore(pool).authenticate(credential.token, signed, request)]);
    assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(outcomes.find(value => value.status === "rejected").reason.code, "invalid_agent_proof");
    const row = (await pool.query("SELECT * FROM rail_agent_proof_nonces")).rows[0];
    assert.ok(row.consumed_at && row.proof_id);
    await assert.rejects(pool.query("UPDATE rail_agent_proof_nonces SET consumed_at=NULL,proof_id=NULL"), /agent_nonce_is_immutable/);
  });
});

test("invalid agent signatures and payload changes do not consume a valid nonce", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, proofs, credential, request, proof, store, strict, ownerKey, agent, publicKey }) => {
    const { nonce } = await proofs.issueNonce(credential.token);
    const terms = { publicKey, scope: "payments:propose", ttlSeconds: 120 };
    const authorized = await grant(store, ownerKey, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, terms), 2);
    const another = await strict.issueCredential(principal.walletId, agent.agentId, { ...terms, grantToken: authorized.grantToken }, principal);
    await assert.rejects(proofs.authenticate(another.token, proof(nonce), request), { code: "invalid_agent_proof" });
    await assert.rejects(proofs.authenticate(credential.token, proof(nonce, {}, generateKeyPairSync("ed25519").privateKey), request), { code: "invalid_agent_proof" });
    const signed = proof(nonce);
    await assert.rejects(proofs.authenticate(credential.token, signed, { ...request, body: Buffer.from('{"amountMinor":101}') }), { code: "invalid_agent_proof" });
    assert.equal((await pool.query("SELECT consumed_at FROM rail_agent_proof_nonces")).rows[0].consumed_at, null);
    assert.equal((await proofs.authenticate(credential.token, signed, request)).credentialId, credential.credentialId);
  });
});

test("agent proof IDs cannot be reused with another server nonce", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, proofs, credential, request, proof }) => {
    const first = await proofs.issueNonce(credential.token), second = await proofs.issueNonce(credential.token), jti = randomBytes(32).toString("base64url");
    await proofs.authenticate(credential.token, proof(first.nonce, { jti }), request);
    await assert.rejects(proofs.authenticate(credential.token, proof(second.nonce, { jti }), request), { code: "invalid_agent_proof" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_agent_proof_nonces WHERE consumed_at IS NOT NULL")).rows[0].count, "1");
    await proofs.authenticate(credential.token, proof(second.nonce), request);
  });
});

test("agent nonce admission rolls back on deferred commit failure", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ pool, proofs, credential, request, proof }) => {
    const { nonce } = await proofs.issueNonce(credential.token), signed = proof(nonce);
    await pool.query("CREATE FUNCTION fail_proof_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'proof_commit_failure'; END $$");
    await pool.query("CREATE CONSTRAINT TRIGGER proof_commit_failure AFTER UPDATE ON rail_agent_proof_nonces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_proof_commit()");
    await assert.rejects(proofs.authenticate(credential.token, signed, request), /proof_commit_failure/);
    assert.equal((await pool.query("SELECT consumed_at FROM rail_agent_proof_nonces")).rows[0].consumed_at, null);
    await pool.query("DROP TRIGGER proof_commit_failure ON rail_agent_proof_nonces");
    await proofs.authenticate(credential.token, signed, request);
  });
});

test("agent proof admission rechecks revocation and owner recovery rather than trusting an ingress token", { skip: !databaseUrl }, async () => {
  await proofFixture(async ({ proofs, credential, request, proof, strict, agent, store, ownerKey, publicKey }) => {
    const { nonce } = await proofs.issueNonce(credential.token), signed = proof(nonce);
    await strict.revokeCredential(principal.walletId, agent.agentId, credential.credentialId);
    await assert.rejects(proofs.authenticate(credential.token, signed, request), { code: "invalid_agent_proof" });
    const terms = { publicKey, scope: "payments:propose", ttlSeconds: 120 };
    const authorized = await grant(store, ownerKey, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, terms), 2);
    const live = await strict.issueCredential(principal.walletId, agent.agentId, { ...terms, grantToken: authorized.grantToken }, principal);
    await proofs.issueNonce(live.token);
    await recovery(store, ownerKey);
    await assert.rejects(proofs.issueNonce(live.token), { code: "invalid_agent_proof" });
  });
});

test("passkey configuration rejects partial, noncanonical and unsafe relying-party origins", () => {
  assert.equal(loadOwnerPasskeyConfig(), undefined);
  assert.deepEqual(loadOwnerPasskeyConfig(config.rpId, config.origin), config);
  for (const values of [[config.rpId, undefined], [undefined, config.origin], [config.rpId, "http://rail.example"],
    ["other.example", config.origin], [config.rpId, "https://rail.example/"], [config.rpId, "https://rail.example?token=bad"],
    ["example", "https://example"], [config.rpId, "https://user:secret@rail.example"]])
    assert.throws(() => loadOwnerPasskeyConfig(...values), /INVALID_WEBAUTHN_CONFIGURATION/);
});

test("real WebAuthn registration and assertion yield hashed one-use operation grants", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), issued = await grant(store, key);
    assert.equal(issued.userVerified, true);
    assert.equal((await store.list(principal))[0].credentialId, key.id);
    const rows = (await pool.query("SELECT * FROM rail_owner_step_up_grants")).rows;
    assert.ok(!JSON.stringify(rows).includes(issued.grantToken));
    assert.equal(rows[0].token_hash, createHash("sha256").update(issued.grantToken).digest("hex"));
    assert.equal((await consume(pool, store, issued.grantToken)).credentialId, key.id);
    await assert.rejects(consume(pool, store, issued.grantToken), { code: "owner_step_up_required" });
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT sign_count FROM rail_owner_passkeys")).rows[0].sign_count, "1");
  });
});

test("grants cannot cross owner, session, operation or fingerprint and outer rollback restores consumption", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), issued = await grant(store, key);
    const other = { ...principal, walletId: "other_wallet", userId: "other_user" };
    for (const [op, fpr, owner] of [["agent_mandate", fingerprint, principal], ["agent_approval", "c".repeat(64), principal],
      ["agent_approval", fingerprint, { ...principal, sessionFingerprint: "c".repeat(64) }], ["agent_approval", fingerprint, other]])
      await assert.rejects(consume(pool, store, issued.grantToken, op, fpr, owner), { code: "owner_step_up_required" });
    await consume(pool, store, issued.grantToken, "agent_approval", fingerprint, principal, true);
    await consume(pool, store, issued.grantToken);
    const client = await pool.connect();
    try { await assert.rejects(store.consumeGrant(client, principal, issued.grantToken, "agent_approval", fingerprint), { code: "25P01" }); }
    finally { client.release(); }
  });
});

test("registration requires password bootstrap and an existing passkey for later enrollment", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store }) => {
    await assert.rejects(store.registrationOptions(principal, {}), { code: "password_reauthentication_failed" });
    await assert.rejects(store.registrationOptions(principal, { password: "wrong_password" }), { status: 401 });
    const key = await enroll(store);
    await assert.rejects(store.registrationOptions(principal, { password }), { code: "owner_step_up_required" });
    const issued = await grant(store, key, principal, "passkey_enroll", ENROLLMENT_FINGERPRINT);
    const options = await store.registrationOptions(principal, { grantToken: issued.grantToken });
    const second = authenticator();
    await store.register(principal, { challengeId: options.challengeId, response: second.registration(options.options.challenge) });
    assert.equal((await store.list(principal)).length, 2);
    await assert.rejects(store.registrationOptions(principal, { grantToken: issued.grantToken }), { status: 403 });
  });
});

test("wrong origins, cross-origin frames, UV absence and signature tampering consume failed challenges", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store }) => {
    const key = await enroll(store);
    for (const [changes, flags, tamper] of [[{ origin: "https://attacker.example" }, 0x05, false], [{ crossOrigin: true }, 0x05, false],
      [{ topOrigin: "https://attacker.example" }, 0x05, false], [{}, 0x01, false], [{}, 0x05, true]]) {
      const request = await store.authenticationOptions(principal, { operation: "agent_approval", operationFingerprint: fingerprint });
      const response = key.assertion(request.options.challenge, 1, changes, flags);
      if (tamper) response.response.signature = randomBytes(64).toString("base64url");
      await assert.rejects(store.authenticate(principal, { challengeId: request.challengeId, response }), { code: "passkey_verification_failed" });
      await assert.rejects(store.authenticate(principal, { challengeId: request.challengeId, response: key.assertion(request.options.challenge) }), { code: "passkey_challenge_unavailable" });
    }
  });
});

test("challenge replay and credential counter replay cannot mint another grant", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, pool }) => {
    const key = await enroll(store), request = await store.authenticationOptions(principal, { operation: "agent_approval", operationFingerprint: fingerprint });
    const value = { challengeId: request.challengeId, response: key.assertion(request.options.challenge) };
    const results = await Promise.allSettled([store.authenticate(principal, value), store.authenticate(principal, value)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "passkey_challenge_unavailable");
    await assert.rejects(grant(store, key), { code: "passkey_verification_failed" });
    assert.equal((await pool.query("SELECT * FROM rail_owner_step_up_grants")).rowCount, 1);
  });
});

test("stale sessions, changed session fingerprints and revoked passkeys cannot verify or consume", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), request = await store.authenticationOptions(principal, { operation: "agent_approval", operationFingerprint: fingerprint });
    await assert.rejects(store.authenticate({ ...principal, sessionFingerprint: "c".repeat(64) }, { challengeId: request.challengeId, response: key.assertion(request.options.challenge) }), { code: "passkey_challenge_unavailable" });
    const issued = await store.authenticate(principal, { challengeId: request.challengeId, response: key.assertion(request.options.challenge) });
    await pool.query("UPDATE rail_owner_passkeys SET revoked_at=clock_timestamp() WHERE credential_id=$1", [key.id]);
    await assert.rejects(consume(pool, store, issued.grantToken), { code: "owner_step_up_required" });
    await assert.rejects(store.registrationOptions(principal, { password }), { code: "owner_step_up_required" });
    await pool.query("UPDATE users SET auth_version=auth_version+1 WHERE user_id=$1", [principal.userId]);
    await assert.rejects(store.list(principal), { code: "invalid_credentials" });
  });
});

test("pending bootstrap cannot enroll another key after a first enrollment completes", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store }) => {
    const first = await store.registrationOptions(principal, { password }), second = await store.registrationOptions(principal, { password });
    const key = authenticator(), other = authenticator();
    await store.register(principal, { challengeId: first.challengeId, response: key.registration(first.options.challenge) });
    await assert.rejects(store.register(principal, { challengeId: second.challengeId, response: other.registration(second.options.challenge) }), { code: "passkey_enrollment_changed" });
    assert.equal((await store.list(principal)).length, 1);
  });
});

test("SQL guards reject key replacement, counter rollback, challenge rewrites and grant resurrection", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), issued = await grant(store, key);
    await assert.rejects(pool.query("UPDATE rail_owner_passkeys SET sign_count=0 WHERE credential_id=$1", [key.id]), /owner_passkey_history_is_immutable/);
    await assert.rejects(pool.query("DELETE FROM rail_owner_passkeys WHERE credential_id=$1", [key.id]), { code: "23514" });
    await assert.rejects(pool.query("UPDATE rail_owner_challenges SET operation_fingerprint=$1", ["c".repeat(64)]), /owner_challenge_is_immutable/);
    await consume(pool, store, issued.grantToken);
    await assert.rejects(pool.query("UPDATE rail_owner_step_up_grants SET consumed_at=NULL"), /owner_step_up_grant_is_immutable/);
  });
});

test("HTTP passkey routes require owner JWTs, enforce quotas and never cache ceremony data", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const original = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "passkey_route_test_secret_01234567890123456789";
    try {
      const context = { pool, config: loadServerConfig(), ownerPasskeys: store, rateLimiter: new PostgresRateLimiter(pool),
        authResolver: createAuthResolver({ getPool: () => pool, apiKey: "service_key", apiKeyScopes: [] }) };
      const call = async (bearer, i = 0) => {
        const req = Readable.from([]); req.method = "GET"; req.headers = { authorization: `Bearer ${bearer}` };
        req.socket = { remoteAddress: `192.0.2.${i + 1}` };
        const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
        await handlePasskeyRoutes(req, res, new URL("https://rail.example/auth/passkeys"), context);
        assert.equal(res.headers["Cache-Control"], "no-store"); return res;
      };
      await assert.rejects(call(`rail_agent_${randomBytes(32).toString("base64url")}`), { status: 401 });
      const token = generateToken(principal.userId);
      for (let i = 0; i < 30; i++) assert.equal((await call(token, i)).status, 200);
      await assert.rejects(call(token, 31), { status: 429 });
    } finally { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; }
  });
});

test("registration rejects wrong origin and absent user verification without leaving reusable challenges", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store }) => {
    const key = authenticator();
    for (const [changes, flags] of [[{ origin: "https://attacker.example" }, 0x45], [{}, 0x41], [{ crossOrigin: true }, 0x45]]) {
      const request = await store.registrationOptions(principal, { password });
      await assert.rejects(store.register(principal, { challengeId: request.challengeId, response: key.registration(request.options.challenge, changes, flags) }), { code: "passkey_verification_failed" });
      await assert.rejects(store.register(principal, { challengeId: request.challengeId, response: key.registration(request.options.challenge) }), { code: "passkey_challenge_unavailable" });
    }
    assert.equal((await store.list(principal)).length, 0);
  });
});

test("outstanding challenge capacity is shared across instances and user sessions", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    await enroll(store);
    const second = new OwnerPasskeyStore(pool, config);
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? store : second).authenticationOptions(
      { ...principal, sessionFingerprint: createHash("sha256").update(`session_${i}`).digest("hex") }, { operation: "agent_approval", operationFingerprint: fingerprint })));
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 5);
    for (const item of outcomes.filter(item => item.status === "rejected")) assert.equal(item.reason.code, "passkey_challenge_capacity");
  });
});

test("another owner's enrolled passkey cannot authenticate the current owner's challenge", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store }) => {
    await enroll(store);
    const other = { ...principal, walletId: "other_wallet", userId: "other_user" }, otherKey = await enroll(store, other);
    const request = await store.authenticationOptions(principal, { operation: "agent_approval", operationFingerprint: fingerprint });
    await assert.rejects(store.authenticate(principal, { challengeId: request.challengeId, response: otherKey.assertion(request.options.challenge) }), { code: "passkey_verification_failed" });
  });
});

test("database-clock expired challenges and grants are denied without accepting history edits", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), issued = await grant(store, key), expiredId = randomUUID();
    await pool.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO rail_owner_challenges(challenge_id,user_id,auth_version,session_fingerprint,kind,challenge,operation,
        operation_fingerprint,bootstrap,rp_id,origin,created_at,expires_at,used_at)
      SELECT $1,user_id,auth_version,session_fingerprint,kind,challenge,operation,operation_fingerprint,bootstrap,rp_id,origin,
        now-interval '6 minutes',now-interval '1 minute',now-interval '5 minutes'
      FROM rail_owner_challenges,instant WHERE kind='authentication' LIMIT 1`, [expiredId]);
    const expiredToken = `rail_step_up_${randomBytes(32).toString("base64url")}`;
    await pool.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO rail_owner_step_up_grants(token_hash,challenge_id,credential_id,user_id,auth_version,session_fingerprint,
        operation,operation_fingerprint,created_at,expires_at)
      SELECT $1,$2,credential_id,user_id,auth_version,session_fingerprint,operation,operation_fingerprint,
        now-interval '5 minutes',now-interval '3 minutes' FROM rail_owner_step_up_grants,instant LIMIT 1`,
      [createHash("sha256").update(expiredToken).digest("hex"), expiredId]);
    await assert.rejects(consume(pool, store, expiredToken), { code: "owner_step_up_required" });
    await assert.rejects(store.authenticate(principal, { challengeId: expiredId, response: key.assertion("expired_challenge") }), { code: "passkey_challenge_unavailable" });
    await assert.rejects(pool.query("UPDATE rail_owner_step_up_grants SET expires_at=expires_at+interval '1 second'"), /owner_step_up_grant_is_immutable/);
    await consume(pool, store, issued.grantToken);
  });
});

test("passkey grants protect actual credential, mandate and approval transactions with verified receipts", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict } = agentStores(pool, store), owner = principal.walletId;
    const agent = await strict.createAgent(owner, { name: "Stepped owner agent" });
    const credentialBody = { scope: "payments:execute", ttlSeconds: 3600 };
    await assert.rejects(strict.issueCredential(owner, agent.agentId, credentialBody, principal), { code: "owner_step_up_required" });
    const credentialGrant = await grant(store, key, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, credentialBody), 1);
    const credential = await strict.issueCredential(owner, agent.agentId, { ...credentialBody, grantToken: credentialGrant.grantToken }, principal);
    await assert.rejects(strict.createMandate(owner, agent.agentId, mandatePolicy, principal), { code: "owner_step_up_required" });
    const mandateGrant = await grant(store, key, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, mandatePolicy), 2);
    const mandate = await strict.createMandate(owner, agent.agentId, { ...mandatePolicy, grantToken: mandateGrant.grantToken }, principal);
    const intent = await strict.createIntent(credential.token, { mandateId: mandate.mandateId, clientRequestId: "stepped_request_001", receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" });
    const request = { requestFingerprint: intent.requestFingerprint };
    await assert.rejects(strict.decideIntent(owner, agent.agentId, intent.intentId, { ...request, decision: "approve" }, principal), { code: "owner_step_up_required" });
    const approvalGrant = await grant(store, key, principal, "agent_approval", approvalOperationFingerprint(agent.agentId, intent.intentId, intent.requestFingerprint), 3);
    await strict.decideIntent(owner, agent.agentId, intent.intentId, { ...request, decision: "approve", grantToken: approvalGrant.grantToken }, principal);
    const first = await strict.executeIntent(credential.token, intent.intentId, request);
    assert.equal(first.result.status, "accepted");
    const proof = await strict.readAuthority(owner, agent.agentId, intent.intentId);
    assert.equal(proof.status, "verified");
    assert.equal(proof.receipt.credentialOwnerStepUp.method, "passkey");
    assert.equal(proof.receipt.credentialOwnerStepUp.credentialId, key.id);
    for (const ownerEvidence of [proof.ownerEvidence.mandate, proof.ownerEvidence.approval]) {
      assert.equal(ownerEvidence.record.authentication.stepUp.method, "passkey");
      assert.equal(ownerEvidence.record.authentication.stepUp.credentialId, key.id);
    }
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_step_up_grants WHERE consumed_at IS NOT NULL")).rows[0].count, "3");
    assert.deepEqual(await strict.executeIntent(credential.token, intent.intentId, request), first);
    assert.equal((await pool.query("SELECT balance FROM wallets WHERE wallet_id='other_wallet'")).rows[0].balance, "100");
  }, 1000);
});

test("changing normalized mandate terms cannot reuse a grant and failed attempts leave the grant usable", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict } = agentStores(pool, store), agent = await strict.createAgent(principal.walletId, { name: "Exact grant binding" });
    const issued = await grant(store, key, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, mandatePolicy));
    for (const change of [{ totalBudgetMinor: 2000 }, { mode: "budgeted" }, { ttlSeconds: 7200 }])
      await assert.rejects(strict.createMandate(principal.walletId, agent.agentId, { ...mandatePolicy, ...change, grantToken: issued.grantToken }, principal), { code: "owner_step_up_required" });
    await assert.rejects(strict.createMandate(principal.walletId, agent.agentId, { ...mandatePolicy, grantToken: issued.grantToken },
      { ...principal, sessionFingerprint: "c".repeat(64) }), { code: "owner_step_up_required" });
    await strict.createMandate(principal.walletId, agent.agentId, { ...mandatePolicy, grantToken: issued.grantToken }, principal);
    await assert.rejects(strict.createMandate(principal.walletId, agent.agentId, { ...mandatePolicy, grantToken: issued.grantToken }, principal), { code: "owner_step_up_required" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_mandates")).rowCount, 1);
  });
});

test("failed authority audit rolls back grant consumption, consent encryption and the protected action", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict } = agentStores(pool, store), agent = await strict.createAgent(principal.walletId, { name: "Grant rollback" });
    const issued = await grant(store, key, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, mandatePolicy));
    await pool.query("CREATE FUNCTION fail_owner_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='agent.mandate_created' THEN RAISE EXCEPTION 'injected_owner_audit_failure'; END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER fail_owner_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_owner_audit()");
    const body = { ...mandatePolicy, grantToken: issued.grantToken };
    await assert.rejects(strict.createMandate(principal.walletId, agent.agentId, body, principal), /injected_owner_audit_failure/);
    assert.equal((await pool.query("SELECT * FROM rail_agent_owner_evidence")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_evidence_nonces")).rowCount, 0);
    assert.equal((await pool.query("SELECT consumed_at FROM rail_owner_step_up_grants")).rows[0].consumed_at, null);
    await pool.query("DROP TRIGGER fail_owner_audit ON outbox");
    await strict.createMandate(principal.walletId, agent.agentId, body, principal);
  });
});

test("strict cutover denies legacy grants and execution credentials without rewriting historical receipts", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict, legacy } = agentStores(pool, store), owner = principal.walletId;
    const agent = await legacy.createAgent(owner, { name: "Legacy cutover" });
    const credential = await legacy.issueCredential(owner, agent.agentId, { scope: "payments:execute" });
    const mandate = await legacy.createMandate(owner, agent.agentId, { ...mandatePolicy, mode: "budgeted" });
    const input = { mandateId: mandate.mandateId, clientRequestId: "legacy_owner_request", receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" };
    const intent = await legacy.createIntent(credential.token, input), request = { requestFingerprint: intent.requestFingerprint };
    await legacy.executeIntent(credential.token, intent.intentId, request);
    const receipt = await legacy.readAuthority(owner, agent.agentId, intent.intentId);
    assert.equal((await strict.resolveCredential(credential.token)).executionEnabled, false);
    assert.equal((await strict.listMandates(owner, agent.agentId))[0].executionEnabled, false);
    await assert.rejects(strict.createIntent(credential.token, { ...input, clientRequestId: "new_legacy_request" }), { code: "fresh_owner_step_up_required" });
    await assert.rejects(strict.executeIntent(credential.token, intent.intentId, request), { code: "fresh_execution_credential_required" });
    const body = { scope: "payments:execute" }, issued = await grant(store, key, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, body));
    const fresh = await strict.issueCredential(owner, agent.agentId, { ...body, grantToken: issued.grantToken }, principal);
    assert.equal((await strict.executeIntent(fresh.token, intent.intentId, request)).result.status, "accepted");
    assert.deepEqual(await strict.readAuthority(owner, agent.agentId, intent.intentId), receipt);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  }, 1000);
});

test("strict authority cannot bypass missing passkey service or forge passkey metadata in request JSON", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const { strict } = agentStores(pool, store), agent = await strict.createAgent(principal.walletId, { name: "Missing or forged step-up" });
    const unavailable = new AgentAuthorityStore(pool, undefined, undefined, undefined, { required: true });
    await assert.rejects(unavailable.issueCredential(principal.walletId, agent.agentId, { scope: "payments:execute" }, principal), { status: 503 });
    await assert.rejects(strict.createMandate(principal.walletId, agent.agentId, { ...mandatePolicy,
      authentication: { stepUp: { method: "passkey" } }, grantToken: `rail_step_up_${randomBytes(32).toString("base64url")}` }, principal), { code: "owner_step_up_required" });
    assert.equal((await pool.query("SELECT * FROM rail_agent_mandates")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 0);
  });
});

test("SQL cannot rebind one owner grant to multiple credentials or different issuance terms", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict } = agentStores(pool, store), agent = await strict.createAgent(principal.walletId, { name: "SQL grant guard" });
    const body = { scope: "payments:execute", ttlSeconds: 3600 }, fpr = credentialOperationFingerprint(agent.agentId, body);
    const first = await grant(store, key, principal, "agent_credential", fpr, 1);
    const credential = await strict.issueCredential(principal.walletId, agent.agentId, { ...body, grantToken: first.grantToken }, principal);
    const challengeId = (await pool.query("SELECT owner_step_up_challenge_id FROM rail_agent_credentials WHERE credential_id=$1", [credential.credentialId])).rows[0].owner_step_up_challenge_id;
    const insert = async (id, seconds) => pool.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO rail_agent_credentials(credential_id,agent_id,token_hash,scope,created_at,expires_at,owner_step_up_challenge_id)
      SELECT $1,$2,$3,'payments:execute',now,now+$4*interval '1 second',$5 FROM instant`,
      [randomUUID(), agent.agentId, randomBytes(32).toString("hex"), seconds, id]);
    await assert.rejects(insert(challengeId, 3600), { code: "23505" });
    const next = await grant(store, key, principal, "agent_credential", fpr, 2);
    const proof = await consume(pool, store, next.grantToken, "agent_credential", fpr);
    await assert.rejects(insert(proof.challengeId, 7200), /agent_credential_step_up_binding_invalid/);
    await assert.rejects(pool.query("UPDATE rail_agent_credentials SET owner_step_up_challenge_id=NULL WHERE credential_id=$1", [credential.credentialId]), /agent_credential_is_immutable/);
    assert.equal((await pool.query("SELECT * FROM rail_agent_credentials")).rowCount, 1);
  });
});

test("HTTP owner JWT alone cannot create spending authority but an exact same-session grant can", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const original = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "stepped_owner_route_secret_01234567890123456789";
    try {
      const token = generateToken(principal.userId), owner = { ...principal, sessionFingerprint: createHash("sha256").update(token).digest("hex") };
      const key = await enroll(store, owner), { strict } = agentStores(pool, store), agent = await strict.createAgent(owner.walletId, { name: "HTTP step-up owner" });
      const context = { config: loadServerConfig(), agentStore: strict, rateLimiter: new PostgresRateLimiter(pool),
        authResolver: createAuthResolver({ getPool: () => pool, apiKey: "service_key", apiKeyScopes: [] }) };
      const call = async body => {
        const req = Readable.from([JSON.stringify(body)]); req.method = "POST";
        req.headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }; req.socket = { remoteAddress: "192.0.2.1" };
        const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
        await handleAgentRoutes(req, res, new URL(`https://rail.example/v2/agents/${agent.agentId}/mandates`), context); return res;
      };
      await assert.rejects(call({ ...mandatePolicy, ownerVerified: true, authentication: { method: "passkey" } }), { code: "owner_step_up_required" });
      const issued = await grant(store, key, owner, "agent_mandate", mandateOperationFingerprint(agent.agentId, mandatePolicy));
      assert.equal((await call({ ...mandatePolicy, grantToken: issued.grantToken })).status, 201);
      assert.equal((await pool.query("SELECT * FROM rail_agent_mandates")).rowCount, 1);
    } finally { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; }
  });
});

test("recovery codes are one-time high-entropy secrets stored only as owner-bound hashes and rotated with a passkey", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store);
    assert.equal(key.recoveryCodes.length, 10); assert.equal(new Set(key.recoveryCodes).size, 10);
    for (const code of key.recoveryCodes) assert.match(code, /^rail_recovery_[A-Za-z0-9_-]{43}$/);
    const rows = await pool.query("SELECT * FROM rail_owner_recovery_codes");
    const events = await pool.query("SELECT * FROM outbox");
    for (const code of key.recoveryCodes) assert.ok(!JSON.stringify([rows.rows, events.rows]).includes(code));
    await assert.rejects(store.rotateRecoveryCodes(principal, {}), { status: 422 });
    const issued = await grant(store, key, principal, "recovery_codes", RECOVERY_CODES_FINGERPRINT);
    const rotated = await store.rotateRecoveryCodes(principal, { grantToken: issued.grantToken });
    assert.equal(rotated.recoveryCodes.length, 10);
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes WHERE revoked_at IS NOT NULL")).rows[0].count, "10");
    await assert.rejects(store.rotateRecoveryCodes(principal, { grantToken: issued.grantToken }), { code: "owner_step_up_required" });
    await assert.rejects(recovery(store, key), { code: "recovery_verification_failed" });
    assert.equal((await pool.query("SELECT auth_version FROM users WHERE user_id=$1", [principal.userId])).rows[0].auth_version, 0);
  });
});

test("recovery atomically withdraws sessions and only the owner's agents while preserving committed money and receipts", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { strict, legacy } = agentStores(pool, store), owner = principal.walletId;
    const agent = await strict.createAgent(owner, { name: "Recovery owner" }), body = { scope: "payments:execute" };
    const cg = await grant(store, key, principal, "agent_credential", credentialOperationFingerprint(agent.agentId, body), 1);
    const credential = await strict.issueCredential(owner, agent.agentId, { ...body, grantToken: cg.grantToken }, principal);
    const policy = { ...mandatePolicy, mode: "budgeted" }, mg = await grant(store, key, principal, "agent_mandate", mandateOperationFingerprint(agent.agentId, policy), 2);
    const mandate = await strict.createMandate(owner, agent.agentId, { ...policy, grantToken: mg.grantToken }, principal);
    const input = { mandateId: mandate.mandateId, clientRequestId: "recovery_spent_request", receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" };
    const spent = await strict.createIntent(credential.token, input);
    await strict.executeIntent(credential.token, spent.intentId, { requestFingerprint: spent.requestFingerprint });
    const proof = await strict.readAuthority(owner, agent.agentId, spent.intentId);
    const held = await strict.createIntent(credential.token, { ...input, clientRequestId: "recovery_held_request" });
    const other = await legacy.createAgent("other_wallet", { name: "Unaffected other owner" });
    const otherCredential = await legacy.issueCredential("other_wallet", other.agentId, {});
    const restored = await recovery(store, key);
    await assert.rejects(store.list(principal), { code: "invalid_credentials" });
    assert.equal((await store.list(restored.owner))[0].revokedAt !== null, true);
    await assert.rejects(strict.resolveCredential(credential.token), { status: 401 });
    assert.equal((await legacy.resolveCredential(otherCredential.token)).agentId, other.agentId);
    assert.equal((await strict.listAgents(owner))[0].status, "revoked");
    const intents = await strict.listIntents(owner, agent.agentId);
    assert.equal(intents.find(item => item.intentId === held.intentId).status, "rejected");
    assert.equal(intents.find(item => item.intentId === spent.intentId).status, "executed");
    const policyState = (await strict.listMandates(owner, agent.agentId))[0];
    assert.equal(policyState.reservedBudgetMinor, 0); assert.equal(policyState.spentBudgetMinor, 100);
    assert.deepEqual(await strict.readAuthority(owner, agent.agentId, spent.intentId), proof);
    assert.equal((await pool.query("SELECT balance FROM wallets WHERE wallet_id=$1", [owner])).rows[0].balance, "900");
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
    const user = (await pool.query("SELECT * FROM users WHERE user_id=$1", [principal.userId])).rows[0];
    assert.equal(user.auth_version, 1); assert.equal(user.owner_recovery_pending, true);
    assert.equal(await compare(password, user.password_hash), false); assert.equal(await compare(replacementPassword, user.password_hash), true);
    const serialized = JSON.stringify((await pool.query("SELECT payload FROM outbox")).rows);
    for (const secret of [restored.result.token, restored.result.recoveryToken, key.recoveryCodes[0], password, replacementPassword]) assert.ok(!serialized.includes(secret));
  }, 1000);
});

test("recovery capability is session-bound and enrollment-only, and successful enrollment rotates unused old codes", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), restored = await recovery(store, key);
    await assert.rejects(store.registrationOptions(restored.owner, { password: replacementPassword }), { code: "recovery_enrollment_required" });
    await assert.rejects(store.registrationOptions({ ...restored.owner, sessionFingerprint: "e".repeat(64) }, { recoveryToken: restored.result.recoveryToken }), { code: "recovery_enrollment_required" });
    await assert.rejects(store.authenticationOptions(restored.owner, { operation: "agent_mandate", operationFingerprint: fingerprint }), { code: "recovery_enrollment_required" });
    await assert.rejects(consume(pool, store, restored.result.recoveryToken, "agent_mandate", fingerprint, restored.owner), { code: "recovery_enrollment_required" });
    const completed = await finishRecovery(store, restored);
    assert.equal(completed.result.recoveryCodes.length, 10);
    assert.equal((await pool.query("SELECT owner_recovery_pending FROM users WHERE user_id=$1", [principal.userId])).rows[0].owner_recovery_pending, false);
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes WHERE consumed_at IS NULL AND revoked_at IS NULL")).rows[0].count, "10");
    await assert.rejects(store.registrationOptions(restored.owner, { recoveryToken: restored.result.recoveryToken }), { code: "recovery_enrollment_required" });
    await assert.rejects(recovery(store, key, restored.owner, replacementPassword, "another_recovery_password", 1), { code: "recovery_verification_failed" });
    assert.equal((await grant(store, completed.key, restored.owner)).userVerified, true);
  });
});

test("simultaneous recovery attempts consume a code once and revoke the stale competing session", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store);
    const results = await Promise.allSettled([recovery(store, key), recovery(store, key)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "invalid_credentials");
    const restored = results.find(result => result.status === "fulfilled").value;
    await assert.rejects(recovery(store, key, restored.owner, replacementPassword, "another_recovery_password"), { code: "recovery_verification_failed" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes WHERE consumed_at IS NOT NULL")).rows[0].count, "1");
  });
});

test("lost recovery response can restart with a remaining code and supersedes the original enrollment capability", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), first = await recovery(store, key);
    const alternateToken = generateToken(principal.userId, 1), alternate = recoveredPrincipal({ token: alternateToken });
    await assert.rejects(store.registrationOptions(alternate, { recoveryToken: first.result.recoveryToken }), { code: "recovery_enrollment_required" });
    const second = await recovery(store, key, alternate, replacementPassword, "recovered_again_password_12345", 1);
    await assert.rejects(store.registrationOptions(second.owner, { recoveryToken: first.result.recoveryToken }), { code: "recovery_enrollment_required" });
    await finishRecovery(store, second);
    const states = (await pool.query("SELECT completed_at,superseded_at FROM rail_owner_recoveries ORDER BY created_at")).rows;
    assert.ok(states[0].superseded_at); assert.ok(states[1].completed_at);
    assert.equal((await pool.query("SELECT auth_version FROM users WHERE user_id=$1", [principal.userId])).rows[0].auth_version, 2);
  });
});

test("recovery failure before audit and at deferred commit restores password, code, passkeys and delegation", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { legacy } = agentStores(pool, store), agent = await legacy.createAgent(principal.walletId, { name: "Recovery rollback" });
    const before = (await pool.query("SELECT password_hash FROM users WHERE user_id=$1", [principal.userId])).rows[0].password_hash;
    await pool.query("CREATE FUNCTION fail_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='owner.recovery_started' THEN RAISE EXCEPTION 'injected_recovery_audit_failure'; END IF; RETURN NEW; END $$");
    for (const deferred of [false, true]) {
      await pool.query(deferred ? "CREATE CONSTRAINT TRIGGER fail_recovery_audit AFTER INSERT ON outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit()" : "CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit()");
      await assert.rejects(recovery(store, key), /injected_recovery_audit_failure/);
      await pool.query("DROP TRIGGER fail_recovery_audit ON outbox");
      const user = (await pool.query("SELECT * FROM users WHERE user_id=$1", [principal.userId])).rows[0];
      assert.equal(user.auth_version, 0); assert.equal(user.password_hash, before); assert.equal(user.owner_recovery_pending, false);
      assert.equal((await store.list(principal))[0].revokedAt, null);
      assert.equal((await legacy.listAgents(principal.walletId))[0].status, "active");
      assert.equal((await pool.query("SELECT * FROM rail_owner_recoveries")).rowCount, 0);
      assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes WHERE consumed_at IS NOT NULL")).rows[0].count, "0");
    }
    const restored = await recovery(store, key);
    assert.equal((await legacy.listAgents(principal.walletId))[0].agentId, agent.agentId);
    await finishRecovery(store, restored);
  });
});

test("recovery enrollment audit failure does not complete recovery or commit a new key or code rotation", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), restored = await recovery(store, key), next = authenticator();
    const options = await store.registrationOptions(restored.owner, { recoveryToken: restored.result.recoveryToken });
    const request = { challengeId: options.challengeId, response: next.registration(options.options.challenge) };
    await pool.query("CREATE FUNCTION fail_reenrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='owner.passkey_enrolled' THEN RAISE EXCEPTION 'injected_reenrollment_failure'; END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER fail_reenrollment BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_reenrollment()");
    await assert.rejects(store.register(restored.owner, request), /injected_reenrollment_failure/);
    assert.equal((await pool.query("SELECT completed_at FROM rail_owner_recoveries")).rows[0].completed_at, null);
    assert.equal((await pool.query("SELECT * FROM rail_owner_passkeys WHERE revoked_at IS NULL")).rowCount, 0);
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes")).rows[0].count, "10");
    await pool.query("DROP TRIGGER fail_reenrollment ON outbox");
    assert.equal((await store.register(restored.owner, request)).credentialId, next.id);
  });
});

test("one scoped recovery completes only one of two simultaneous enrollment ceremonies", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), restored = await recovery(store, key);
    const options = await Promise.all([0, 1].map(() => store.registrationOptions(restored.owner, { recoveryToken: restored.result.recoveryToken })));
    const results = await Promise.allSettled(options.map(option => { const next = authenticator(); return store.register(restored.owner, { challengeId: option.challengeId, response: next.registration(option.options.challenge) }); }));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "recovery_enrollment_required");
    assert.equal((await pool.query("SELECT * FROM rail_owner_passkeys WHERE revoked_at IS NULL")).rowCount, 1);
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes")).rows[0].count, "20");
  });
});

test("passkey removal is exact-operation bound, refuses the last key and invalidates grants from a removed key", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const first = await enroll(store), only = await grant(store, first, principal, "passkey_revoke", revokePasskeyFingerprint(first.id), 1);
    await assert.rejects(store.revokePasskey(principal, { credentialId: first.id, grantToken: only.grantToken }), { code: "last_passkey" });
    const enrollGrant = await grant(store, first, principal, "passkey_enroll", ENROLLMENT_FINGERPRINT, 2);
    const options = await store.registrationOptions(principal, { grantToken: enrollGrant.grantToken }), second = authenticator();
    await store.register(principal, { challengeId: options.challengeId, response: second.registration(options.options.challenge) });
    const outstanding = await grant(store, second);
    const revoke = await grant(store, first, principal, "passkey_revoke", revokePasskeyFingerprint(second.id), 3);
    await assert.rejects(store.revokePasskey(principal, { credentialId: first.id, grantToken: revoke.grantToken }), { code: "owner_step_up_required" });
    await store.revokePasskey(principal, { credentialId: second.id, grantToken: revoke.grantToken });
    await assert.rejects(consume(pool, store, outstanding.grantToken), { code: "owner_step_up_required" });
    assert.equal((await pool.query("SELECT * FROM rail_owner_passkeys WHERE revoked_at IS NULL")).rowCount, 1);
    assert.equal((await pool.query("SELECT * FROM rail_owner_passkeys")).rowCount, 2);
  });
});

test("pending additional enrollment cannot survive revocation of the passkey that authorized it", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, pool }) => {
    const first = await enroll(store), enrollGrant = await grant(store, first, principal, "passkey_enroll", ENROLLMENT_FINGERPRINT, 1);
    const options = await store.registrationOptions(principal, { grantToken: enrollGrant.grantToken }), second = authenticator();
    await store.register(principal, { challengeId: options.challengeId, response: second.registration(options.options.challenge) });
    const pendingGrant = await grant(store, second, principal, "passkey_enroll", ENROLLMENT_FINGERPRINT, 1);
    const pending = await store.registrationOptions(principal, { grantToken: pendingGrant.grantToken }), third = authenticator();
    const revoke = await grant(store, first, principal, "passkey_revoke", revokePasskeyFingerprint(second.id), 2);
    await store.revokePasskey(principal, { credentialId: second.id, grantToken: revoke.grantToken });
    await assert.rejects(store.register(principal, { challengeId: pending.challengeId, response: third.registration(pending.options.challenge) }), { code: "owner_step_up_required" });
    assert.equal((await pool.query("SELECT * FROM rail_owner_passkeys")).rowCount, 2);
  });
});

test("recovery history cannot be resurrected and a wallet cannot acquire another authentication owner", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), restored = await recovery(store, key);
    await assert.rejects(pool.query("UPDATE rail_owner_recovery_codes SET consumed_at=NULL WHERE consumed_at IS NOT NULL"), /owner_recovery_code_is_immutable/);
    await assert.rejects(pool.query("INSERT INTO users(user_id,password_hash,wallet_id) VALUES('duplicate_owner','not_used','owner_wallet')"), { code: "23505" });
    await finishRecovery(store, restored);
    await assert.rejects(pool.query("UPDATE rail_owner_recoveries SET completed_at=NULL"), /owner_recovery_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_owner_passkeys SET recovery_id=NULL WHERE recovery_id IS NOT NULL"), /owner_passkey_history_is_immutable/);
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_passkeys WHERE revoked_at IS NULL")).rows[0].count, "1");
  });
});

test("HTTP recovery attempts require owner credentials and retain shared account quotas across source rotation", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    await enroll(store);
    const context = { config: loadServerConfig(), ownerPasskeys: store, rateLimiter: new PostgresRateLimiter(pool),
      authResolver: createAuthResolver({ getPool: () => pool, apiKey: "service_key", apiKeyScopes: [] }) };
    const token = generateToken(principal.userId);
    const call = async (bearer, i) => {
      const req = Readable.from([JSON.stringify({ password, newPassword: replacementPassword, recoveryCode: `rail_recovery_${randomBytes(32).toString("base64url")}` })]);
      req.method = "POST"; req.headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" }; req.socket = { remoteAddress: `192.0.2.${i + 1}` };
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead() {}, end() {} };
      try { await handlePasskeyRoutes(req, res, new URL("https://rail.example/auth/passkeys/recover"), context); }
      finally { assert.equal(res.headers["Cache-Control"], "no-store"); }
    };
    await assert.rejects(call(`rail_agent_${randomBytes(32).toString("base64url")}`, 20), { status: 401 });
    for (let i = 0; i < 5; i++) await assert.rejects(call(token, i), { code: "recovery_verification_failed" });
    await assert.rejects(call(token, 6), { status: 429 });
    assert.equal((await pool.query("SELECT auth_version FROM users WHERE user_id=$1", [principal.userId])).rows[0].auth_version, 0);
  });
});

test("re-enrolling an old revoked credential cannot prematurely complete recovery or consume its authorization", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), restored = await recovery(store, key);
    const options = await store.registrationOptions(restored.owner, { recoveryToken: restored.result.recoveryToken });
    await assert.rejects(store.register(restored.owner, { challengeId: options.challengeId, response: key.registration(options.options.challenge) }), { code: "passkey_already_registered" });
    assert.equal((await pool.query("SELECT completed_at FROM rail_owner_recoveries")).rows[0].completed_at, null);
    assert.equal((await pool.query("SELECT owner_recovery_pending FROM users WHERE user_id=$1", [principal.userId])).rows[0].owner_recovery_pending, true);
    assert.equal((await pool.query("SELECT * FROM rail_owner_passkeys WHERE revoked_at IS NULL")).rowCount, 0);
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes")).rows[0].count, "10");
    await finishRecovery(store, restored);
  });
});

test("a real backend disconnect during recovery rolls back the factor withdrawal and keeps the code usable", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store);
    await pool.query("CREATE FUNCTION crash_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='owner.recovery_started' THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER crash_recovery BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION crash_recovery()");
    await assert.rejects(recovery(store, key), /terminat/i);
    const state = (await pool.query("SELECT auth_version,owner_recovery_pending FROM users WHERE user_id=$1", [principal.userId])).rows[0];
    assert.equal(state.auth_version, 0); assert.equal(state.owner_recovery_pending, false);
    assert.equal((await pool.query("SELECT * FROM rail_owner_recoveries")).rowCount, 0);
    assert.equal((await pool.query("SELECT count(*) FROM rail_owner_recovery_codes WHERE consumed_at IS NOT NULL")).rows[0].count, "0");
    assert.equal((await store.list(principal))[0].revokedAt, null);
    await pool.query("DROP TRIGGER crash_recovery ON outbox");
    await finishRecovery(store, await recovery(store, key));
  });
});

test("recovery withdraws ordinary authorizations, wallet keys and offline tokens and blocks pending financial access", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), tokens = new PostgresOfflineTokenStore(pool);
    const offline = await tokens.issue({ walletId: principal.walletId, deviceId: "recovery_device", amountCapMinor: 100, currency: "INR", ttlSeconds: 3600 });
    const apiKey = randomBytes(32).toString("hex");
    await pool.query("INSERT INTO api_keys(key_id,api_key_hash,wallet_id) VALUES('recovery_wallet_key',$1,$2)", [createHash("sha256").update(apiKey).digest("hex"), principal.walletId]);
    const authorization = await createAuthorization({ txId: "recovery_human_authorization", senderWalletId: principal.walletId, receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" }, pool);
    const resolver = createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] });
    const restored = await recovery(store, key);
    assert.equal((await pool.query("SELECT status FROM authorizations WHERE auth_id=$1", [authorization.authId])).rows[0].status, "revoked");
    const wallet = (await pool.query("SELECT balance,reserved FROM wallets WHERE wallet_id=$1", [principal.walletId])).rows[0];
    assert.equal(wallet.balance, "1000"); assert.equal(wallet.reserved, "0");
    assert.ok((await pool.query("SELECT revoked_at FROM rail_offline_tokens WHERE token_id=$1", [offline.tokenId])).rows[0].revoked_at);
    await assert.rejects(resolver.resolveAuthenticatedWallet({ headers: { "x-rail-api-key": apiKey } }), { code: "invalid_credentials" });
    await assert.rejects(resolver.resolveAuthenticatedWallet({ headers: { authorization: `Bearer ${restored.result.token}` } }), { code: "recovery_enrollment_required" });
    await assert.rejects(createAuthorization({ txId: "pending_recovery_authorize", senderWalletId: principal.walletId, receiverWalletId: "other_wallet", amountMinor: 1, currency: "INR" }, pool), { code: "OWNER_RECOVERY_PENDING" });
    await assert.rejects(tokens.issue({ walletId: principal.walletId, deviceId: "new_recovery_device", amountCapMinor: 100, currency: "INR" }), { code: "OWNER_RECOVERY_PENDING" });
    await assert.rejects(pool.query("UPDATE api_keys SET revoked_at=NULL WHERE key_id='recovery_wallet_key'"), /wallet_key_history_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_offline_tokens SET revoked_at=NULL WHERE token_id=$1", [offline.tokenId]), /offline_token_revocation_is_permanent/);
    await finishRecovery(store, restored);
    assert.equal(await resolver.resolveAuthenticatedWallet({ headers: { authorization: `Bearer ${restored.result.token}` } }), principal.walletId);
    assert.deepEqual(await tokens.beginOfflineSpend({ txId: "recovery_stale_offline", idempotencyKey: "recovery_stale_offline_key", authorizationId: authorization.authId,
      senderWalletId: principal.walletId, receiverWalletId: "other_wallet", amountMinor: 1, currency: "INR", channel: "qr", deviceId: "recovery_device", offlineTokenId: offline.tokenId,
      createdAt: new Date().toISOString() }), { ok: false, reason: "token_revoked" });
  }, 1000);
});

test("financial work revalidates an ingress credential snapshot after recovery and re-enrollment", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store }) => {
    const key = await enroll(store), { engine } = agentStores(pool, store), apiKey = randomBytes(32).toString("hex");
    await pool.query("INSERT INTO api_keys(key_id,api_key_hash,wallet_id) VALUES('stale_snapshot_key',$1,$2)", [createHash("sha256").update(apiKey).digest("hex"), principal.walletId]);
    const resolver = createAuthResolver({ getPool: () => pool, apiKey: "", apiKeyScopes: [] });
    const staleJwt = await resolver.resolveFinancialPrincipal({ headers: { authorization: `Bearer ${generateToken(principal.userId)}` } });
    const staleKey = await resolver.resolveFinancialPrincipal({ headers: { "x-rail-api-key": apiKey } });
    const restored = await recovery(store, key); await finishRecovery(store, restored);
    const input = { txId: "post_recovery_human_payment", senderWalletId: principal.walletId, receiverWalletId: "other_wallet", amountMinor: 100, currency: "INR" };
    await assert.rejects(createAuthorization(input, pool, staleJwt), { code: "WALLET_CREDENTIAL_REVOKED" });
    await assert.rejects(createAuthorization(input, pool, staleKey), { code: "WALLET_CREDENTIAL_REVOKED" });
    const fresh = await resolver.resolveFinancialPrincipal({ headers: { authorization: `Bearer ${restored.result.token}` } });
    const auth = await createAuthorization(input, pool, fresh);
    const txn = { ...input, authorizationId: auth.authId, idempotencyKey: "post_recovery_payment_key", channel: "online", createdAt: auth.createdAt };
    await assert.rejects(engine.execute(txn, staleJwt), { code: "WALLET_CREDENTIAL_REVOKED" });
    await assert.rejects(engine.execute(txn, staleKey), { code: "WALLET_CREDENTIAL_REVOKED" });
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await engine.execute(txn, fresh)).status, "accepted");
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  }, 1000);
});
