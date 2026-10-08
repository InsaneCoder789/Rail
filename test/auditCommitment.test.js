import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { commitTransaction, buildAuditCommitment, verifyAuditProof } from "../dist/crypto/auditCommitment.js";

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
