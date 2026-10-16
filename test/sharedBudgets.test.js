import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
import dotenv from "dotenv";
import { AgentAuthorityStore, mandateOperationFingerprint } from "../dist/persistence/agentAuthority.js";
import { parseSharedBudgetInput, sharedBudgetOperationFingerprint, sharedBudgetOperationPayload } from "../dist/persistence/sharedBudgets.js";
import { runMigrations, ensureOutboxSchema } from "../dist/persistence/migrate.js";
import { AgentEvidenceStore } from "../dist/persistence/agentEvidence.js";
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";
import { TransactionEvidenceStore } from "../dist/persistence/transactionEvidence.js";
import { PaymentPipelineEngine } from "../dist/pipeline/engine.js";
import { PostgresIdempotencyStore } from "../dist/persistence/postgresIdempotency.js";
import { MemoryDeadLetterQueue } from "../dist/pipeline/dlq.js";
import { noopTracer } from "../dist/pipeline/tracing.js";
import { buildHardenedPaymentPipeline } from "../dist/stages/paymentPipeline.js";

dotenv.config({ quiet: true });
const databaseUrl = process.env.DATABASE_URL;
const owner = "shared_owner", other = "foreign_owner", receiver = "shared_receiver";
const policy = { mode: "budgeted", currency: "INR", perPaymentLimitMinor: 1000000,
  totalBudgetMinor: 1000000, allowedReceiverWalletIds: [receiver], ttlSeconds: 3600 };

async function fixture(work) {
  const schema = `ci_shared_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema}` });
  const previous = process.env.RAIL_SIGNING_SECRET;
  process.env.RAIL_SIGNING_SECRET = "shared_budget_fixture_signing_secret_01234567890123456789";
  await admin.query(`CREATE SCHEMA ${schema}`);
  const key = id => ({ keyId: id, encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) });
  const authorityKey = key("shared_authority"), paymentKey = key("shared_payment");
  const authority = new AgentEvidenceStore(new TransactionKeyRing(authorityKey.keyId, [authorityKey]));
  const engine = new PaymentPipelineEngine({ idempotency: new PostgresIdempotencyStore(pool), tracer: noopTracer,
    dlq: new MemoryDeadLetterQueue(), pipeline: buildHardenedPaymentPipeline(noopTracer),
    evidence: new TransactionEvidenceStore(new TransactionKeyRing(paymentKey.keyId, [paymentKey])) });
  const store = new AgentAuthorityStore(pool, engine, authority);
  try {
    await runMigrations(pool); await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO wallets(wallet_id,balance) VALUES($1,2000000),($2,2000000),($3,0)", [owner, other, receiver]);
    const agents = [];
    for (let i = 0; i < 3; i++) agents.push(await store.createAgent(owner, { name: `Shared agent ${i}` }));
    const terms = { name: "Trip budget", currency: "INR", totalBudgetMinor: 1000000, ttlSeconds: 3600, agentIds: agents.map(agent => agent.agentId) };
    const budget = await store.createSharedBudget(owner, terms);
    const setups = [];
    for (const agent of agents) {
      const mandate = await store.createMandate(owner, agent.agentId, { ...policy, sharedBudgetId: budget.budgetId });
      const credential = await store.issueCredential(owner, agent.agentId, { scope: "payments:execute" });
      setups.push({ agent, mandate, credential });
    }
    const propose = (index, amount = 100, requestId = randomUUID()) => store.createIntent(setups[index].credential.token, {
      mandateId: setups[index].mandate.mandateId, clientRequestId: requestId, receiverWalletId: receiver, amountMinor: amount, currency: "INR" });
    await work({ pool, store, setups, budget, terms, propose, authority });
  } finally {
    if (previous === undefined) delete process.env.RAIL_SIGNING_SECRET; else process.env.RAIL_SIGNING_SECRET = previous;
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
}

test("shared budget consent is canonical, bounded and bound to membership and mandate", () => {
  const first = randomUUID(), second = randomUUID();
  const terms = { name: " Trip ", currency: "INR", totalBudgetMinor: 1000000, agentIds: [first, second] };
  const digest = sharedBudgetOperationFingerprint("create", null, terms);
  assert.equal(digest, sharedBudgetOperationFingerprint("create", null, { ...terms, name: "Trip", agentIds: [second, first] }));
  assert.notEqual(digest, sharedBudgetOperationFingerprint("create", null, { ...terms, totalBudgetMinor: 1000001 }));
  assert.notEqual(mandateOperationFingerprint(first, policy), mandateOperationFingerprint(first, { ...policy, sharedBudgetId: second }));
  assert.throws(() => parseSharedBudgetInput({ ...terms, agentIds: [first, first] }), { status: 422 });
  assert.throws(() => parseSharedBudgetInput({ ...terms, priority: 999 }), { status: 422 });
  assert.throws(() => parseSharedBudgetInput({ ...terms, totalBudgetMinor: Number.MAX_SAFE_INTEGER }), { status: 422 });
  assert.throws(() => sharedBudgetOperationFingerprint("limit", second, { revision: 0, totalBudgetMinor: 100 }), { status: 422 });
  const parsed = parseSharedBudgetInput(terms); terms.agentIds.pop();
  assert.equal(parsed.agentIds.length, 2);
});

test("concurrent agents cannot reserve INR 12500 from an INR 10000 shared envelope", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, budget, propose }) => {
    const results = await Promise.allSettled([propose(0, 650000), propose(1, 350000), propose(2, 250000)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
    const failure = results.find(result => result.status === "rejected");
    assert.equal(failure.reason.code, "shared_budget_exceeded");
    const expected = results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value.amountMinor : 0), 0);
    const [current] = await store.listSharedBudgets(owner);
    assert.equal(current.reservedBudgetMinor, expected);
    assert.equal(current.availableBudgetMinor, 1000000 - expected);
    assert.ok(current.reservedBudgetMinor <= current.totalBudgetMinor);
    assert.equal(Number((await pool.query("SELECT sum(reserved_budget_minor) AS held FROM rail_agent_mandates WHERE shared_budget_id=$1", [budget.budgetId])).rows[0].held), expected);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
  });
});

test("shared reservations replay once, bind request data and cannot be detached by the agent", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, budget, setups, propose }) => {
    const id = randomUUID(), first = await propose(0, 250000, id);
    assert.deepEqual(await propose(0, 250000, id), first);
    await assert.rejects(propose(0, 250001, id), { code: "intent_request_reused" });
    await assert.rejects(store.createIntent(setups[0].credential.token, { mandateId: setups[0].mandate.mandateId,
      clientRequestId: randomUUID(), receiverWalletId: receiver, amountMinor: 1, currency: "INR", sharedBudgetId: null }), { status: 422 });
    assert.equal(first.sharedBudgetId, budget.budgetId);
    assert.equal((await store.listSharedBudgets(owner))[0].reservedBudgetMinor, 250000);
  });
});

test("shared budget execution atomically converts a hold into spending and retains receipt bindings", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, budget, setups, propose }) => {
    const intent = await propose(0, 250000), request = { requestFingerprint: intent.requestFingerprint };
    const result = await store.executeIntent(setups[0].credential.token, intent.intentId, request);
    assert.equal(result.result.status, "accepted");
    assert.deepEqual(await store.executeIntent(setups[0].credential.token, intent.intentId, request), result);
    const current = (await store.listSharedBudgets(owner))[0];
    assert.deepEqual([current.reservedBudgetMinor, current.spentBudgetMinor, current.availableBudgetMinor], [0, 250000, 750000]);
    assert.equal((await store.readAuthority(owner, setups[0].agent.agentId, intent.intentId)).receipt.policy.sharedBudgetId, budget.budgetId);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 2);
  });
});

test("shared budget reductions preserve commitments and stale revisions cannot overwrite owner changes", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, budget, propose }) => {
    await propose(0, 650000);
    await assert.rejects(store.changeSharedBudget(owner, budget.budgetId, "limit", { revision: 1, totalBudgetMinor: 649999 }), { code: "shared_budget_committed" });
    const changed = await store.changeSharedBudget(owner, budget.budgetId, "limit", { revision: 1, totalBudgetMinor: 700000 });
    assert.equal(changed.revision, 2); assert.equal(changed.availableBudgetMinor, 50000);
    await assert.rejects(store.changeSharedBudget(owner, budget.budgetId, "limit", { revision: 1, totalBudgetMinor: 900000 }), { code: "shared_budget_revision_changed" });
    await assert.rejects(propose(1, 50001), { code: "shared_budget_exceeded" });
  });
});

test("member withdrawal releases only its unspent holds and cannot be revived", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, budget, setups, propose }) => {
    const first = await propose(0, 100), second = await propose(1, 200);
    const action = { agentId: setups[0].agent.agentId };
    const removed = await store.changeSharedBudget(owner, budget.budgetId, "member_remove", action);
    assert.equal(removed.reservedBudgetMinor, 200);
    assert.equal((await store.listAgentIntents(setups[0].credential.token))[0].reason, "shared_budget_membership_revoked");
    assert.equal((await store.listAgentIntents(setups[1].credential.token))[0].status, "approved");
    await assert.rejects(propose(0), { code: "shared_budget_inactive" });
    await assert.rejects(store.changeSharedBudget(owner, budget.budgetId, "member_add", action), { code: "shared_budget_member_exists" });
    await store.changeSharedBudget(owner, budget.budgetId, "member_remove", action);
    assert.equal((await store.listSharedBudgets(owner))[0].reservedBudgetMinor, 200);
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents WHERE intent_id=ANY($1::uuid[])", [[first.intentId, second.intentId]])).rowCount, 2);
  });
});

test("budget revocation retains posted spending and releases pending holds exactly once", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, setups, budget, propose }) => {
    const first = await propose(0, 100), second = await propose(1, 200);
    const request = { requestFingerprint: first.requestFingerprint };
    const original = await store.executeIntent(setups[0].credential.token, first.intentId, request);
    const revoked = await store.changeSharedBudget(owner, budget.budgetId, "revoke", {});
    assert.deepEqual([revoked.status, revoked.reservedBudgetMinor, revoked.spentBudgetMinor], ["revoked", 0, 100]);
    assert.deepEqual(await store.executeIntent(setups[0].credential.token, first.intentId, request), original);
    assert.equal((await store.changeSharedBudget(owner, budget.budgetId, "revoke", {})).reservedBudgetMinor, 0);
    await assert.rejects(store.executeIntent(setups[1].credential.token, second.intentId, { requestFingerprint: second.requestFingerprint }), { code: "intent_not_approved" });
    await assert.rejects(propose(2), { code: "shared_budget_inactive" });
  });
});

test("shared budget membership and currency checks isolate owners and agents", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, setups, budget }) => {
    const foreign = await store.createAgent(other, { name: "Foreign" });
    await assert.rejects(store.createMandate(other, foreign.agentId, { ...policy, sharedBudgetId: budget.budgetId }), { code: "shared_budget_not_found" });
    await assert.rejects(store.changeSharedBudget(other, budget.budgetId, "revoke", {}), { code: "shared_budget_not_found" });
    await assert.rejects(store.changeSharedBudget(owner, budget.budgetId, "member_add", { agentId: foreign.agentId }), { code: "agent_not_found" });
    assert.deepEqual(await store.listSharedBudgets(other), []);
    await assert.rejects(store.createMandate(owner, setups[0].agent.agentId, { ...policy, currency: "USD", sharedBudgetId: budget.budgetId }), { code: "shared_budget_currency_denied" });
  });
});

test("owners can explicitly admit a new agent without widening its narrower mandate", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, budget }) => {
    const agent = await store.createAgent(owner, { name: "New member" });
    await assert.rejects(store.createMandate(owner, agent.agentId, { ...policy, sharedBudgetId: budget.budgetId }), { code: "shared_budget_not_found" });
    await store.changeSharedBudget(owner, budget.budgetId, "member_add", { agentId: agent.agentId });
    const mandate = await store.createMandate(owner, agent.agentId, { ...policy, perPaymentLimitMinor: 50, sharedBudgetId: budget.budgetId });
    const credential = await store.issueCredential(owner, agent.agentId, { scope: "payments:execute" });
    await assert.rejects(store.createIntent(credential.token, { mandateId: mandate.mandateId, clientRequestId: randomUUID(),
      receiverWalletId: receiver, amountMinor: 51, currency: "INR" }), { code: "mandate_policy_denied" });
    assert.equal((await store.listSharedBudgets(owner))[0].reservedBudgetMinor, 0);
  });
});

test("failed intent audit rolls back both shared and mandate reservations", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, setups, propose }) => {
    await pool.query(`CREATE FUNCTION reject_shared_proposal() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='agent.intent_created' THEN RAISE EXCEPTION 'injected_shared_audit_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_shared_proposal BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_shared_proposal()`);
    await assert.rejects(propose(0, 100), /injected_shared_audit_failure/);
    assert.equal((await store.listSharedBudgets(owner))[0].reservedBudgetMinor, 0);
    assert.equal((await store.listMandates(owner, setups[0].agent.agentId))[0].reservedBudgetMinor, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents")).rowCount, 0);
    await pool.query("DROP TRIGGER reject_shared_proposal ON outbox");
    assert.equal((await propose(0, 100)).amountMinor, 100);
  });
});

test("SQL guards independently reject shared counter tampering, budget detachment and fake control history", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, budget, setups, propose }) => {
    const intent = await propose(0, 100);
    await assert.rejects(pool.query("UPDATE rail_shared_budgets SET reserved_budget_minor=0 WHERE budget_id=$1", [budget.budgetId]), /shared_budget_accounting_mismatch/);
    await assert.rejects(pool.query("UPDATE rail_agent_mandates SET shared_budget_id=NULL WHERE mandate_id=$1", [setups[0].mandate.mandateId]), /shared_budget_binding_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_agent_intents SET shared_budget_id=NULL WHERE intent_id=$1", [intent.intentId]), /shared_budget_binding_is_immutable/);
    await assert.rejects(pool.query("UPDATE rail_shared_budgets SET total_budget_minor=900000 WHERE budget_id=$1", [budget.budgetId]), /shared_budget_revision_invalid/);
    await assert.rejects(pool.query("DELETE FROM rail_shared_budget_controls WHERE budget_id=$1", [budget.budgetId]), /shared_budget_history_is_immutable/);
    await runMigrations(pool);
    assert.equal((await pool.query("SELECT reserved_budget_minor FROM rail_shared_budgets WHERE budget_id=$1", [budget.budgetId])).rows[0].reserved_budget_minor, "100");
  });
});

test("shared budget final-commit failure restores money, evidence, intent and both allowances", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, budget, setups, propose }) => {
    const intent = await propose(0, 100), request = { requestFingerprint: intent.requestFingerprint };
    await pool.query(`CREATE FUNCTION reject_shared_execution() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='executed' THEN RAISE EXCEPTION 'injected_shared_commit_failure'; END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER reject_shared_execution AFTER UPDATE ON rail_agent_intents
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_shared_execution()`);
    await assert.rejects(store.executeIntent(setups[0].credential.token, intent.intentId, request), /injected_shared_commit_failure/);
    assert.equal((await pool.query("SELECT * FROM ledger_entries")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_payment_executions")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM rail_agent_authority_evidence")).rowCount, 0);
    const current = (await store.listSharedBudgets(owner))[0];
    assert.deepEqual([current.reservedBudgetMinor, current.spentBudgetMinor], [100, 0]);
    const wallets = (await pool.query("SELECT balance,reserved FROM wallets WHERE wallet_id=$1", [owner])).rows[0];
    assert.deepEqual([wallets.balance, wallets.reserved], ["2000000", "0"]);
    assert.equal((await pool.query("SELECT status FROM rail_agent_intents WHERE intent_id=$1", [intent.intentId])).rows[0].status, "approved");
    await pool.query("DROP TRIGGER reject_shared_execution ON rail_agent_intents");
    await store.executeIntent(setups[0].credential.token, intent.intentId, request);
    assert.equal((await store.listSharedBudgets(owner)).find(row => row.budgetId === budget.budgetId).spentBudgetMinor, 100);
  });
});

test("approval-required shared intents hold budget before approval and rejection releases it once", { skip: !databaseUrl }, async () => {
  await fixture(async ({ store, budget, setups }) => {
    const agentId = setups[0].agent.agentId;
    const mandate = await store.createMandate(owner, agentId, { ...policy, mode: "approval_required", sharedBudgetId: budget.budgetId });
    const intent = await store.createIntent(setups[0].credential.token, { mandateId: mandate.mandateId,
      clientRequestId: randomUUID(), receiverWalletId: receiver, amountMinor: 100, currency: "INR" });
    assert.equal(intent.status, "pending");
    assert.equal((await store.listSharedBudgets(owner))[0].reservedBudgetMinor, 100);
    await assert.rejects(store.executeIntent(setups[0].credential.token, intent.intentId, { requestFingerprint: intent.requestFingerprint }), { code: "intent_not_approved" });
    for (let i = 0; i < 2; i++) await store.decideIntent(owner, agentId, intent.intentId, { decision: "reject", requestFingerprint: intent.requestFingerprint });
    assert.equal((await store.listSharedBudgets(owner))[0].reservedBudgetMinor, 0);
  });
});

test("shared budget expiry clips intents and relevant reads transactionally release expired allowances", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, setups }) => {
    // Seed a short remaining lifetime at creation; never rewrite immutable history to advance a clock.
    const budgetId = randomUUID(), controlId = randomUUID(), agentId = setups[0].agent.agentId;
    const terms = { name: "Expiring policy", currency: "INR", totalBudgetMinor: 1000, ttlSeconds: 60, agentIds: [agentId] };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO rail_shared_budget_controls(control_id,budget_id,owner_wallet_id,action,canonical_payload,operation_fingerprint,recorded_at)
        VALUES($1,$2,$3,'create',$4,$5,clock_timestamp()-interval '57 seconds')`,
      [controlId, budgetId, owner, sharedBudgetOperationPayload("create", null, terms), sharedBudgetOperationFingerprint("create", null, terms)]);
      await client.query(`WITH instant AS(SELECT clock_timestamp()-interval '57 seconds' AS created)
        INSERT INTO rail_shared_budgets(budget_id,owner_wallet_id,name,currency,total_budget_minor,created_at,expires_at,created_control_id,current_control_id)
        SELECT $1,$2,'Expiring policy','INR',1000,created,created+interval '60 seconds',$3,$3 FROM instant`, [budgetId, owner, controlId]);
      await client.query("INSERT INTO rail_shared_budget_members(budget_id,agent_id,owner_wallet_id,created_control_id) VALUES($1,$2,$3,$4)", [budgetId, agentId, owner, controlId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const mandate = await store.createMandate(owner, agentId, { ...policy, sharedBudgetId: budgetId });
    const intent = await store.createIntent(setups[0].credential.token, { mandateId: mandate.mandateId, clientRequestId: randomUUID(),
      receiverWalletId: receiver, amountMinor: 100, currency: "INR" });
    const deadline = (await pool.query("SELECT expires_at FROM rail_shared_budgets WHERE budget_id=$1", [budgetId])).rows[0].expires_at;
    assert.equal(intent.expiresAt, deadline.toISOString());
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 100));
    const current = (await store.listSharedBudgets(owner)).find(row => row.budgetId === budgetId);
    assert.deepEqual([current.status, current.reservedBudgetMinor, current.spentBudgetMinor], ["expired", 0, 0]);
    assert.equal((await store.listAgentIntents(setups[0].credential.token)).find(row => row.intentId === intent.intentId).status, "expired");
  });
});

test("concurrent shared budget withdrawal and proposal leave neither overspending nor stranded holds", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, store, budget, setups, propose }) => {
    const results = await Promise.allSettled([propose(0, 100), store.changeSharedBudget(owner, budget.budgetId, "member_remove", { agentId: setups[0].agent.agentId })]);
    assert.equal(results[1].status, "fulfilled");
    if (results[0].status === "rejected") assert.equal(results[0].reason.code, "shared_budget_inactive");
    const current = (await store.listSharedBudgets(owner))[0];
    assert.deepEqual([current.reservedBudgetMinor, current.spentBudgetMinor], [0, 0]);
    assert.equal((await pool.query("SELECT * FROM rail_agent_intents WHERE status IN ('pending','approved')")).rowCount, 0);
  });
});
