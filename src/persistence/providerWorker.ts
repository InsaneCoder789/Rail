import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ProviderObservation, ProviderPayment } from "../domain/providerPayment.js";
import { ProviderTargetRegistry } from "../domain/providerTargets.js";
import { advanceProviderPaymentInTransaction, readProviderPaymentInTransaction, requireProviderSubmission } from "./providerPayments.js";
import { withTransactionSavepoint, withPoolTransaction as transaction } from "./transaction.js";
import { RequestError } from "../server/http.js";
import type { AgentEvidenceStore } from "./agentEvidence.js";

/** Only called after fresh execution-scope DPoP admission in the caller's transaction. */
export async function enqueueProviderPayment(client: PoolClient, input: {
  operationId: string; agentId: string; ownerWalletId: string; fingerprint: string;
  credentialId: string; proofId: string; keyThumbprint: string;
}, targets: ProviderTargetRegistry, allowedProviders: readonly string[] = ["simulator"]) {
  return withTransactionSavepoint(client, async () => {
    const owned = await client.query(`SELECT 1 FROM rail_provider_payments WHERE operation_id=$1 AND owner_wallet_id=$2
      AND agent_id=$3 AND authorization_required`, [input.operationId, input.ownerWalletId, input.agentId]);
    if (!owned.rowCount) throw new RequestError(404, "provider_payment_not_found", "approved provider payment not found");
    const payment = await readProviderPaymentInTransaction(client, input.ownerWalletId, input.operationId);
    if (payment.binding.agentId !== input.agentId || payment.fingerprint !== input.fingerprint || !payment.authorizationRequired)
      throw new RequestError(409, "provider_execution_binding_mismatch", "execution does not match the approved payment");
    if (!allowedProviders.includes(payment.binding.provider) || !["simulator", "stripe"].includes(payment.binding.provider))
      throw new RequestError(503, "provider_target_unavailable", "provider execution is not enabled");
    if (payment.binding.provider === "stripe" && (!["USD", "INR"].includes(payment.binding.currency) || payment.binding.amountMinor > 99999999))
      throw new RequestError(422, "stripe_terms_unsupported", "unsupported Stripe test payment terms");
    const existing = await client.query("SELECT id FROM outbox WHERE provider_operation_id=$1", [input.operationId]);
    if (existing.rowCount) return { operationId: input.operationId, queued: true };
    if (payment.status !== "reserved") throw new RequestError(409, "provider_execution_not_reserved", "payment is not reserved for execution");
    await requireProviderSubmission(client, input.operationId, targets);
    await client.query(`INSERT INTO outbox(type,payload,work_kind,provider_operation_id,provider_credential_id,provider_proof_id,provider_key_thumbprint)
      VALUES('provider.execute','{}','provider_payment',$1,$2,$3,$4)`,
    [input.operationId, input.credentialId, input.proofId, input.keyThumbprint]);
    return { operationId: input.operationId, queued: true };
  });
}

/** Durable local test double. No SDK, network payment or real money; one row is one simulated effect. */
export class LocalPaymentSimulator {
  readonly provider = "simulator" as const;
  constructor(private readonly pool: Pool, private readonly fault: "none" | "lose_reply" | "no_effect" | "decline" = "none") {}

  async submit(payment: ProviderPayment): Promise<ProviderObservation> {
    if (payment.binding.provider !== "simulator") throw new Error("SIMULATOR_TARGET_REQUIRED");
    if (this.fault === "no_effect") throw new Error("SIMULATED_TRANSPORT_FAILURE");
    const observation: ProviderObservation = { operationId: payment.binding.operationId, fingerprint: payment.fingerprint,
      provider: "simulator", providerAccountRef: payment.binding.providerAccountRef, providerRef: `sim_${payment.binding.operationId}`,
      amountMinor: payment.binding.amountMinor, currency: payment.binding.currency, status: this.fault === "decline" ? "failed" : "succeeded", final: true };
    await this.pool.query(`INSERT INTO rail_simulator_effects(idempotency_key,fingerprint,observation) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(idempotency_key) DO NOTHING`, [payment.idempotencyKey, payment.fingerprint, JSON.stringify(observation)]);
    const original = await this.lookup(payment);
    if (this.fault === "lose_reply") throw new Error("SIMULATED_RESPONSE_LOST");
    return original!;
  }

  async lookup(payment: ProviderPayment): Promise<ProviderObservation | null> {
    if (payment.binding.provider !== "simulator") throw new Error("SIMULATOR_TARGET_REQUIRED");
    const result = await this.pool.query("SELECT * FROM rail_simulator_effects WHERE idempotency_key=$1", [payment.idempotencyKey]);
    if (!result.rowCount) return null;
    if (result.rows[0].fingerprint !== payment.fingerprint) throw new Error("SIMULATOR_KEY_REUSED");
    return result.rows[0].observation;
  }
}

const terminal = (status: string) => ["succeeded", "failed", "cancelled"].includes(status);
const denied = (error: unknown) => error instanceof Error && ["PROVIDER_AUTHORITY_WITHDRAWN", "PROVIDER_AUTHORITY_UNAVAILABLE",
  "PROVIDER_AUTHORIZATION_EXPIRED", "PROVIDER_EXECUTION_CREDENTIAL_WITHDRAWN", "SIMULATOR_TARGET_REQUIRED"].includes(error.message) ||
  Boolean(error && typeof error === "object" && "code" in error &&
    ["provider_target_denied", "provider_target_changed", "provider_targets_unavailable", "shared_budget_not_found", "shared_budget_inactive",
      "shared_budget_currency_denied", "fresh_shared_budget_consent_required"].includes(String(error.code)));

export interface PaymentProvider {
  readonly provider: "simulator" | "stripe";
  submit(payment: ProviderPayment): Promise<ProviderObservation>;
  lookup(payment: ProviderPayment): Promise<ProviderObservation | null>;
}
/** A finite provider-isolated batch. Unknown outcomes are lookup-only, never resubmitted. */
export async function dispatchProviderBatch(pool: Pool, targets: ProviderTargetRegistry, adapter: PaymentProvider,
  options: { batchSize?: number; leaseMs?: number; timeoutMs?: number; retryDelayMs?: number; evidence?: AgentEvidenceStore } = {}) {
  const { evidence, ...timings } = options;
  if (!evidence) throw new Error("PROVIDER_OUTCOME_EVIDENCE_REQUIRED");
  if (!["simulator", "stripe"].includes(adapter.provider)) throw new Error("INVALID_PAYMENT_PROVIDER");
  const policy = { batchSize: 10, leaseMs: 30000, timeoutMs: 5000, retryDelayMs: 1000, ...timings };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1) || policy.batchSize > 100 ||
      policy.leaseMs > 300000 || policy.timeoutMs >= policy.leaseMs) throw new Error("INVALID_PROVIDER_WORKER_POLICY");
  const stats = { resolved: 0, pending: 0, lostLease: 0 };
  for (let index = 0; index < policy.batchSize; index++) {
    const lease = randomUUID();
    const claimed = await pool.query(`WITH candidate AS (
      SELECT job.id FROM outbox job JOIN rail_provider_payments payment ON payment.operation_id=job.provider_operation_id
      WHERE job.work_kind='provider_payment' AND payment.binding->>'provider'=$3 AND
      ((job.delivery_status='pending' AND job.next_attempt_at<=clock_timestamp()) OR
       (job.delivery_status='processing' AND job.lease_expires_at<=clock_timestamp())) ORDER BY job.id FOR UPDATE OF job SKIP LOCKED LIMIT 1)
      UPDATE outbox job SET delivery_status='processing',delivery_attempts=LEAST(delivery_attempts,2147483646)+1,lease_id=$1,
      lease_expires_at=clock_timestamp()+$2*interval '1 millisecond' FROM candidate WHERE job.id=candidate.id RETURNING job.*`, [lease, policy.leaseMs, adapter.provider]);
    const job = claimed.rows[0]; if (!job) break;
    const live = async (client: PoolClient) => (await client.query(`SELECT id FROM outbox WHERE id=$1 AND work_kind='provider_payment'
      AND delivery_status='processing' AND lease_id=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE`, [job.id, lease])).rowCount === 1;
    const identity = { operationId: job.provider_operation_id, ownerWalletId: "", fingerprint: "" };
    const updateJob = async (client: PoolClient, done: boolean) => {
      const result = await client.query(`UPDATE outbox SET delivery_status=$3,
      lease_id=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+$4*interval '1 millisecond',
      delivered_at=CASE WHEN $3='delivered' THEN clock_timestamp() ELSE NULL END,
      last_delivery_error=CASE WHEN $3='delivered' THEN NULL ELSE 'provider_resolution_pending' END
      WHERE id=$1 AND lease_id=$2 AND lease_expires_at>clock_timestamp()`, [job.id, lease, done ? "delivered" : "pending", policy.retryDelayMs]);
      if (result.rowCount !== 1) throw new Error("PROVIDER_LEASE_LOST");
      return result;
    };
    try {
      const prepared = await transaction(pool, async client => {
        if (!await live(client)) return null;
        const row = (await client.query("SELECT owner_wallet_id,fingerprint FROM rail_provider_payments WHERE operation_id=$1", [identity.operationId])).rows[0];
        if (!row) throw new Error("PROVIDER_ADMITTED_PROPOSAL_REQUIRED");
        identity.ownerWalletId = row.owner_wallet_id; identity.fingerprint = row.fingerprint;
        let payment = await readProviderPaymentInTransaction(client, identity.ownerWalletId, identity.operationId);
        if (terminal(payment.status)) {
          if (!evidence) throw new Error("PROVIDER_OUTCOME_EVIDENCE_REQUIRED");
          await evidence.persistProviderOutcome(client, payment);
          await updateJob(client, true); return { payment, submit: false, done: true };
        }
        if (payment.status === "reserved") {
          try {
            await withTransactionSavepoint(client, async () => {
              await requireProviderSubmission(client, identity.operationId, targets);
              const credential = await client.query(`SELECT 1 FROM rail_agent_credentials WHERE credential_id=$1 AND agent_id=$2
                AND proof_key_thumbprint=$3 AND scope='payments:execute' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
              [job.provider_credential_id, payment.binding.agentId, job.provider_key_thumbprint]);
              if (!credential.rowCount) throw new Error("PROVIDER_EXECUTION_CREDENTIAL_WITHDRAWN");
              if (payment.binding.provider !== adapter.provider) throw new Error("PROVIDER_WORKER_MISMATCH");
              payment = await advanceProviderPaymentInTransaction(client, identity, { type: "begin_submission", idempotencyWindowMs: 86400000 }, targets);
              if (!await live(client)) throw new Error("PROVIDER_LEASE_LOST");
            });
          } catch (error) {
            if (!denied(error)) throw error;
            payment = await advanceProviderPaymentInTransaction(client, identity, { type: "cancel_before_submission" });
            if (!evidence) throw new Error("PROVIDER_OUTCOME_EVIDENCE_REQUIRED");
            await evidence.persistProviderOutcome(client, payment);
            await updateJob(client, true); return { payment, submit: false, done: true };
          }
          return { payment, submit: true, done: false };
        }
        if (payment.status === "submitting") payment = await advanceProviderPaymentInTransaction(client, identity, { type: "submission_uncertain" });
        return { payment, submit: false, done: false };
      });
      if (!prepared) { stats.lostLease++; continue; }
      if (prepared.done) { stats.resolved++; continue; }
      let lookupPayment = prepared.payment;
      if (!prepared.submit && adapter.provider === "stripe" && lookupPayment.providerRef === null) {
        const hints = await pool.query(`SELECT DISTINCT payment_intent_id FROM rail_stripe_callback_inbox
          WHERE stripe_account_id=$1 AND operation_id=$2 AND request_fingerprint=$3
            AND processing_result='matched' AND processed_at IS NOT NULL LIMIT 2`,
        [lookupPayment.binding.providerAccountRef, identity.operationId, identity.fingerprint]);
        if (hints.rows.length > 1) throw new Error("STRIPE_CALLBACK_CORRELATION_CONFLICT");
        if (hints.rows[0]) lookupPayment = { ...lookupPayment, providerRef: String(hints.rows[0].payment_intent_id) };
      }
      // No financial transaction is held during provider I/O.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let observed: ProviderObservation | null = null;
      try {
        observed = await Promise.race([prepared.submit ? adapter.submit(prepared.payment) : adapter.lookup(lookupPayment),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROVIDER_TIMEOUT")), policy.timeoutMs); })]);
      } catch { /* No response is not proof of failure. */ }
      finally { if (timer) clearTimeout(timer); }
      const finished = await transaction(pool, async client => {
        if (!await live(client)) return null;
        let payment = await readProviderPaymentInTransaction(client, identity.ownerWalletId, identity.operationId);
        if (observed) payment = await advanceProviderPaymentInTransaction(client, identity, { type: "provider_observed", observation: observed });
        else if (payment.status === "submitting") payment = await advanceProviderPaymentInTransaction(client, identity, { type: "submission_uncertain" });
        const done = terminal(payment.status);
        if (done) {
          if (!evidence) throw new Error("PROVIDER_OUTCOME_EVIDENCE_REQUIRED");
          await evidence.persistProviderOutcome(client, payment);
        }
        if ((await updateJob(client, done)).rowCount !== 1) throw new Error("PROVIDER_LEASE_LOST");
        return done;
      });
      if (finished === null) stats.lostLease++; else if (finished) stats.resolved++; else stats.pending++;
    } catch (error) {
      // Includes database failures: retain work and liability for later inspection/recovery.
      const reason = error instanceof Error && ["CONFLICTING_PROVIDER_OUTCOME", "STRIPE_CALLBACK_CORRELATION_CONFLICT",
        "PROVIDER_OBSERVATION_MISMATCH", "STRIPE_OBSERVATION_PROVENANCE_REQUIRED", "provider_outcome_verification_failed"].includes(error.message)
        ? error.message.toLowerCase() : "provider_worker_retry";
      const result = await pool.query(`UPDATE outbox SET delivery_status='pending',lease_id=NULL,lease_expires_at=NULL,
        next_attempt_at=clock_timestamp()+$3*interval '1 millisecond',last_delivery_error=$4
        WHERE id=$1 AND lease_id=$2 AND lease_expires_at>clock_timestamp()`, [job.id, lease, policy.retryDelayMs, reason]);
      if (result.rowCount) stats.pending++; else stats.lostLease++;
    }
  }
  return stats;
}
