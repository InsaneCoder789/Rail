import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { commitTransaction, commitProtectedEvidence, buildAuditCommitment, verifyAuditProof } from "../dist/crypto/auditCommitment.js";

const transaction = { txId: "audit_test_001", senderWalletId: "sender", receiverWalletId: "receiver",
  amountMinor: 1000, currency: "INR", channel: "online", createdAt: "2026-10-08T00:00:00.000Z" };

test("audit commitments prove inclusion and reject altered payments in odd-sized batches", () => {
  const salts = Array.from({ length: 5 }, () => randomBytes(32).toString("hex"));
  const leaves = salts.map((salt) => commitTransaction(transaction, salt));
  const { root, proofs } = buildAuditCommitment(leaves);
  leaves.forEach((leaf, index) => assert.equal(verifyAuditProof(leaf, proofs[index], root), true));
  assert.equal(verifyAuditProof(commitTransaction({ ...transaction, amountMinor: 2000 }, salts[0]), proofs[0], root), false);
  assert.equal(verifyAuditProof(leaves[0], { ...proofs[0], leafIndex: 1 }, root), false);
  assert.equal(verifyAuditProof(leaves[0], { ...proofs[0], siblings: [] }, root), false);
  assert.equal(verifyAuditProof(leaves[0], { ...proofs[0], leafCount: 6 }, root), false);
  assert.notEqual(leaves[0], leaves[1]);
});

test("single-leaf commitments work and malformed inputs are rejected", () => {
  const leaf = commitTransaction(transaction, randomBytes(32).toString("hex"));
  const { root, proofs } = buildAuditCommitment([leaf]);
  assert.equal(verifyAuditProof(leaf, proofs[0], root), true);
  assert.throws(() => buildAuditCommitment([]));
  assert.throws(() => commitTransaction(transaction, "short"));
});

test("protected audit leaves bind payment and optional risk commitments without raw transaction fields", () => {
  const payment = "a".repeat(64), risk = "b".repeat(64), leaf = commitProtectedEvidence(payment, risk);
  assert.notEqual(leaf, commitProtectedEvidence(payment, null));
  assert.notEqual(leaf, commitProtectedEvidence(risk, payment));
  const tree = buildAuditCommitment([leaf]);
  assert.equal(verifyAuditProof(leaf, tree.proofs[0], tree.root), true);
  for (const args of [[undefined, risk], [payment, undefined], ["short", null], [payment, "wrong"]])
    assert.throws(() => commitProtectedEvidence(...args), /INVALID_PROTECTED_AUDIT_INPUT/);
});

test("Merkle helpers reject sparse or oversized leaves and hostile proof shapes without throwing", () => {
  const leaf = "a".repeat(64), tree = buildAuditCommitment([leaf]);
  for (const leaves of [null, Array(2), Array(1025).fill(leaf), [leaf, 42]]) assert.throws(() => buildAuditCommitment(leaves), /INVALID_AUDIT_LEAVES/);
  for (const proof of [null, {}, { leafIndex: 0, leafCount: 1025, siblings: [] }, { leafIndex: 0, leafCount: 2, siblings: Array(1) },
    { leafIndex: 0, leafCount: 2, siblings: null }, { leafIndex: 0, leafCount: 2, siblings: [42] }])
    assert.equal(verifyAuditProof(leaf, proof, tree.root), false);
  const maximum = buildAuditCommitment(Array(1024).fill(leaf));
  assert.equal(verifyAuditProof(leaf, maximum.proofs[1023], maximum.root), true);
});
