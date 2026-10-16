import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { advanceProviderPayment, createProviderPayment, parseProviderPaymentBinding,
  providerBudgetDisposition, providerPaymentFingerprint } from "../dist/domain/providerPayment.js";

const now = Date.parse("2026-10-15T12:00:00.000Z");
function binding() {
  return { version: 1, operationId: randomUUID(), ownerWalletId: "owner_fixture", agentId: randomUUID(), intentId: randomUUID(),
    mandateId: randomUUID(), sharedBudgetId: randomUUID(), provider: "test_provider", providerAccountRef: "account_fixture",
    merchantRef: "merchant_fixture", instrumentRef: "instrument_fixture", amountMinor: 100, currency: "INR",
    requestFingerprint: "a".repeat(64), authorizationExpiresAt: new Date(now + 60000).toISOString() };
}
function submitting() {
  return advanceProviderPayment(createProviderPayment(binding(), now), { type: "begin_submission", idempotencyWindowMs: 86400000 }, now + 1);
}
function observation(payment, status, changes = {}) {
  return { operationId: payment.binding.operationId, fingerprint: payment.fingerprint, provider: payment.binding.provider,
    providerAccountRef: payment.binding.providerAccountRef, providerRef: "payment_fixture", amountMinor: payment.binding.amountMinor,
    currency: payment.binding.currency, status, final: ["succeeded", "failed", "cancelled"].includes(status), ...changes };
}

test("provider payment binding snapshots exact owner, instrument, merchant and financial terms", () => {
  const input = binding(), value = parseProviderPaymentBinding(input), fingerprint = providerPaymentFingerprint(value);
  input.amountMinor = 200;
  assert.equal(value.amountMinor, 100); assert.equal(Object.isFrozen(value), true);
  assert.equal(providerPaymentFingerprint(Object.fromEntries(Object.entries(value).reverse())), fingerprint);
  for (const [field, changed] of [["ownerWalletId", "other_owner"], ["agentId", randomUUID()], ["intentId", randomUUID()],
    ["mandateId", randomUUID()], ["sharedBudgetId", randomUUID()], ["merchantRef", "other_merchant"], ["instrumentRef", "other_instrument"],
    ["providerAccountRef", "other_account"], ["provider", "other_provider"], ["amountMinor", 101], ["currency", "USD"],
    ["requestFingerprint", "b".repeat(64)], ["authorizationExpiresAt", new Date(now + 70000).toISOString()]])
    assert.notEqual(providerPaymentFingerprint({ ...value, [field]: changed }), fingerprint);
});

test("provider binding rejects raw card fields, malformed identities, unsafe amounts and implicit dates", () => {
  for (const changes of [{ cardNumber: "never_accept_raw_card_data" }, { version: 2 }, { agentId: "other_agent" },
    { amountMinor: 0 }, { amountMinor: 1.1 }, { amountMinor: Number.MAX_SAFE_INTEGER }, { currency: "inr" },
    { requestFingerprint: "not_a_hash" }, { authorizationExpiresAt: "tomorrow" }, { authorizationExpiresAt: "2026-10-15" }])
    assert.throws(() => parseProviderPaymentBinding({ ...binding(), ...changes }), /INVALID_PROVIDER_PAYMENT_BINDING/);
  assert.throws(() => createProviderPayment({ ...binding(), authorizationExpiresAt: new Date(now).toISOString() }, now), /PROVIDER_AUTHORIZATION_EXPIRED/);
});

test("uncertain submission retains allowance and safe retries retain the original key, binding and window", () => {
  const initial = submitting(), unknown = advanceProviderPayment(initial, { type: "submission_uncertain" }, now + 2);
  assert.equal(providerBudgetDisposition(unknown.status), "held");
  const retry = advanceProviderPayment(unknown, { type: "retry_submission" }, now + 3);
  assert.equal(retry.idempotencyKey, initial.idempotencyKey); assert.equal(retry.fingerprint, initial.fingerprint);
  assert.equal(retry.firstSubmissionAtMs, initial.firstSubmissionAtMs); assert.equal(retry.retryWindowEndsAtMs, initial.retryWindowEndsAtMs);
  assert.equal(retry.binding, initial.binding);
  assert.throws(() => advanceProviderPayment(retry, { type: "begin_submission", idempotencyWindowMs: 86400000 }, now + 4), /INVALID_PROVIDER_TRANSITION/);
});

test("expired retry windows prohibit submission but still allow authoritative financial reconciliation", () => {
  const initial = submitting(), unknown = advanceProviderPayment(initial, { type: "submission_uncertain" }, now + 2);
  assert.throws(() => advanceProviderPayment(unknown, { type: "retry_submission" }, initial.retryWindowEndsAtMs), /PROVIDER_RETRY_NOT_PERMITTED/);
  assert.equal(providerBudgetDisposition(unknown.status), "held");
  const reconciled = advanceProviderPayment(unknown, { type: "provider_observed", observation: observation(unknown, "succeeded") }, initial.retryWindowEndsAtMs + 1);
  assert.equal(providerBudgetDisposition(reconciled.status), "spent");
});

test("expired owner authority prevents first submission and retries, not reconciliation of existing liability", () => {
  const reserved = createProviderPayment(binding(), now);
  assert.throws(() => advanceProviderPayment(reserved, { type: "begin_submission", idempotencyWindowMs: 86400000 }, now + 60000), /PROVIDER_AUTHORIZATION_EXPIRED/);
  const unknown = advanceProviderPayment(submitting(), { type: "submission_uncertain" }, now + 2);
  assert.throws(() => advanceProviderPayment(unknown, { type: "retry_submission" }, now + 60000), /PROVIDER_AUTHORIZATION_EXPIRED/);
  assert.equal(advanceProviderPayment(unknown, { type: "provider_observed", observation: observation(unknown, "succeeded") }, now + 60001).status, "succeeded");
});

test("cancellation releases only definitely unsubmitted work or an authoritative terminal provider outcome", () => {
  const reserved = createProviderPayment(binding(), now), cancelled = advanceProviderPayment(reserved, { type: "cancel_before_submission" }, now + 1);
  assert.equal(providerBudgetDisposition(cancelled.status), "released");
  assert.equal(advanceProviderPayment(cancelled, { type: "cancel_before_submission" }, now + 2), cancelled);
  const pending = submitting();
  assert.throws(() => advanceProviderPayment(pending, { type: "cancel_before_submission" }, now + 2), /PROVIDER_CANCELLATION_REQUIRES_CONFIRMATION/);
  const confirmed = advanceProviderPayment(pending, { type: "provider_observed", observation: observation(pending, "cancelled") }, now + 3);
  assert.equal(providerBudgetDisposition(confirmed.status), "released");
});

test("processing and required owner actions remain held; a recoverable decline is not final failure", () => {
  for (const status of ["processing", "requires_owner_action"]) {
    const pending = submitting(), updated = advanceProviderPayment(pending, { type: "provider_observed", observation: observation(pending, status) }, now + 2);
    assert.equal(providerBudgetDisposition(updated.status), "held");
  }
  const pending = submitting();
  assert.throws(() => advanceProviderPayment(pending, { type: "provider_observed", observation: observation(pending, "failed", { final: false }) }, now + 2), /INVALID_PROVIDER_OBSERVATION/);
  assert.equal(providerBudgetDisposition("failed"), "released");
});

test("observations cannot substitute provider accounts, operation IDs, fingerprints, money or provider objects", () => {
  const pending = submitting();
  for (const changes of [{ operationId: randomUUID() }, { fingerprint: "f".repeat(64) }, { provider: "other_provider" },
    { providerAccountRef: "other_account" }, { amountMinor: 101 }, { currency: "USD" }, { providerRef: "" }])
    assert.throws(() => advanceProviderPayment(pending, { type: "provider_observed", observation: observation(pending, "succeeded", changes) }, now + 2), /PROVIDER_OBSERVATION_MISMATCH/);
  const processing = advanceProviderPayment(pending, { type: "provider_observed", observation: observation(pending, "processing") }, now + 2);
  assert.throws(() => advanceProviderPayment(processing, { type: "provider_observed", observation: observation(processing, "succeeded", { providerRef: "different_payment" }) }, now + 3), /PROVIDER_OBSERVATION_MISMATCH/);
});

test("duplicate and late pending observations cannot overwrite success; contradictory terminal outcomes require investigation", () => {
  const pending = submitting(), succeeded = advanceProviderPayment(pending, { type: "provider_observed", observation: observation(pending, "succeeded") }, now + 2);
  for (const status of ["succeeded", "processing", "requires_owner_action"])
    assert.equal(advanceProviderPayment(succeeded, { type: "provider_observed", observation: observation(succeeded, status) }, now + 3), succeeded);
  assert.throws(() => advanceProviderPayment(succeeded, { type: "provider_observed", observation: observation(succeeded, "failed") }, now + 3), /CONFLICTING_PROVIDER_OUTCOME/);
});

test("unsolicited observations, invalid clocks, unknown events and unbounded retry windows fail closed", () => {
  const reserved = createProviderPayment(binding(), now);
  assert.throws(() => advanceProviderPayment(reserved, { type: "provider_observed", observation: observation(reserved, "succeeded") }, now + 1), /PROVIDER_OBSERVATION_BEFORE_SUBMISSION/);
  for (const idempotencyWindowMs of [0, -1, 1.5, Infinity, 31 * 86400000])
    assert.throws(() => advanceProviderPayment(reserved, { type: "begin_submission", idempotencyWindowMs }, now + 1), /INVALID_PROVIDER_RETRY_WINDOW/);
  for (const value of [now - 1, NaN, Infinity]) assert.throws(() => advanceProviderPayment(reserved, { type: "cancel_before_submission" }, value), /INVALID_PROVIDER_EVENT_TIME/);
  assert.throws(() => advanceProviderPayment(reserved, { type: "agent_selected_priority" }, now + 1), /INVALID_PROVIDER_TRANSITION/);
  assert.throws(() => providerBudgetDisposition("timeout_means_failure"), /INVALID_PROVIDER_STATUS/);
});
