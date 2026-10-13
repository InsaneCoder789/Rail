import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadAgentAuthorityKeyRing } from "../dist/persistence/agentEvidence.js";
import { protectRecord, decryptRecord, decryptRiskRecord } from "../dist/persistence/riskProtection.js";
import { TransactionKeyRing } from "../dist/crypto/transactionProtection.js";

const key = { keyId: "authority_unit", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
const binding = { txId: "rail_agent:unit_test", requestFingerprint: "a".repeat(64) };
const value = { version: 1, assurance: "server_observed_authority", privatePolicy: "owner_only" };
const raw = keys => JSON.stringify({ activeKeyId: keys.keyId, keys: [{ keyId: keys.keyId,
  encryptionKey: keys.encryptionKey.toString("base64"), authenticationKey: keys.authenticationKey.toString("base64") }] });

test("authority envelopes preserve records without masquerading as risk records", () => {
  const envelope = protectRecord(value, binding, key, "agent-authority-v1");
  assert.deepEqual(decryptRecord(envelope, binding, key, "agent-authority-v1"), value);
  assert.ok(!JSON.stringify(envelope).includes("owner_only"));
  assert.throws(() => decryptRiskRecord(envelope, binding, key));
  const risk = protectRecord(value, binding, key);
  assert.throws(() => decryptRecord(risk, binding, key, "agent-authority-v1"));
  for (const invalid of [null, [], "client_text"]) assert.throws(() => protectRecord(invalid, binding, key, "agent-authority-v1"));
  assert.throws(() => protectRecord(value, binding, key, "untrusted-purpose"));
});

test("authority verification rejects substitution and every protected envelope mutation", () => {
  const envelope = protectRecord(value, binding, key, "agent-authority-v1");
  for (const field of ["version", "purpose", "keyId", "txId", "requestFingerprint", "payloadHash", "nonce", "ciphertext", "tag", "mac"])
    assert.throws(() => decryptRecord({ ...envelope, [field]: "modified" }, binding, key, "agent-authority-v1"));
  assert.throws(() => decryptRecord(envelope, { ...binding, txId: "different_agent_payment" }, key, "agent-authority-v1"));
  assert.throws(() => decryptRecord(envelope, binding, { ...key, encryptionKey: randomBytes(32) }, "agent-authority-v1"));
});

test("authority key material cannot reuse current or retained payment and risk keys", () => {
  const old = { keyId: "retained_payment", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
  const ring = new TransactionKeyRing(key.keyId, [old, key]);
  const independent = { keyId: "independent", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
  assert.equal(loadAgentAuthorityKeyRing(raw(independent), [ring]).activeKeyId, independent.keyId);
  assert.throws(() => loadAgentAuthorityKeyRing(raw(old), [ring]), /AGENT_AUTHORITY_KEYS_MUST_BE_INDEPENDENT/);
  assert.throws(() => loadAgentAuthorityKeyRing(raw({ ...independent, authenticationKey: key.encryptionKey }), [ring]), /AGENT_AUTHORITY_KEYS_MUST_BE_INDEPENDENT/);
  assert.throws(() => loadAgentAuthorityKeyRing("secret_invalid_input", [ring]), { message: "INVALID_AGENT_AUTHORITY_KEY_RING" });
});

test("mandate, approval, rejection and execution envelopes cannot substitute for one another", () => {
  const purposes = ["agent-mandate-v1", "agent-approval-v1", "agent-rejection-v1", "agent-authority-v1"];
  for (const purpose of purposes) {
    const envelope = protectRecord(value, binding, key, purpose);
    assert.deepEqual(decryptRecord(envelope, binding, key, purpose), value);
    for (const other of purposes.filter(candidate => candidate !== purpose)) assert.throws(() => decryptRecord(envelope, binding, key, other));
    assert.throws(() => decryptRiskRecord(envelope, binding, key));
  }
});
