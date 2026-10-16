import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import dotenv from "dotenv";
import { runMigrations, ensureOutboxSchema } from "../dist/persistence/migrate.js";
import { AgentAuthorityStore } from "../dist/persistence/agentAuthority.js";
import { AgentEvidenceStore } from "../dist/persistence/agentEvidence.js";
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";
import { providerBudgetDisposition } from "../dist/domain/providerPayment.js";
import { createProviderPaymentInTransaction as create, advanceProviderPaymentInTransaction as advance,
  readProviderPaymentInTransaction as read } from "../dist/persistence/providerPayments.js";

dotenv.config({ quiet: true });
const databaseUrl = process.env.DATABASE_URL;
const options = { skip: !databaseUrl };

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function fixture(work) {
  const schema = `ci_provider_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const config = { connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` };
  const pool = new Pool(config);
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await runMigrations(pool); await ensureOutboxSchema(pool);
    await pool.query("INSERT INTO wallets(wallet_id,balance) VALUES('provider_owner',100000),('provider_receiver',0)");
    const key = { keyId: "provider_fixture", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
    const authority = new AgentAuthorityStore(pool, undefined, new AgentEvidenceStore(new TransactionKeyRing(key.keyId, [key])));
    const agent = await authority.createAgent("provider_owner", { name: "Provider journal fixture" });
    const budget = await authority.createSharedBudget("provider_owner", { name: "Fixture envelope", currency: "INR",
      totalBudgetMinor: 10000, agentIds: [agent.agentId] });
    const mandate = await authority.createMandate("provider_owner", agent.agentId, { mode: "budgeted", currency: "INR",
      perPaymentLimitMinor: 1000, totalBudgetMinor: 10000, allowedReceiverWalletIds: ["provider_receiver"], sharedBudgetId: budget.budgetId });
    const binding = () => ({ version: 1, operationId: randomUUID(), ownerWalletId: "provider_owner", agentId: agent.agentId,
      intentId: randomUUID(), mandateId: mandate.mandateId, sharedBudgetId: budget.budgetId, provider: "simulator",
      providerAccountRef: "account_fixture", merchantRef: "merchant_fixture", instrumentRef: "instrument_fixture",
      amountMinor: 100, currency: "INR", requestFingerprint: "a".repeat(64), authorizationExpiresAt: new Date(Date.now() + 60000).toISOString() });
    const identity = payment => ({ operationId: payment.binding.operationId, ownerWalletId: payment.binding.ownerWalletId, fingerprint: payment.fingerprint });
    const change = (payment, event) => transaction(pool, client => advance(client, identity(payment), event));
    const observe = (payment, status, changes = {}) => ({ type: "provider_observed", observation: {
      operationId: payment.binding.operationId, fingerprint: payment.fingerprint, provider: payment.binding.provider,
      providerAccountRef: payment.binding.providerAccountRef, providerRef: "payment_fixture", amountMinor: 100,
      currency: "INR", status, final: ["succeeded", "failed", "cancelled"].includes(status), ...changes } });
    await work({ pool, config, binding, identity, change, observe });
    assert.equal((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
    assert.deepEqual((await pool.query("SELECT reserved_budget_minor,spent_budget_minor FROM rail_shared_budgets")).rows,
      [{ reserved_budget_minor: "0", spent_budget_minor: "0" }]);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}

test("provider journal persists immutable bindings and exact replay across independent connections", options, async () => {
  await fixture(async ({ pool, config, binding }) => {
    const input = binding(), initial = await transaction(pool, client => create(client, input));
    const reader = new Pool({ ...config, max: 1 });
    try {
      assert.deepEqual(await transaction(reader, client => read(client, input.ownerWalletId, input.operationId)), initial);
      assert.deepEqual(await transaction(reader, client => create(client, input)), initial);
      const rows = (await pool.query("SELECT event_type,revision,attempt_number FROM rail_provider_payment_history")).rows;
      assert.deepEqual(rows, [{ event_type: "created", revision: 1, attempt_number: 0 }]);
      await runMigrations(pool);
      assert.deepEqual(await transaction(reader, client => read(client, input.ownerWalletId, input.operationId)), initial);
    } finally { await reader.end(); }
  });
});

test("provider writes reject autocommit before creating an operation or changing its history", options, async () => {
  await fixture(async ({ pool, binding, identity }) => {
    const client = await pool.connect(), input = binding();
    try {
      await assert.rejects(create(client, input), { code: "25P01" });
      const saved = await transaction(pool, writer => create(writer, input));
      await assert.rejects(advance(client, identity(saved), { type: "cancel_before_submission" }), { code: "25P01" });
      assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_history")).rows[0].count, "1");
    } finally { client.release(); }
  });
});

test("provider creation races journal once and reject changed bindings or a new operation for the same intent", options, async () => {
  await fixture(async ({ pool, binding }) => {
    const input = binding();
    const results = await Promise.all([1, 2, 3].map(() => transaction(pool, client => create(client, input))));
    assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
    for (const changes of [{ amountMinor: 101 }, { providerAccountRef: "other_account" }, { instrumentRef: "other_instrument" }])
      await assert.rejects(transaction(pool, client => create(client, { ...input, ...changes })), /PROVIDER_PAYMENT_BINDING_REUSED/);
    await assert.rejects(transaction(pool, client => create(client, { ...input, operationId: randomUUID() })), { code: "23505" });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_history")).rows[0].count, "1");
  });
});

test("provider journal snapshots caller terms and rejects foreign owner or mandate membership", options, async () => {
  await fixture(async ({ pool, binding, identity }) => {
    const input = binding(), original = structuredClone(input);
    await transaction(pool, async client => {
      const pending = create(client, input); input.amountMinor = 999;
      const saved = await pending; assert.equal(saved.binding.amountMinor, original.amountMinor);
    });
    await assert.rejects(transaction(pool, client => read(client, "foreign_owner", original.operationId)), /PROVIDER_PAYMENT_NOT_FOUND/);
    const saved = await transaction(pool, client => read(client, original.ownerWalletId, original.operationId));
    await assert.rejects(transaction(pool, client => advance(client, { ...identity(saved), ownerWalletId: "foreign_owner" }, { type: "cancel_before_submission" })), /PROVIDER_PAYMENT_NOT_FOUND/);
    await assert.rejects(transaction(pool, client => create(client, { ...binding(), sharedBudgetId: randomUUID() })), { code: "23503" });
  });
});

test("parallel submission claims record exactly one attempt before any external I/O", options, async () => {
  await fixture(async ({ pool, binding, change }) => {
    const saved = await transaction(pool, client => create(client, binding()));
    const event = { type: "begin_submission", idempotencyWindowMs: 60000 };
    const results = await Promise.allSettled([change(saved, event), change(saved, event)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.match(results.find(result => result.status === "rejected").reason.message, /INVALID_PROVIDER_TRANSITION/);
    const current = await transaction(pool, client => read(client, saved.binding.ownerWalletId, saved.binding.operationId));
    assert.equal(current.attemptNumber, 1); assert.equal(current.revision, 2);
    assert.equal(current.idempotencyKey, saved.idempotencyKey);
    assert.deepEqual((await pool.query("SELECT event_type FROM rail_provider_payment_history ORDER BY revision")).rows,
      [{ event_type: "created" }, { event_type: "begin_submission" }]);
  });
});

test("rollback removes operation and history together and also undoes a submission claim", options, async () => {
  await fixture(async ({ pool, binding, identity }) => {
    const input = binding();
    await assert.rejects(transaction(pool, async client => { await create(client, input); throw new Error("commit_failure_fixture"); }), /commit_failure_fixture/);
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_history")).rows[0].count, "0");
    const saved = await transaction(pool, client => create(client, input));
    await assert.rejects(transaction(pool, async client => {
      await advance(client, identity(saved), { type: "begin_submission", idempotencyWindowMs: 60000 });
      throw new Error("commit_failure_fixture");
    }), /commit_failure_fixture/);
    assert.deepEqual(await transaction(pool, client => read(client, input.ownerWalletId, input.operationId)), saved);
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_history")).rows[0].count, "1");
  });
});

test("lost reply recovery retains one provider key and the original nonextendable retry window", options, async () => {
  await fixture(async ({ pool, binding, change, observe }) => {
    const saved = await transaction(pool, client => create(client, binding()));
    const started = await change(saved, { type: "begin_submission", idempotencyWindowMs: 60000 });
    const unknown = await change(started, { type: "submission_uncertain" });
    assert.deepEqual(await change(unknown, { type: "submission_uncertain" }), unknown);
    assert.equal(providerBudgetDisposition(unknown.status), "held");
    const retry = await change(unknown, { type: "retry_submission" });
    assert.equal(retry.attemptNumber, 2); assert.equal(retry.idempotencyKey, started.idempotencyKey);
    assert.equal(retry.firstSubmissionAtMs, started.firstSubmissionAtMs);
    assert.equal(retry.retryWindowEndsAtMs, started.retryWindowEndsAtMs);
    const final = await change(retry, observe(retry, "succeeded"));
    assert.deepEqual(await change(final, observe(final, "processing")), final);
    assert.deepEqual(await change(final, observe(final, "succeeded")), final);
    await assert.rejects(change(final, observe(final, "failed")), /CONFLICTING_PROVIDER_OUTCOME/);
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_history")).rows[0].count, "5");
  });
});

test("expired provider windows prohibit resubmission but not financial reconciliation", options, async () => {
  await fixture(async ({ pool, binding, change, observe }) => {
    const saved = await transaction(pool, client => create(client, binding()));
    const started = await change(saved, { type: "begin_submission", idempotencyWindowMs: 1 });
    const unknown = await change(started, { type: "submission_uncertain" });
    await pool.query("SELECT pg_sleep(0.01)");
    await assert.rejects(change(unknown, { type: "retry_submission" }), /PROVIDER_RETRY_NOT_PERMITTED/);
    const confirmed = await change(unknown, observe(unknown, "succeeded"));
    assert.equal(confirmed.status, "succeeded"); assert.equal(confirmed.attemptNumber, 1);
  });
});

test("database mutation guards preserve payment terms, attempt windows and append-only journal", options, async () => {
  await fixture(async ({ pool, binding, change }) => {
    const saved = await transaction(pool, client => create(client, binding()));
    const started = await change(saved, { type: "begin_submission", idempotencyWindowMs: 60000 });
    for (const assignments of ["binding=jsonb_set(binding,'{amountMinor}','101')", "fingerprint=repeat('b',64)",
      "retry_window_ends_at_ms=retry_window_ends_at_ms+1", "revision=revision+2", "first_submission_at_ms=NULL,retry_window_ends_at_ms=NULL"]) {
      await assert.rejects(pool.query(`UPDATE rail_provider_payments SET ${assignments} WHERE operation_id=$1`, [saved.binding.operationId]), { code: "23514" });
    }
    await assert.rejects(pool.query("DELETE FROM rail_provider_payments"), { code: "23514" });
    await assert.rejects(pool.query("DELETE FROM rail_provider_payment_history"), { code: "23514" });
    await assert.rejects(pool.query("UPDATE rail_provider_payment_history SET status='failed'"), { code: "23514" });
    assert.deepEqual(await transaction(pool, client => read(client, saved.binding.ownerWalletId, saved.binding.operationId)), started);
  });
});

test("journal write failure rolls back lifecycle changes rather than losing attempt evidence", options, async () => {
  await fixture(async ({ pool, binding, change }) => {
    const saved = await transaction(pool, client => create(client, binding()));
    await pool.query(`CREATE FUNCTION reject_journal_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'journal_write_failure_fixture'; END $$;
      CREATE TRIGGER reject_journal_fixture BEFORE INSERT ON rail_provider_payment_history
        FOR EACH ROW EXECUTE FUNCTION reject_journal_fixture()`);
    await assert.rejects(change(saved, { type: "begin_submission", idempotencyWindowMs: 60000 }), /journal_write_failure_fixture/);
    assert.deepEqual(await transaction(pool, client => read(client, saved.binding.ownerWalletId, saved.binding.operationId)), saved);
  });
});

test("one provider object cannot confirm two operations under the same account", options, async () => {
  await fixture(async ({ pool, binding, change, observe }) => {
    const first = await transaction(pool, client => create(client, binding()));
    const second = await transaction(pool, client => create(client, binding()));
    const a = await change(first, { type: "begin_submission", idempotencyWindowMs: 60000 });
    const b = await change(second, { type: "begin_submission", idempotencyWindowMs: 60000 });
    await change(a, observe(a, "succeeded"));
    await assert.rejects(change(b, observe(b, "succeeded")), { code: "23505" });
    assert.deepEqual(await transaction(pool, client => read(client, b.binding.ownerWalletId, b.binding.operationId)), b);
    const confirmed = await change(b, observe(b, "succeeded", { providerRef: "different_payment_fixture" }));
    assert.equal(confirmed.status, "succeeded");
  });
});

test("a submission waiting for locks rechecks database time and expired creation replays its original journal", options, async () => {
  await fixture(async ({ pool, binding, change }) => {
    const input = { ...binding(), authorizationExpiresAt: new Date(Date.now() + 2000).toISOString() };
    const saved = await transaction(pool, client => create(client, input));
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT operation_id FROM rail_provider_payments WHERE operation_id=$1 FOR UPDATE", [input.operationId]);
      const pending = assert.rejects(change(saved, { type: "begin_submission", idempotencyWindowMs: 60000 }), /PROVIDER_AUTHORIZATION_EXPIRED/);
      await pool.query("SELECT pg_sleep(2.1)");
      await blocker.query("COMMIT"); await pending;
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    assert.deepEqual(await transaction(pool, client => create(client, input)), saved);
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payment_history")).rows[0].count, "1");
  });
});

test("observation snapshots cannot be mutated while awaiting the payment row lock", options, async () => {
  await fixture(async ({ pool, binding, change, observe, identity }) => {
    const saved = await transaction(pool, client => create(client, binding()));
    const started = await change(saved, { type: "begin_submission", idempotencyWindowMs: 60000 });
    const event = observe(started, "succeeded");
    await transaction(pool, async client => {
      const pending = advance(client, identity(started), event);
      event.observation.amountMinor = 999;
      const confirmed = await pending;
      assert.equal(confirmed.status, "succeeded"); assert.equal(confirmed.binding.amountMinor, 100);
    });
  });
});
