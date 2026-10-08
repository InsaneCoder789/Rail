import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OutboxEvent } from "../pipeline/outbox.js";

export interface DurableOutboxEvent extends OutboxEvent {
  readonly deliveryId: string;
}

export interface DeliveryPolicy {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly deliveryTimeoutMs: number;
}

const defaults: DeliveryPolicy = { batchSize: 50, leaseMs: 30_000, maxAttempts: 5, retryDelayMs: 1000, deliveryTimeoutMs: 10_000 };

/** At-least-once delivery. Receivers must deduplicate deliveryId, including after a worker crash. */
export async function dispatchOutboxBatch(
  pool: Pool,
  deliver: (event: DurableOutboxEvent, signal: AbortSignal) => Promise<void>,
  options: Partial<DeliveryPolicy> = {},
): Promise<{ delivered: number; failed: number; lostLease: number }> {
  const policy = { ...defaults, ...options };
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      policy.deliveryTimeoutMs >= policy.leaseMs || policy.batchSize > 1000) throw new Error("INVALID_DELIVERY_POLICY");
  const stats = { delivered: 0, failed: 0, lostLease: 0 };
  // Claim one at a time so a sequential batch cannot outlive leases acquired for its later events.
  for (let index = 0; index < policy.batchSize; index++) {
    await pool.query(
      `UPDATE outbox SET delivery_status = 'dead_letter', lease_id = NULL, lease_expires_at = NULL,
         last_delivery_error = 'lease_expired_at_attempt_limit'
       WHERE delivery_status = 'processing' AND lease_expires_at <= NOW() AND delivery_attempts >= $1`,
      [policy.maxAttempts]);
    const leaseId = randomUUID();
    const claimed = await pool.query(
      `WITH candidate AS (
         SELECT id FROM outbox
         WHERE delivery_attempts < $1 AND
           ((delivery_status = 'pending' AND next_attempt_at <= NOW()) OR
            (delivery_status = 'processing' AND lease_expires_at <= NOW()))
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
       ) UPDATE outbox event SET delivery_status = 'processing', delivery_attempts = delivery_attempts + 1,
           lease_id = $2::uuid, lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
         FROM candidate WHERE event.id = candidate.id
         RETURNING event.id, event.type, event.payload, event.occurred_at, event.delivery_attempts`,
      [policy.maxAttempts, leaseId, policy.leaseMs]);
    const row = claimed.rows[0];
    if (!row) break;
    const signal = AbortSignal.timeout(policy.deliveryTimeoutMs);
    try {
      // The timeout race bounds the lease even when a misbehaving adapter ignores AbortSignal.
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new Error("delivery_timeout"));
        signal.addEventListener("abort", aborted, { once: true });
        Promise.resolve().then(() => deliver({ deliveryId: String(row.id), type: row.type,
          payload: row.payload, occurredAt: new Date(row.occurred_at).toISOString() }, signal))
          .then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      });
      const acknowledged = await pool.query(
        `UPDATE outbox SET delivery_status = 'delivered', delivered_at = NOW(),
           lease_id = NULL, lease_expires_at = NULL, last_delivery_error = NULL
         WHERE id = $1 AND lease_id = $2::uuid AND delivery_status = 'processing'`, [row.id, leaseId]);
      if (acknowledged.rowCount === 1) stats.delivered++;
      else stats.lostLease++;
    } catch {
      const failed = await pool.query(
        `UPDATE outbox SET delivery_status = CASE WHEN delivery_attempts >= $3 THEN 'dead_letter' ELSE 'pending' END,
           next_attempt_at = NOW() + ($4 * INTERVAL '1 millisecond'), lease_id = NULL,
           lease_expires_at = NULL, last_delivery_error = 'delivery_failed'
         WHERE id = $1 AND lease_id = $2::uuid AND delivery_status = 'processing'`,
        [row.id, leaseId, policy.maxAttempts, Math.min(60_000, policy.retryDelayMs * 2 ** Math.min(row.delivery_attempts - 1, 16))]);
      if (failed.rowCount === 1) stats.failed++;
      else stats.lostLease++;
    }
  }
  return stats;
}
