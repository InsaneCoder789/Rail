import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { protectTransaction, verifyAndDecryptTransaction, protectedTransactionCommitment, TransactionKeyRing, loadTransactionKeyRing } from "../dist/crypto/transactionProtection.js";
import { canonicalTransactionPayload } from "../dist/crypto/transactionSigning.js";
import { buildAuditCommitment, verifyAuditProof } from "../dist/crypto/auditCommitment.js";

const keys = { keyId: "test_key_v1", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
const transaction = { txId: "tx_encrypted_001", idempotencyKey: "idem_encrypted_001", authorizationId: "auth_encrypted_001",
  senderWalletId: "wallet_sender", receiverWalletId: "wallet_receiver", amountMinor: 2500, currency: "INR",
  channel: "online", createdAt: "2026-10-10T00:00:00.000Z" };
const binding = record => ({ txId: record.txId, requestFingerprint: record.requestFingerprint });

test("key rings validate configuration without exposing malformed secret input", () => {
  const value = { activeKeyId: keys.keyId, keys: [{ keyId: keys.keyId,
    encryptionKey: Buffer.from(keys.encryptionKey).toString("base64"), authenticationKey: Buffer.from(keys.authenticationKey).toString("base64") }] };
  assert.equal(loadTransactionKeyRing(JSON.stringify(value)).activeKeyId, keys.keyId);
  for (const raw of ["secret_bad_json", "{}", JSON.stringify({ ...value, activeKeyId: "missing" }),
    JSON.stringify({ ...value, maxRecordsPerKey: 1000001 }), JSON.stringify({ ...value, keys: [value.keys[0], value.keys[0]] }),
    JSON.stringify({ ...value, keys: [{ ...value.keys[0], encryptionKey: "bad" }] })]) {
    assert.throws(() => loadTransactionKeyRing(raw), { message: "INVALID_TRANSACTION_EVIDENCE_KEY_RING" });
  }
  assert.throws(() => loadTransactionKeyRing(undefined), /KEY_RING_REQUIRED/);
});

test("key rings retain retired versions and isolate key material from callers", () => {
  const old = { ...keys, encryptionKey: Buffer.from(keys.encryptionKey), authenticationKey: Buffer.from(keys.authenticationKey) };
  const next = { keyId: "next_version", encryptionKey: randomBytes(32), authenticationKey: randomBytes(32) };
  const record = protectTransaction(transaction, old);
  const ring = new TransactionKeyRing(next.keyId, [old, next]);
  old.encryptionKey.fill(0);
  ring.get(keys.keyId).authenticationKey.fill(0);
  assert.equal(verifyAndDecryptTransaction(record, binding(record), ring.get(keys.keyId)), canonicalTransactionPayload(transaction));
  assert.throws(() => ring.get("absent"), /key_unavailable/);
});

test("rotation rejects aliases and cross-purpose reuse of key material", () => {
  assert.throws(() => new TransactionKeyRing(keys.keyId, [keys, { ...keys, keyId: "alias" }]), /duplicate_transaction_key_material/);
  assert.throws(() => new TransactionKeyRing(keys.keyId, [keys, { keyId: "cross_purpose", encryptionKey: keys.authenticationKey,
    authenticationKey: randomBytes(32) }]), /duplicate_transaction_key_material/);
});

test("AES-256-GCM plus separate HMAC round-trips the existing bound transaction", () => {
  const record = protectTransaction(transaction, keys);
  assert.equal(verifyAndDecryptTransaction(record, binding(record), keys), canonicalTransactionPayload(transaction));
  assert.equal(Buffer.from(record.nonce, "base64").length, 12);
  assert.equal(Buffer.from(record.tag, "base64").length, 16);
  assert.equal(Buffer.from(record.mac, "base64").length, 32);
  assert.ok(!Buffer.from(record.ciphertext, "base64").toString("utf8").includes(transaction.senderWalletId));
});

test("repeated encryption uses fresh nonces without changing the request fingerprint", () => {
  const first = protectTransaction(transaction, keys);
  const second = protectTransaction(transaction, keys);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.requestFingerprint, second.requestFingerprint);
});

test("modified envelope fields and wrong payment bindings fail authentication", () => {
  const record = protectTransaction(transaction, keys);
  for (const change of [{ version: 2 }, { algorithm: "aes-256-cbc" }, { keyId: "other_key" }, { txId: "different_tx" },
    { requestFingerprint: "a".repeat(64) }, { nonce: randomBytes(12).toString("base64") },
    { ciphertext: randomBytes(100).toString("base64") }, { tag: randomBytes(16).toString("base64") },
    { mac: randomBytes(32).toString("base64") }, { mac: `${record.mac}\n` }]) {
    assert.throws(() => verifyAndDecryptTransaction({ ...record, ...change }, binding(record), keys), /verification_failed/);
  }
  assert.throws(() => verifyAndDecryptTransaction(record, { ...binding(record), txId: "wrong_record" }, keys), /verification_failed/);
});

test("GCM still rejects a changed tag even if the separate MAC is recalculated", () => {
  const record = { ...protectTransaction(transaction, keys), tag: randomBytes(16).toString("base64") };
  const bytes = JSON.stringify([record.version, record.algorithm, record.keyId, record.txId, record.requestFingerprint,
    record.nonce, record.ciphertext, record.tag]);
  record.mac = createHmac("sha256", keys.authenticationKey).update(bytes).digest("base64");
  assert.throws(() => verifyAndDecryptTransaction(record, binding(record), keys), /verification_failed/);
});

test("key reuse, invalid key lengths, wrong decryption keys and unbound inputs are rejected", () => {
  assert.throws(() => protectTransaction(transaction, null), /invalid_transaction_protection_keys/);
  assert.throws(() => protectTransaction(transaction, { ...keys, encryptionKey: Array(32).fill(1) }), /invalid_transaction_protection_keys/);
  assert.throws(() => protectTransaction(transaction, { ...keys, authenticationKey: keys.encryptionKey }), /invalid_transaction_protection_keys/);
  assert.throws(() => protectTransaction(transaction, { ...keys, encryptionKey: randomBytes(16) }), /invalid_transaction_protection_keys/);
  assert.throws(() => protectTransaction({ ...transaction, authorizationId: undefined }, keys), /invalid_transaction_for_protection/);
  const record = protectTransaction(transaction, keys);
  assert.throws(() => verifyAndDecryptTransaction(record, binding(record), { ...keys, encryptionKey: randomBytes(32) }), /verification_failed/);
  assert.throws(() => verifyAndDecryptTransaction(record, binding(record), { ...keys, authenticationKey: randomBytes(32) }), /verification_failed/);
});

test("encrypted transaction commitments work with existing Merkle proofs and detect alteration", () => {
  const records = [protectTransaction(transaction, keys), protectTransaction({ ...transaction, txId: "tx_encrypted_002" }, keys)];
  const leaves = records.map(protectedTransactionCommitment);
  const batch = buildAuditCommitment(leaves);
  assert.equal(verifyAuditProof(leaves[0], batch.proofs[0], batch.root), true);
  const altered = protectedTransactionCommitment({ ...records[0], mac: randomBytes(32).toString("base64") });
  assert.equal(verifyAuditProof(altered, batch.proofs[0], batch.root), false);
});
