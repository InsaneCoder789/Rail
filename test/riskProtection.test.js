import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { protectRiskRecord, decryptRiskRecord, loadRiskKeyRing } from "../dist/persistence/riskProtection.js";
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";

function key(keyId = "risk_unit_v1") { return { keyId, encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) }; }
const binding = { txId: "risk_crypto_test_001", requestFingerprint: "a".repeat(64) };
const record = { observedAt: "2026-10-12T00:00:00.000Z", features: { privateFeature: "not_public" },
  assessment: { mode: "shadow", reasons: ["sample_reason"] }, modelStatus: "not_configured", modelVersion: null,
  modelHash: null, synthetic: null, prediction: null };

test("risk protection round-trips private records with fresh nonces and purpose-bound authenticated metadata", () => {
  const keys = key(), first = protectRiskRecord(record, binding, keys), second = protectRiskRecord(record, binding, keys);
  assert.deepEqual(decryptRiskRecord(first, binding, keys), record);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.purpose, "risk-v1");
  assert.ok(!JSON.stringify(first).includes("not_public"));
});

test("risk protection rejects changed bindings, metadata, envelope fields and wrong keys without echoing plaintext", () => {
  const keys = key(), envelope = protectRiskRecord(record, binding, keys);
  for (const field of ["nonce", "ciphertext", "tag", "mac", "payloadHash", "keyId", "purpose"]) {
    assert.throws(() => decryptRiskRecord({ ...envelope, [field]: "tampered" }, binding, keys),
      { message: "protected_risk_verification_failed" });
  }
  assert.throws(() => decryptRiskRecord(envelope, { ...binding, txId: "different_test_001" }, keys));
  assert.throws(() => decryptRiskRecord(envelope, { ...binding, requestFingerprint: "b".repeat(64) }, keys));
  assert.throws(() => decryptRiskRecord(envelope, binding, key()));
});

test("risk GCM authentication still rejects a modified tag with a recomputed HMAC", () => {
  const keys = key(), envelope = protectRiskRecord(record, binding, keys);
  const changed = { ...envelope, tag: randomBytes(16).toString("base64") };
  changed.mac = createHmac("sha256", keys.authenticationKey).update(JSON.stringify([changed.version, changed.purpose, changed.keyId,
    changed.txId, changed.requestFingerprint, changed.payloadHash, changed.nonce, changed.ciphertext, changed.tag])).digest("base64");
  assert.throws(() => decryptRiskRecord(changed, binding, keys), { message: "protected_risk_verification_failed" });
});

test("risk key configuration requires independent current and retained material and rejects oversized records", () => {
  const payment = key("payment_old"), current = key("payment_current");
  const paymentRing = new TransactionKeyRing(current.keyId, [payment, current]);
  const raw = value => JSON.stringify({ activeKeyId: value.keyId, keys: [{ ...value,
    encryptionKey: Buffer.from(value.encryptionKey).toString("base64"), authenticationKey: Buffer.from(value.authenticationKey).toString("base64") }] });
  const separate = key();
  assert.equal(loadRiskKeyRing(raw(separate), paymentRing).activeKeyId, separate.keyId);
  assert.throws(() => loadRiskKeyRing(undefined, paymentRing), { message: "RISK_RECORD_KEY_RING_REQUIRED" });
  assert.throws(() => loadRiskKeyRing("private_invalid_config", paymentRing), { message: "INVALID_RISK_RECORD_KEY_RING" });
  assert.throws(() => loadRiskKeyRing(raw(payment), paymentRing), { message: "RISK_KEYS_MUST_BE_INDEPENDENT" });
  assert.throws(() => loadRiskKeyRing(raw({ ...separate, authenticationKey: current.encryptionKey }), paymentRing),
    { message: "RISK_KEYS_MUST_BE_INDEPENDENT" });
  assert.throws(() => protectRiskRecord({ ...record, features: "x".repeat(65537) }, binding, separate), /risk_record_size_limit/);
});
