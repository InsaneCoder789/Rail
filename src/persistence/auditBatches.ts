import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { buildAuditCommitment, commitProtectedEvidence, verifyAuditProof, type AuditProof } from "../crypto/auditCommitment.js";
import type { ProtectedTransaction } from "../crypto/transactionProtection.js";
import type { TransactionEvidenceStore } from "./transactionEvidence.js";
import type { RiskProtectionStore, RiskEnvelope } from "./riskProtection.js";

interface AuditRow {
  tx_id: string;
  request_fingerprint: string;
  evidence_required: boolean;
  risk_protection_required: boolean;
  envelope: ProtectedTransaction;
  commitment: string;
  risk_envelope: RiskEnvelope | null;
  risk_commitment: string | null;
  observed_at: Date;
  assessment: unknown;
  model_status: string;
  model_version: string | null;
  synthetic: boolean | null;
  anomaly_summary: unknown;
  batch_id: string | null;
  root: string;
  leaf_count: number;
  leaf_index: number;
  leaf_hash: string;
  payment_commitment: string;
  included_risk_commitment: string | null;
  proof: AuditProof;
}
const RECORD_SELECT = `SELECT execution.tx_id, execution.request_fingerprint, execution.evidence_required, execution.risk_protection_required,
  evidence.envelope, evidence.commitment, protected.envelope AS risk_envelope, protected.commitment AS risk_commitment,
  observation.observed_at, observation.assessment, observation.model_status, observation.model_version, observation.synthetic,
  observation.anomaly_summary, membership.batch_id, membership.leaf_index, membership.leaf_hash,
  membership.payment_commitment, membership.risk_commitment AS included_risk_commitment, membership.proof, batch.root, batch.leaf_count
  FROM rail_payment_executions execution LEFT JOIN rail_transaction_evidence evidence ON evidence.tx_id = execution.tx_id
  LEFT JOIN rail_risk_observations observation ON observation.tx_id = execution.tx_id
  LEFT JOIN rail_protected_risk protected ON protected.tx_id = execution.tx_id
  LEFT JOIN rail_audit_memberships membership ON membership.tx_id = execution.tx_id
  LEFT JOIN rail_audit_batches batch ON batch.batch_id = membership.batch_id`;

export class AuditBatchStore {
  constructor(private readonly pool: Pool, private readonly evidence: TransactionEvidenceStore,
    private readonly risk: RiskProtectionStore) {}

  private verifiedLeaf(row: AuditRow): { leaf: string; riskCommitment: string | null } {
    const binding = { txId: row.tx_id, requestFingerprint: row.request_fingerprint };
    if (!row.evidence_required || !row.envelope) throw new Error("audit_evidence_missing");
    this.evidence.verifyRecord(row, binding);
    let riskCommitment: string | null = null;
    if (row.risk_protection_required) {
      if (!row.risk_envelope || !row.risk_commitment) throw new Error("audit_risk_missing");
      this.risk.verify({ envelope: row.risk_envelope, commitment: row.risk_commitment, observed_at: row.observed_at,
        assessment: row.assessment, model_status: row.model_status, model_version: row.model_version,
        synthetic: row.synthetic, anomaly_summary: row.anomaly_summary }, binding);
      riskCommitment = row.risk_commitment;
    }
    return { leaf: commitProtectedEvidence(row.commitment, riskCommitment), riskCommitment };
  }

  /** A separate post-payment transaction; no network calls or financial mutations. */
  async createBatch(limit = 128) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("INVALID_AUDIT_BATCH_LIMIT");
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rail:audit:batch:v1'))");
      const selected = await client.query<AuditRow>(`${RECORD_SELECT}
        JOIN rail_audit_pending pending ON pending.tx_id = execution.tx_id
        WHERE execution.evidence_required AND membership.tx_id IS NULL ORDER BY pending.queued_at, pending.tx_id LIMIT $1`, [limit]);
      if (!selected.rows.length) { await client.query("COMMIT"); return { status: "empty" as const }; }
      const records = selected.rows.map(row => ({ row, ...this.verifiedLeaf(row) }));
      const { root, proofs } = buildAuditCommitment(records.map(record => record.leaf));
      const batchId = randomUUID();
      await client.query("INSERT INTO rail_audit_batches(batch_id, root, leaf_count) VALUES ($1,$2,$3)", [batchId, root, records.length]);
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!verifyAuditProof(record.leaf, proofs[index], root)) throw new Error("audit_proof_invalid");
        await client.query(`INSERT INTO rail_audit_memberships(tx_id, batch_id, leaf_index, leaf_hash, payment_commitment, risk_commitment, proof)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [record.row.tx_id, batchId, index, record.leaf, record.row.commitment,
          record.riskCommitment, JSON.stringify(proofs[index])]);
        await client.query("DELETE FROM rail_audit_pending WHERE tx_id = $1", [record.row.tx_id]);
      }
      await client.query("COMMIT");
      return { status: "created" as const, batchId, root, leafCount: records.length, publication: "unanchored" as const };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.off("error", onError); client.release(discard); }
  }

  async status(txId: string, walletId: string) {
    const result = await this.pool.query<AuditRow>(`${RECORD_SELECT}
      JOIN authorizations auth ON auth.tx_id = execution.tx_id
      WHERE execution.tx_id = $1 AND (auth.sender_wallet_id = $2 OR auth.receiver_wallet_id = $2)`, [txId, walletId]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (!row.evidence_required) return { txId, status: "legacy_unprotected" as const };
    try {
      const { leaf, riskCommitment } = this.verifiedLeaf(row);
      if (!row.batch_id) return { txId, status: "pending_batch" as const };
      if (row.leaf_hash !== leaf || row.payment_commitment !== row.commitment || row.included_risk_commitment !== riskCommitment ||
          row.proof.leafCount !== row.leaf_count || row.proof.leafIndex !== row.leaf_index || !verifyAuditProof(leaf, row.proof, row.root)) {
        throw new Error("audit_proof_invalid");
      }
      return { txId, status: "batched" as const, publication: "unanchored" as const, verification: "local_only" as const,
        batchId: row.batch_id, root: row.root, leaf, paymentCommitment: row.commitment, riskCommitment, proof: row.proof };
    } catch (error) {
      return { txId, status: "verification_unavailable" as const, reason: error instanceof Error &&
        error.message === "transaction_evidence_key_unavailable" ? "key_unavailable" as const : "verification_failed" as const };
    }
  }
}
