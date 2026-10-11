import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PaymentTransaction } from "../domain/types.js";
import { TransactionKeyRing, protectTransaction, protectedTransactionCommitment, verifyAndDecryptTransaction, type ProtectedTransaction } from "../crypto/transactionProtection.js";

export interface EvidenceStatus {
  readonly txId: string;
  readonly status: "verified" | "legacy_unprotected" | "verification_unavailable";
  readonly reason?: "key_unavailable" | "verification_failed";
  readonly commitment?: string;
}

export class TransactionEvidenceStore {
  constructor(private readonly keyRing: TransactionKeyRing) {}

  /** Only call with the financial transaction client; never check out another connection. */
  async persist(client: PoolClient, txn: PaymentTransaction): Promise<void> {
    const execution = await client.query("SELECT request_fingerprint, evidence_required FROM rail_payment_executions WHERE tx_id = $1", [txn.txId]);
    if (!execution.rows[0]?.evidence_required) throw new Error("transaction_evidence_execution_not_required");
    const existing = await client.query("SELECT envelope, commitment FROM rail_transaction_evidence WHERE tx_id = $1", [txn.txId]);
    if (existing.rows[0]) {
      this.verifyRecord(existing.rows[0], { txId: txn.txId, requestFingerprint: execution.rows[0].request_fingerprint });
      return;
    }
    const key = this.keyRing.get(this.keyRing.activeKeyId);
    const keyFingerprint = createHash("sha256").update(key.encryptionKey).digest("hex");
    const quota = await client.query(`INSERT INTO rail_evidence_key_usage(encryption_key_fingerprint, record_count)
      VALUES ($1, 1) ON CONFLICT (encryption_key_fingerprint) DO UPDATE SET record_count = rail_evidence_key_usage.record_count + 1
      WHERE rail_evidence_key_usage.record_count < $2 RETURNING record_count`, [keyFingerprint, this.keyRing.maxRecordsPerKey]);
    if (quota.rowCount !== 1) throw new Error("transaction_evidence_key_rotation_required");
    const envelope = protectTransaction(txn, key);
    verifyAndDecryptTransaction(envelope, { txId: txn.txId, requestFingerprint: execution.rows[0].request_fingerprint }, key);
    await client.query(`INSERT INTO rail_transaction_evidence(tx_id, request_fingerprint, encryption_key_fingerprint, nonce, envelope, commitment)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [txn.txId, envelope.requestFingerprint, keyFingerprint, envelope.nonce,
      JSON.stringify(envelope), protectedTransactionCommitment(envelope)]);
  }

  /** Internal trusted-storage verification; the caller must independently enforce access control. */
  verifyRecord(row: { envelope: ProtectedTransaction; commitment: string }, expected: { txId: string; requestFingerprint: string }): void {
    verifyAndDecryptTransaction(row.envelope, expected, this.keyRing.get(row.envelope.keyId));
    if (protectedTransactionCommitment(row.envelope) !== row.commitment) throw new Error("transaction_evidence_commitment_mismatch");
  }

  async status(pool: Pool, txId: string, walletId: string): Promise<EvidenceStatus | undefined> {
    // Ownership is filtered in SQL, so missing and unauthorized records look identical.
    const result = await pool.query(`SELECT execution.request_fingerprint, execution.evidence_required, evidence.envelope, evidence.commitment
      FROM rail_payment_executions execution JOIN authorizations auth ON auth.tx_id = execution.tx_id
      LEFT JOIN rail_transaction_evidence evidence ON evidence.tx_id = execution.tx_id
      WHERE execution.tx_id = $1 AND (auth.sender_wallet_id = $2 OR auth.receiver_wallet_id = $2)`, [txId, walletId]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (!row.envelope && !row.evidence_required) return { txId, status: "legacy_unprotected" };
    try {
      this.verifyRecord(row, { txId, requestFingerprint: row.request_fingerprint });
      return { txId, status: "verified", commitment: row.commitment };
    } catch (error) {
      return { txId, status: "verification_unavailable", reason: error instanceof Error && error.message === "transaction_evidence_key_unavailable"
        ? "key_unavailable" : "verification_failed" };
    }
  }
}
