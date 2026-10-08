import { createHash } from "node:crypto";
import type { PaymentTransaction } from "../domain/types.js";

export interface AuditProof {
  readonly leafIndex: number;
  readonly leafCount: number;
  readonly siblings: readonly string[];
}

const HASH = /^[a-f0-9]{64}$/;
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function parent(left: string, right: string): string {
  return hash(`rail:audit:node:v1:${left}:${right}`);
}

/** Keep the random salt and transaction private; publish only the batch root. */
export function commitTransaction(txn: PaymentTransaction, salt: string): string {
  if (!HASH.test(salt)) throw new Error("AUDIT_SALT_REQUIRES_32_RANDOM_BYTES_AS_HEX");
  return hash(JSON.stringify(["rail:audit:leaf:v1", salt, txn.txId, txn.idempotencyKey, txn.authorizationId ?? null,
    txn.senderWalletId, txn.receiverWalletId, txn.amountMinor, txn.currency, txn.channel,
    txn.offlineTokenId ?? null, txn.deviceId ?? null, txn.createdAt]));
}

/** Pure Merkle construction. Persistence, chain anchoring and finality are separate responsibilities. */
export function buildAuditCommitment(leaves: readonly string[]): { root: string; proofs: AuditProof[] } {
  if (!leaves.length || !leaves.every((leaf) => HASH.test(leaf))) throw new Error("INVALID_AUDIT_LEAVES");
  const levels: string[][] = [[...leaves]];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(parent(level[index], level[index + 1] ?? level[index]));
    }
    levels.push(next);
  }
  return { root: hash(`rail:audit:root:v1:${leaves.length}:${levels[levels.length - 1][0]}`), proofs: leaves.map((_, leafIndex) => {
    let index = leafIndex;
    const siblings: string[] = [];
    for (const level of levels.slice(0, -1)) {
      siblings.push(level[index ^ 1] ?? level[index]);
      index = Math.floor(index / 2);
    }
    return { leafIndex, leafCount: leaves.length, siblings };
  }) };
}

export function verifyAuditProof(leaf: string, proof: AuditProof, root: string): boolean {
  if (!HASH.test(leaf) || !HASH.test(root) || !Number.isSafeInteger(proof.leafCount) || proof.leafCount < 1 ||
      !Number.isSafeInteger(proof.leafIndex) || proof.leafIndex < 0 || proof.leafIndex >= proof.leafCount ||
      proof.siblings.length !== Math.ceil(Math.log2(proof.leafCount))) return false;
  let current = leaf;
  let index = proof.leafIndex;
  let width = proof.leafCount;
  for (const sibling of proof.siblings) {
    if (!HASH.test(sibling)) return false;
    if (index === width - 1 && width % 2 === 1 && sibling !== current) return false;
    current = index % 2 === 0 ? parent(current, sibling) : parent(sibling, current);
    index = Math.floor(index / 2);
    width = Math.ceil(width / 2);
  }
  return hash(`rail:audit:root:v1:${proof.leafCount}:${current}`) === root;
}
