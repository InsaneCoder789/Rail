import type { Pool } from "pg";
import { verifyStripeTestWebhook } from "../rail/stripeProvider.js";
import { RequestError } from "../server/http.js";
import { randomUUID } from "node:crypto";
import type { StripeTestProvider } from "../rail/stripeProvider.js";
import { withPoolTransaction } from "./transaction.js";
import { readProviderPaymentInTransaction } from "./providerPayments.js";
import { advanceProviderPayment } from "../domain/providerPayment.js";

interface Configuration { readonly accountId: string; readonly webhookSecret: string; }
const valid = (value: Configuration) => value && /^acct_[A-Za-z0-9]{3,120}$/.test(value.accountId) && /^whsec_[A-Za-z0-9]{16,256}$/.test(value.webhookSecret);

export function loadStripeCallbackConfiguration(env: NodeJS.ProcessEnv = process.env): Configuration | undefined {
  const flag = env.RAIL_STRIPE_TEST_WEBHOOKS;
  if (flag === undefined || flag === "false") return undefined;
  const value = { accountId: env.RAIL_STRIPE_ACCOUNT_ID ?? "", webhookSecret: env.RAIL_STRIPE_WEBHOOK_SECRET ?? "" };
  if (flag !== "true" || env.NODE_ENV === "production" || env.RAIL_DEMO_MODE !== "true" || !valid(value))
    throw new Error("INVALID_STRIPE_TEST_CALLBACK_CONFIGURATION");
  return Object.freeze(value);
}

/** Durable admission only. No provider API call or financial transition occurs here. */
export class StripeCallbackInbox {
  private readonly configuration: Configuration;
  constructor(private readonly pool: Pool, configuration: Configuration, private readonly maxPending = 10000) {
    if (!valid(configuration) || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 10000)
      throw new Error("INVALID_STRIPE_TEST_CALLBACK_CONFIGURATION");
    this.configuration = Object.freeze({ ...configuration });
  }

  async accept(rawBody: Buffer, signature: unknown) {
    let candidate;
    try { candidate = verifyStripeTestWebhook(rawBody, signature, this.configuration.webhookSecret); }
    catch { throw new RequestError(400, "invalid_stripe_webhook", "invalid Stripe webhook"); }
    if (!candidate) return { received: true, ignored: true, duplicate: false };
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`rail:stripe-inbox:${this.configuration.accountId}`]);
      const previous = (await client.query(`SELECT payment_intent_id FROM rail_stripe_callback_inbox
        WHERE stripe_account_id=$1 AND event_id=$2`, [this.configuration.accountId, candidate.eventId])).rows[0];
      if (previous && previous.payment_intent_id !== candidate.paymentIntentId)
        throw new RequestError(409, "stripe_event_conflict", "Stripe event correlation conflict");
      if (!previous) {
        const pending = await client.query(`SELECT count(*) AS count FROM rail_stripe_callback_inbox
          WHERE stripe_account_id=$1 AND processed_at IS NULL`, [this.configuration.accountId]);
        if (Number(pending.rows[0].count) >= this.maxPending)
          throw new RequestError(503, "stripe_inbox_full", "Stripe callback backlog requires attention");
        await client.query(`INSERT INTO rail_stripe_callback_inbox(stripe_account_id,event_id,payment_intent_id,body_hash)
          VALUES($1,$2,$3,$4)`, [this.configuration.accountId, candidate.eventId, candidate.paymentIntentId, candidate.bodyHash]);
      }
      await client.query("COMMIT");
      return { received: true, ignored: false, duplicate: Boolean(previous) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); client.removeListener("error", onError); }
  }
}

/** Consume authenticated event hints; only the payment worker resolves financial state. */
export async function processStripeCallbacks(pool: Pool, provider: StripeTestProvider,
  options: { batchSize?: number; leaseMs?: number; timeoutMs?: number; retryDelayMs?: number } = {}) {
  const policy = { batchSize: 10, leaseMs: 30000, timeoutMs: 15000, retryDelayMs: 30000, ...options };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1) || policy.batchSize > 100 ||
      policy.leaseMs > 300000 || policy.timeoutMs >= policy.leaseMs) throw new Error("INVALID_STRIPE_CALLBACK_POLICY");
  const stats = { processed: 0, ignored: 0, pending: 0, lostLease: 0 };
  for (let index = 0; index < policy.batchSize; index++) {
    const lease = randomUUID();
    const claim = await pool.query(`WITH candidate AS (
      SELECT stripe_account_id,event_id FROM rail_stripe_callback_inbox
      WHERE stripe_account_id=$3 AND processed_at IS NULL AND next_attempt_at<=clock_timestamp()
        AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
      ORDER BY received_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE rail_stripe_callback_inbox item SET lease_id=$1,lease_expires_at=clock_timestamp()+$2*interval '1 millisecond',
        delivery_attempts=LEAST(item.delivery_attempts,2147483646)+1
      FROM candidate WHERE item.stripe_account_id=candidate.stripe_account_id AND item.event_id=candidate.event_id RETURNING item.*`,
    [lease, policy.leaseMs, provider.accountId]);
    const item = claim.rows[0]; if (!item) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // No database client/financial locks are held during account and object retrieval.
      const snapshot = await Promise.race([provider.callbackSnapshot(item.payment_intent_id), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("STRIPE_CALLBACK_TIMEOUT")), policy.timeoutMs);
      })]);
      if (timer) clearTimeout(timer);
      const finished = await withPoolTransaction(pool, async client => {
        // Match the payment worker's outbox-first ordering; do not acquire authority locks.
        if (snapshot) {
          const job = await client.query("SELECT id FROM outbox WHERE provider_operation_id=$1 AND work_kind='provider_payment' FOR UPDATE", [snapshot.operationId]);
          if (job.rowCount !== 1) throw new Error("STRIPE_CALLBACK_PAYMENT_UNAVAILABLE");
        }
        const live = await client.query(`SELECT event_id FROM rail_stripe_callback_inbox
          WHERE stripe_account_id=$1 AND event_id=$2 AND lease_id=$3 AND lease_expires_at>clock_timestamp()
            AND processed_at IS NULL FOR UPDATE`, [provider.accountId, item.event_id, lease]);
        if (!live.rowCount) return null;
        if (snapshot) {
          const owned = (await client.query(`SELECT owner_wallet_id FROM rail_provider_payments
            WHERE operation_id=$1 AND binding->>'provider'='stripe' AND binding->>'providerAccountRef'=$2 FOR SHARE`,
          [snapshot.operationId, provider.accountId])).rows[0];
          if (!owned) throw new Error("STRIPE_CALLBACK_PAYMENT_UNAVAILABLE");
          const payment = await readProviderPaymentInTransaction(client, owned.owner_wallet_id, snapshot.operationId);
          if (!payment.authorizationRequired || payment.firstSubmissionAtMs === null || payment.fingerprint !== snapshot.fingerprint)
            throw new Error("STRIPE_CALLBACK_CORRELATION_CONFLICT");
          const observed = snapshot.observe(payment);
          // Pure compatibility validation catches contradictory terminal outcomes without posting money.
          advanceProviderPayment(payment, { type: "provider_observed", observation: observed }, Math.max(payment.updatedAtMs, Date.now()));
          const conflicting = await client.query(`SELECT 1 FROM rail_stripe_callback_inbox WHERE stripe_account_id=$1 AND operation_id=$2
            AND request_fingerprint=$3 AND processing_result='matched' AND payment_intent_id<>$4 LIMIT 1`,
          [provider.accountId, snapshot.operationId, snapshot.fingerprint, item.payment_intent_id]);
          if (conflicting.rowCount) throw new Error("STRIPE_CALLBACK_CORRELATION_CONFLICT");
          await client.query(`UPDATE outbox SET next_attempt_at=clock_timestamp()
            WHERE provider_operation_id=$1 AND delivery_status='pending'`, [snapshot.operationId]);
        }
        const saved = await client.query(`UPDATE rail_stripe_callback_inbox SET processed_at=clock_timestamp(),
          processing_result=$4,operation_id=$5,request_fingerprint=$6,lease_id=NULL,lease_expires_at=NULL,last_error=NULL
          WHERE stripe_account_id=$1 AND event_id=$2 AND lease_id=$3 AND lease_expires_at>clock_timestamp()`,
        [provider.accountId, item.event_id, lease, snapshot ? "matched" : "unrelated", snapshot?.operationId ?? null, snapshot?.fingerprint ?? null]);
        if (saved.rowCount !== 1) throw new Error("STRIPE_CALLBACK_LEASE_LOST");
        return Boolean(snapshot);
      });
      if (finished === null) stats.lostLease++; else if (finished) stats.processed++; else stats.ignored++;
    } catch (error) {
      const reason = error instanceof Error && ["CONFLICTING_PROVIDER_OUTCOME", "STRIPE_CALLBACK_CORRELATION_CONFLICT",
        "STRIPE_CALLBACK_PAYMENT_UNAVAILABLE", "STRIPE_CALLBACK_TIMEOUT", "STRIPE_CALLBACK_LOOKUP_UNAVAILABLE",
        "STRIPE_OBSERVATION_MISMATCH", "STRIPE_ACCOUNT_UNAVAILABLE"].includes(error.message)
        ? error.message.toLowerCase() : "stripe_callback_reconciliation_pending";
      const reset = await pool.query(`UPDATE rail_stripe_callback_inbox SET lease_id=NULL,lease_expires_at=NULL,
        next_attempt_at=clock_timestamp()+$4*interval '1 millisecond',last_error=$5
        WHERE stripe_account_id=$1 AND event_id=$2 AND lease_id=$3 AND lease_expires_at>clock_timestamp() AND processed_at IS NULL`,
      [provider.accountId, item.event_id, lease, policy.retryDelayMs, reason]);
      if (reset.rowCount === 1) stats.pending++; else stats.lostLease++;
    } finally { if (timer) clearTimeout(timer); }
  }
  return stats;
}
