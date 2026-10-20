import test from "node:test";
import assert from "node:assert/strict";
import { ProviderTargetRegistry, parseProviderTarget, providerTargetFingerprint } from "../dist/domain/providerTargets.js";
import { parseProviderProposalRequest } from "../dist/persistence/providerPayments.js";

const target = () => ({ version: 1, targetId: "fixture_trip", revision: 1, ownerWalletId: "owner_fixture", provider: "simulator",
  providerAccountRef: "account_fixture", instrumentRef: "instrument_fixture", merchantWalletId: "merchant_fixture",
  merchantRef: "merchant_provider_fixture", currency: "INR", status: "active" });

test("provider targets snapshot exact operator mappings and enforce owner, currency and status", () => {
  const value = target(), registry = new ProviderTargetRegistry(JSON.stringify([value]));
  const snapshot = registry.resolve(value.targetId, value.ownerWalletId, "INR");
  value.instrumentRef = "mutated_reference";
  assert.equal(snapshot.instrumentRef, "instrument_fixture"); assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(providerTargetFingerprint(Object.fromEntries(Object.entries(snapshot).reverse())), providerTargetFingerprint(snapshot));
  for (const [owner, currency] of [["other_owner", "INR"], [snapshot.ownerWalletId, "USD"]])
    assert.throws(() => registry.resolve(snapshot.targetId, owner, currency), { code: "provider_target_denied" });
  assert.throws(() => new ProviderTargetRegistry().resolve("fixture_trip", "owner_fixture", "INR"), { code: "provider_targets_unavailable" });
  assert.throws(() => new ProviderTargetRegistry(JSON.stringify([{ ...target(), status: "revoked" }])).requireCurrent(snapshot), { code: "provider_target_denied" });
});

test("target reconfiguration cannot substitute account, instrument, merchant or revision in a frozen proposal", () => {
  const snapshot = new ProviderTargetRegistry(JSON.stringify([target()])).resolve("fixture_trip", "owner_fixture", "INR");
  for (const changes of [{ revision: 2 }, { providerAccountRef: "other_account" }, { instrumentRef: "other_instrument" },
    { merchantWalletId: "other_merchant" }, { merchantRef: "other_reference" }, { provider: "other_provider" }])
    assert.throws(() => new ProviderTargetRegistry(JSON.stringify([{ ...target(), ...changes }])).requireCurrent(snapshot), { code: "provider_target_changed" });
});

test("target configuration rejects duplicate aliases, cross-owner instruments, conflicting merchant aliases and unknown fields", () => {
  const first = target();
  for (const values of [[first, first], [first, { ...first, targetId: "second_target", ownerWalletId: "foreign_owner" }],
    [first, { ...first, targetId: "second_target", merchantWalletId: "different_merchant" }],
    [{ ...first, cardNumber: "never_accept_raw_cards" }], [{ ...first, revision: 0 }], [{ ...first, status: "unknown" }],
    [{ ...first, providerAccountRef: "https://untrusted.example/" }], [{ ...first, currency: "inr" }], [{ ...first, version: 2 }]])
    assert.throws(() => new ProviderTargetRegistry(JSON.stringify(values)), /INVALID_PROVIDER_TARGETS_CONFIGURATION/);
  assert.throws(() => new ProviderTargetRegistry("not_json"), /INVALID_PROVIDER_TARGETS_CONFIGURATION/);
  assert.throws(() => new ProviderTargetRegistry(" ".repeat(65537)), /INVALID_PROVIDER_TARGETS_CONFIGURATION/);
  assert.throws(() => parseProviderTarget({ ...first }), /INVALID_PROVIDER_TARGET/);
});

test("agent provider proposals accept only bounded terms and a target alias, never operator references", () => {
  const input = { mandateId: "01234567-0123-4123-8123-012345678901", clientRequestId: "fixture_request", targetId: "fixture_trip", amountMinor: 100, currency: "INR" };
  assert.equal(parseProviderProposalRequest(input).ttlSeconds, 300);
  for (const changes of [{ ownerWalletId: "foreign_owner" }, { providerAccountRef: "chosen_by_agent" }, { instrumentRef: "chosen_by_agent" },
    { merchantRef: "chosen_by_agent" }, { targetRevision: 999 }, { sharedBudgetId: "chosen_by_agent" }, { amountMinor: 0 }, { amountMinor: 1.1 },
    { ttlSeconds: 901 }, { currency: "USD", targetId: "https://untrusted.example/" }, { mandateId: "-".repeat(36) }])
    assert.throws(() => parseProviderProposalRequest({ ...input, ...changes }), { code: "invalid_provider_proposal" });
});
