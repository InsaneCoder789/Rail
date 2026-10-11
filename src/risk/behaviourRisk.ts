import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { PaymentTransaction } from "../domain/types.js";
import { canonicalTransactionPayload } from "../crypto/transactionSigning.js";
import { predictRisk, type LogisticRiskModel } from "./logisticRisk.js";
import { predictBehaviourRisk, type BehaviourRiskModel } from "./behaviourModel.js";
import type { RiskProtectionStore } from "../persistence/riskProtection.js";
import { predictAnomaly, type AnomalyModel } from "./anomalyRisk.js";

export interface BehaviourFeatures {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly source: "postgres_posted_payments";
  readonly historyWindowDays: 30;
  readonly historyCount: number;
  readonly historyTruncated: boolean;
  readonly recentCount: number;
  readonly receiverSeen: boolean;
  readonly meanAmountMinor: number | null;
  readonly amountRatio: number | null;
  readonly amountZScore: number | null;
  readonly agentBudgetExposure: number | null;
  readonly deviceChange: "not_assessed";
}

export function explainBehaviour(features: BehaviourFeatures): { level: "insufficient_history" | "normal" | "review"; reasons: string[] } {
  const reasons: string[] = [];
  if (features.historyCount < 5) reasons.push("insufficient_history");
  if (features.historyTruncated) reasons.push("history_truncated");
  if (features.recentCount >= 5) reasons.push("recent_payment_velocity");
  if (!features.receiverSeen) reasons.push("receiver_not_seen_in_sample");
  if (features.amountRatio !== null && features.amountRatio >= 3) reasons.push("amount_above_history");
  if (features.amountZScore !== null && features.amountZScore >= 3) reasons.push("amount_statistical_deviation");
  if (features.agentBudgetExposure !== null && features.agentBudgetExposure >= 0.8) reasons.push("high_agent_budget_exposure");
  const review = reasons.some(reason => !["insufficient_history", "history_truncated", "receiver_not_seen_in_sample"].includes(reason));
  return { level: review ? "review" : features.historyCount < 5 || features.historyTruncated ? "insufficient_history" : "normal", reasons };
}

/** Called after financial authority checks and sorted wallet locks, before posting this payment. */
export async function persistBehaviourObservation(client: PoolClient, txn: PaymentTransaction, model?: LogisticRiskModel,
  behaviourModel?: BehaviourRiskModel, protection?: RiskProtectionStore, anomalyModel?: AnomalyModel): Promise<void> {
  if (anomalyModel && !protection) throw new Error("ANOMALY_MODEL_REQUIRES_RISK_PROTECTION");
  const history = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
    SELECT timestamp.now, history.amount_minor, history.receiver_wallet_id, history.committed_at
    FROM timestamp LEFT JOIN LATERAL (
      SELECT ledger.amount_minor, auth.receiver_wallet_id, execution.committed_at
      FROM ledger_entries ledger JOIN rail_payment_executions execution ON execution.tx_id = ledger.tx_id
      JOIN authorizations auth ON auth.tx_id = ledger.tx_id AND auth.status = 'used'
      WHERE ledger.wallet_id = $1 AND ledger.entry_type = 'debit' AND ledger.currency = $2
        AND ledger.tx_id <> $3 AND ledger.created_at >= timestamp.now - interval '30 days'
        AND execution.committed_at <= timestamp.now
      ORDER BY ledger.created_at DESC, ledger.id DESC LIMIT 1001
    ) history ON TRUE`, [txn.senderWalletId, txn.currency, txn.txId]);
  const observedAt = new Date(history.rows[0].now).toISOString();
  const rows = history.rows.filter(row => row.amount_minor !== null).slice(0, 1000);
  const amounts = rows.map(row => Number(row.amount_minor));
  if (amounts.some(amount => !Number.isSafeInteger(amount) || amount <= 0)) throw new Error("risk_history_amount_invalid");
  // Welford avoids a tiny artificial variance when every historical amount is identical.
  let runningMean = 0, squaredDeviation = 0;
  amounts.forEach((amount, index) => {
    const delta = amount - runningMean;
    runningMean += delta / (index + 1);
    squaredDeviation += delta * (amount - runningMean);
  });
  const mean = amounts.length ? runningMean : null;
  const variance = amounts.length ? Math.max(0, squaredDeviation / amounts.length) : null;
  const agent = await client.query(`SELECT mandate.total_budget_minor, mandate.reserved_budget_minor, mandate.spent_budget_minor
    FROM rail_agent_intents intent JOIN rail_agent_mandates mandate ON mandate.mandate_id = intent.mandate_id
    WHERE 'rail_agent:' || intent.intent_id::text = $1 AND intent.status = 'approved'
      AND intent.owner_wallet_id = $2 AND intent.receiver_wallet_id = $3 AND intent.amount_minor = $4 AND intent.currency = $5`,
    [txn.txId, txn.senderWalletId, txn.receiverWalletId, txn.amountMinor, txn.currency]);
  const mandate = agent.rows[0];
  const features: BehaviourFeatures = {
    schemaVersion: 1, observedAt, source: "postgres_posted_payments", historyWindowDays: 30,
    historyCount: rows.length, historyTruncated: history.rows.length > 1000,
    recentCount: rows.filter(row => new Date(row.committed_at).getTime() >= Date.parse(observedAt) - 300_000).length,
    receiverSeen: rows.some(row => row.receiver_wallet_id === txn.receiverWalletId),
    meanAmountMinor: mean, amountRatio: mean === null ? null : txn.amountMinor / mean,
    amountZScore: amounts.length < 5 || !variance ? null : (txn.amountMinor - mean!) / Math.sqrt(variance),
    agentBudgetExposure: mandate ? (Number(mandate.reserved_budget_minor) + Number(mandate.spent_budget_minor)) / Number(mandate.total_budget_minor) : null,
    deviceChange: "not_assessed",
  };
  const assessment = explainBehaviour(features);
  const selected = behaviourModel ?? model;
  const outOfTime = behaviourModel !== undefined && Date.parse(behaviourModel.trainingCutoff) >= Date.parse(observedAt);
  const matching = selected?.currency === txn.currency && !outOfTime ? selected : undefined;
  const prediction = matching ? behaviourModel ? { modelKind: "behaviour-v1", ...predictBehaviourRisk(behaviourModel,
    { amountMinor: txn.amountMinor, channel: txn.channel, features }) } : { modelKind: "amount-channel-v1", ...predictRisk(model!, txn) } : null;
  const modelStatus = matching ? "available" : !selected ? "not_configured" : selected.currency !== txn.currency ? "currency_mismatch" : "not_yet_valid";
  const fingerprint = createHash("sha256").update(canonicalTransactionPayload(txn)).digest("hex");
  const summary = { policyVersion: "behaviour-shadow-v1", mode: "shadow", ...assessment };
  const modelHash = matching ? createHash("sha256").update(JSON.stringify(matching)).digest("hex") : null;
  const anomalyStatus = !anomalyModel ? "not_configured" : anomalyModel.currency !== txn.currency ? "currency_mismatch" :
    Date.parse(anomalyModel.trainingCutoff) >= Date.parse(observedAt) ? "not_yet_valid" :
    features.historyCount < 5 || features.historyTruncated ? "insufficient_history" : "available";
  const anomalySummary = anomalyStatus === "available" ? { status: anomalyStatus, modelVersion: anomalyModel!.modelVersion,
    synthetic: anomalyModel!.synthetic } : { status: anomalyStatus };
  const anomaly = { summary: anomalySummary, modelHash: anomalyStatus === "available" ?
    createHash("sha256").update(JSON.stringify(anomalyModel)).digest("hex") : null,
    prediction: anomalyStatus === "available" ? predictAnomaly(anomalyModel!, { amountMinor: txn.amountMinor, channel: txn.channel, features }) : null };
  if (protection) await protection.persist(client, { txId: txn.txId, requestFingerprint: fingerprint }, { observedAt,
    features, assessment: summary, modelStatus, modelVersion: matching?.modelVersion ?? null,
    modelHash, synthetic: matching?.synthetic ?? null, prediction, anomaly });
  await client.query(`INSERT INTO rail_risk_observations(tx_id, request_fingerprint, observed_at, feature_snapshot, assessment,
    model_status, model_version, model_hash, synthetic, prediction, protection_required, anomaly_summary)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)`, [txn.txId, fingerprint, observedAt,
    protection ? null : JSON.stringify(features), JSON.stringify(summary), modelStatus, matching?.modelVersion ?? null,
    protection ? null : modelHash, matching?.synthetic ?? null, !protection && prediction ? JSON.stringify(prediction) : null,
    Boolean(protection), JSON.stringify(anomalySummary)]);
}

export async function readBehaviourObservation(client: Pick<PoolClient, "query">, txId: string, walletId: string, protection?: RiskProtectionStore) {
  const result = await client.query(`SELECT observation.observed_at, observation.assessment, observation.model_status,
    observation.model_version, observation.synthetic, observation.protection_required, observation.anomaly_summary, execution.request_fingerprint,
    protected.envelope, protected.commitment FROM rail_payment_executions execution
    JOIN authorizations auth ON auth.tx_id = execution.tx_id
    LEFT JOIN rail_risk_observations observation ON observation.tx_id = execution.tx_id
    LEFT JOIN rail_protected_risk protected ON protected.tx_id = execution.tx_id
    WHERE execution.tx_id = $1 AND (auth.sender_wallet_id = $2 OR auth.receiver_wallet_id = $2)`, [txId, walletId]);
  const row = result.rows[0];
  if (!row) return undefined;
  if (!row.assessment) return { txId, status: "legacy_unobserved" as const };
  if (row.protection_required) {
    try {
      if (!protection) throw new Error("transaction_evidence_key_unavailable");
      protection.verify(row, { txId, requestFingerprint: row.request_fingerprint });
    } catch (error) {
      return { txId, status: "verification_unavailable" as const, reason: error instanceof Error &&
        error.message === "transaction_evidence_key_unavailable" ? "key_unavailable" : "verification_failed" };
    }
  }
  return { txId, status: "observed" as const, observedAt: new Date(row.observed_at).toISOString(),
    protection: row.protection_required ? "verified" : "legacy_plaintext",
    assessment: { mode: row.assessment.mode, policyVersion: row.assessment.policyVersion,
      level: row.assessment.level, reasons: row.assessment.reasons },
    modelStatus: row.model_status, modelVersion: row.model_version, synthetic: row.synthetic,
    anomaly: { status: row.anomaly_summary.status, ...(row.anomaly_summary.status === "available" ? {
      modelVersion: row.anomaly_summary.modelVersion, synthetic: row.anomaly_summary.synthetic } : {}) } };
}
