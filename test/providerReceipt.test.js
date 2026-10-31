import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createProviderPayment, advanceProviderPayment, providerPaymentConsentFingerprint } from "../dist/domain/providerPayment.js";
import { createProviderOutcomeReceipt, providerOutcomeReceiptBinding } from "../dist/domain/providerReceipt.js";
import { protectRecord, decryptRecord } from "../dist/persistence/riskProtection.js";
import { dispatchProviderBatch } from "../dist/persistence/providerWorker.js";

const now = Date.parse("2026-11-01T12:00:00.000Z");
function fixture(status = "succeeded") {
  const binding = { version: 1, operationId: randomUUID(), ownerWalletId: "owner_fixture", agentId: randomUUID(),
    intentId: randomUUID(), mandateId: randomUUID(), sharedBudgetId: randomUUID(), provider: "simulator",
    providerAccountRef: "private_account", merchantRef: "private_merchant", instrumentRef: "private_instrument",
    amountMinor: 123, currency: "INR", requestFingerprint: "a".repeat(64), authorizationExpiresAt: new Date(now + 60000).toISOString() };
  const reserved = createProviderPayment(binding, now);
  const submitting = advanceProviderPayment(reserved, { type: "begin_submission", idempotencyWindowMs: 60000 }, now + 1);
  const payment = advanceProviderPayment(submitting, { type: "provider_observed", observation: {
    operationId: binding.operationId, fingerprint: reserved.fingerprint, provider: "simulator", providerAccountRef: binding.providerAccountRef,
    providerRef: "sim_fixture", amountMinor: 123, currency: "INR", status, final: true } }, now + 2);
  return { reserved, submitting, payment: { ...payment, revision: 3 }, consent: { merchantWalletId: "merchant_wallet",
    consentFingerprint: providerPaymentConsentFingerprint(binding, "merchant_wallet"), challengeId: randomUUID() } };
}

test("outcome receipts label simulator assurance and do not expose funding references", () => {
  const { payment, consent } = fixture();
  const receipt = createProviderOutcomeReceipt(payment, consent);
  assert.equal(receipt.assurance, "local_simulator_outcome");
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.allowanceDisposition, "spent");
  assert.equal(receipt.paymentFingerprint, payment.fingerprint);
  assert.equal(receipt.consentFingerprint, consent.consentFingerprint);
  assert.equal(receipt.consentChallengeId, consent.challengeId);
  assert.equal(receipt.outcomeRecordedAt, new Date(now + 2).toISOString());
  assert.ok(Object.isFrozen(receipt));
  assert.ok(!JSON.stringify(receipt).includes("private_"));
});

test("confirmed simulator failure and cancellation release allowance without claiming success", () => {
  for (const status of ["failed", "cancelled"]) {
    const { payment, consent } = fixture(status);
    const receipt = createProviderOutcomeReceipt(payment, consent);
    assert.equal(receipt.status, status);
    assert.equal(receipt.allowanceDisposition, "released");
  }
});

test("definitely unsubmitted cancellation has no invented provider reference or submission time", () => {
  const { reserved, consent } = fixture();
  const payment = { ...advanceProviderPayment(reserved, { type: "cancel_before_submission" }, now + 1), revision: 2 };
  const receipt = createProviderOutcomeReceipt(payment, consent);
  assert.equal(receipt.providerRef, null);
  assert.equal(receipt.submissionStartedAt, null);
  assert.equal(receipt.status, "cancelled");
});

test("reserved, submitting and uncertain states cannot produce final outcome receipts", () => {
  const { reserved, submitting, consent } = fixture();
  const unknown = advanceProviderPayment(submitting, { type: "submission_uncertain" }, now + 2);
  for (const payment of [reserved, submitting, unknown, { ...submitting, status: "processing" }, { ...submitting, status: "requires_owner_action" }])
    assert.throws(() => createProviderOutcomeReceipt({ ...payment, revision: 3 }, consent));
});

test("receipts reject substituted payment, consent and challenge bindings", () => {
  const { payment, consent } = fixture();
  for (const changed of [{ fingerprint: "b".repeat(64) }, { idempotencyKey: "different_key" },
    { binding: { ...payment.binding, amountMinor: 124 } }, { binding: { ...payment.binding, ownerWalletId: "different_owner" } },
    { binding: { ...payment.binding, provider: "stripe" } }])
    assert.throws(() => createProviderOutcomeReceipt({ ...payment, ...changed }, consent));
  for (const changed of [{ consentFingerprint: "b".repeat(64) }, { merchantWalletId: "another_merchant" }, { challengeId: "not_a_challenge" }])
    assert.throws(() => createProviderOutcomeReceipt(payment, { ...consent, ...changed }));
});

test("receipts reject invalid journal revisions, timestamps and impossible terminal states", () => {
  const { payment, consent } = fixture();
  for (const changed of [{ revision: 0 }, { revision: 1.5 }, { updatedAtMs: NaN }, { updatedAtMs: -1 },
    { firstSubmissionAtMs: now + 3 }, { firstSubmissionAtMs: null }, { providerRef: null }, { providerRef: "bad ref" }])
    assert.throws(() => createProviderOutcomeReceipt({ ...payment, ...changed }, consent));
});

test("outcome envelope rejects ciphertext tampering and cross-purpose substitution", () => {
  const { payment, consent } = fixture(), receipt = createProviderOutcomeReceipt(payment, consent);
  const key = { keyId: "receipt_test", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
  const binding = providerOutcomeReceiptBinding(receipt.operationId, receipt.paymentFingerprint);
  const envelope = protectRecord(receipt, binding, key, "provider-outcome-v1");
  assert.deepEqual(decryptRecord(envelope, binding, key, "provider-outcome-v1"), receipt);
  for (const field of ["version", "purpose", "keyId", "txId", "requestFingerprint", "payloadHash", "nonce", "ciphertext", "tag", "mac"])
    assert.throws(() => decryptRecord({ ...envelope, [field]: "tampered" }, binding, key, "provider-outcome-v1"));
  for (const purpose of ["risk-v1", "agent-authority-v1", "agent-mandate-v1", "agent-approval-v1", "agent-rejection-v1"])
    assert.throws(() => decryptRecord(envelope, binding, key, purpose));
  assert.throws(() => decryptRecord(envelope, providerOutcomeReceiptBinding(randomUUID(), receipt.paymentFingerprint), key, "provider-outcome-v1"));
  assert.throws(() => decryptRecord(envelope, providerOutcomeReceiptBinding(receipt.operationId, "b".repeat(64)), key, "provider-outcome-v1"));
  assert.throws(() => decryptRecord(envelope, binding, { ...key, authenticationKey: randomBytes(32) }, "provider-outcome-v1"));
});

test("outcome bindings are deterministic, domain-separated and strictly validated", () => {
  const id = randomUUID(), hash = "a".repeat(64);
  assert.deepEqual(providerOutcomeReceiptBinding(id, hash), providerOutcomeReceiptBinding(id, hash));
  assert.notEqual(providerOutcomeReceiptBinding(id, hash).requestFingerprint, hash);
  for (const [operationId, fingerprint] of [["bad", hash], [id, "bad"], [id, "A".repeat(64)]])
    assert.throws(() => providerOutcomeReceiptBinding(operationId, fingerprint));
});

test("worker configuration without evidence fails before database admission or effects", async () => {
  const forbidden = () => { assert.fail("unconfigured worker must not perform I/O"); };
  await assert.rejects(dispatchProviderBatch({ query: forbidden }, {}, { submit: forbidden, lookup: forbidden }),
    { message: "PROVIDER_OUTCOME_EVIDENCE_REQUIRED" });
});
