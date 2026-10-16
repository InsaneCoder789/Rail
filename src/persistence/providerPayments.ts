import type { PoolClient } from "pg";
import { advanceProviderPayment, createProviderPayment, parseProviderPaymentBinding, providerBudgetDisposition, providerPaymentConsentPayload,
  providerPaymentConsentFingerprint,
  providerPaymentFingerprint, type ProviderPayment, type ProviderPaymentBinding, type ProviderPaymentEvent } from "../domain/providerPayment.js";
import type { OwnerPasskeyStore } from "./ownerPasskeys.js";
import type { AgentEvidenceStore } from "./agentEvidence.js";
import type { OwnerPrincipal } from "../server/types.js";
import { requireSharedBudget } from "./sharedBudgets.js";
import { withTransactionSavepoint } from "./transaction.js";

export interface ProviderPaymentRecord extends ProviderPayment {
  readonly revision: number;
  readonly attemptNumber: number;
  readonly authorizationRequired: boolean;
}

function restore(row: Record<string, unknown>): ProviderPaymentRecord {
  const binding = parseProviderPaymentBinding(row.binding);
  if (providerPaymentFingerprint(binding) !== row.fingerprint || row.idempotency_key !== `rail_provider_v1_${binding.operationId}`)
    throw new Error("PROVIDER_PAYMENT_JOURNAL_CORRUPT");
  const status = row.status as ProviderPayment["status"];
  providerBudgetDisposition(status);
  return Object.freeze({ binding, fingerprint: String(row.fingerprint), idempotencyKey: String(row.idempotency_key), status,
    providerRef: row.provider_ref === null ? null : String(row.provider_ref),
    firstSubmissionAtMs: row.first_submission_at_ms === null ? null : Number(row.first_submission_at_ms),
    retryWindowEndsAtMs: row.retry_window_ends_at_ms === null ? null : Number(row.retry_window_ends_at_ms),
    updatedAtMs: Number(row.updated_at_ms), revision: Number(row.revision), attemptNumber: Number(row.attempt_number),
    authorizationRequired: row.authorization_required === true });
}

async function databaseTime(client: PoolClient): Promise<number> {
  const result = await client.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms");
  return Number(result.rows[0].now_ms);
}

/** Server-only journal primitives. Caller owns BEGIN/COMMIT and any authority/budget composition. */
export async function createProviderPaymentInTransaction(client: PoolClient, value: ProviderPaymentBinding,
  options: { readonly authorizationRequired: boolean } = { authorizationRequired: false }): Promise<ProviderPaymentRecord> {
  const binding = parseProviderPaymentBinding(value), fingerprint = providerPaymentFingerprint(binding);
  const required = options.authorizationRequired;
  return withTransactionSavepoint(client, async () => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`provider-operation:${binding.operationId}`]);
    const existing = await client.query("SELECT * FROM rail_provider_payments WHERE operation_id=$1 FOR UPDATE", [binding.operationId]);
    if (existing.rows[0]) {
      const original = restore(existing.rows[0]);
      if (original.fingerprint !== fingerprint || original.authorizationRequired !== required) throw new Error("PROVIDER_PAYMENT_BINDING_REUSED");
      return original;
    }
    const payment = createProviderPayment(binding, await databaseTime(client));
    const inserted = await client.query(`INSERT INTO rail_provider_payments(operation_id,owner_wallet_id,agent_id,mandate_id,
        shared_budget_id,intent_id,binding,fingerprint,idempotency_key,status,updated_at_ms,revision,attempt_number,last_event,authorization_required)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'reserved',$10,1,0,'created',$11) RETURNING *`,
    [binding.operationId, binding.ownerWalletId, binding.agentId, binding.mandateId, binding.sharedBudgetId, binding.intentId,
      JSON.stringify(binding), fingerprint, payment.idempotencyKey, payment.updatedAtMs, required]);
    return restore(inserted.rows[0]);
  });
}

/** No network I/O belongs inside this function or its caller's financial transaction. */
export async function advanceProviderPaymentInTransaction(client: PoolClient, identity: {
  readonly operationId: string; readonly ownerWalletId: string; readonly fingerprint: string;
}, event: ProviderPaymentEvent): Promise<ProviderPaymentRecord> {
  const { operationId, ownerWalletId, fingerprint } = identity;
  const snapshot = structuredClone(event);
  return withTransactionSavepoint(client, async () => {
    const lookup = await client.query("SELECT * FROM rail_provider_payments WHERE operation_id=$1 AND owner_wallet_id=$2", [operationId, ownerWalletId]);
    if (lookup.rows[0]?.authorization_required) {
      const binding = parseProviderPaymentBinding(lookup.rows[0].binding);
      await lockProviderAuthority(client, binding, snapshot.type === "begin_submission" || snapshot.type === "retry_submission");
    }
    const found = await client.query("SELECT * FROM rail_provider_payments WHERE operation_id=$1 AND owner_wallet_id=$2 FOR UPDATE",
      [operationId, ownerWalletId]);
    if (!found.rows[0]) throw new Error("PROVIDER_PAYMENT_NOT_FOUND");
    const current = restore(found.rows[0]);
    if (current.fingerprint !== fingerprint) throw new Error("PROVIDER_PAYMENT_BINDING_REUSED");
    // Obtain time after the lock: waiting must not extend admission or provider retry windows.
    const next = advanceProviderPayment(current, snapshot, await databaseTime(client));
    if (next === current) return current;
    const attemptNumber = current.attemptNumber + (snapshot.type === "begin_submission" || snapshot.type === "retry_submission" ? 1 : 0);
    const changed = await client.query(`UPDATE rail_provider_payments SET status=$2,provider_ref=$3,first_submission_at_ms=$4,
        retry_window_ends_at_ms=$5,updated_at_ms=$6,revision=revision+1,attempt_number=$7,last_event=$8
      WHERE operation_id=$1 RETURNING *`,
    [operationId, next.status, next.providerRef, next.firstSubmissionAtMs, next.retryWindowEndsAtMs,
      next.updatedAtMs, attemptNumber, snapshot.type]);
    return restore(changed.rows[0]);
  });
}

/** Lock order matches owner recovery and internal dispatch. Reconciliation never requires live spending authority. */
async function lockProviderAuthority(client: PoolClient, binding: ProviderPaymentBinding, submitting: boolean) {
  const owners = await client.query("SELECT user_id,auth_version,owner_recovery_pending FROM users WHERE wallet_id=$1 ORDER BY user_id FOR UPDATE", [binding.ownerWalletId]);
  const agent = await client.query("SELECT status FROM rail_agents WHERE agent_id=$1 AND owner_wallet_id=$2 FOR UPDATE", [binding.agentId, binding.ownerWalletId]);
  const mandate = await client.query("SELECT *,expires_at>clock_timestamp() AS valid FROM rail_agent_mandates WHERE mandate_id=$1 FOR UPDATE", [binding.mandateId]);
  if (!agent.rows[0] || !mandate.rows[0]) throw new Error("PROVIDER_AUTHORITY_UNAVAILABLE");
  if (submitting) {
    if (owners.rowCount !== 1 || owners.rows[0].owner_recovery_pending || agent.rows[0].status !== "active" ||
        mandate.rows[0].revoked_at || !mandate.rows[0].valid) throw new Error("PROVIDER_AUTHORITY_WITHDRAWN");
    await requireSharedBudget(client, { budgetId: binding.sharedBudgetId, owner: binding.ownerWalletId,
      agentId: binding.agentId, currency: binding.currency, stepUpRequired: true });
    const consent = await client.query(`SELECT 1 FROM rail_provider_payment_consents consent
      JOIN rail_owner_step_up_grants permission ON permission.challenge_id=consent.challenge_id
      JOIN rail_owner_passkeys key ON key.credential_id=permission.credential_id
      WHERE consent.operation_id=$1 AND permission.user_id=$2 AND permission.auth_version=$3 AND key.revoked_at IS NULL`,
    [binding.operationId, owners.rows[0].user_id, owners.rows[0].auth_version]);
    if (!consent.rowCount) throw new Error("PROVIDER_AUTHORITY_WITHDRAWN");
  } else {
    await client.query("SELECT budget_id FROM rail_shared_budgets WHERE budget_id=$1 FOR UPDATE", [binding.sharedBudgetId]);
  }
  return mandate.rows[0];
}

/** Trusted coordinator only: resolve provider/instrument/merchant ownership before calling. No agent-supplied mappings. */
export async function authorizeProviderPaymentInTransaction(client: PoolClient, input: {
  readonly binding: ProviderPaymentBinding; readonly trustedMerchantWalletId: string;
  readonly principal: OwnerPrincipal; readonly grantToken: unknown;
}, passkeys: OwnerPasskeyStore, evidence: AgentEvidenceStore): Promise<ProviderPaymentRecord> {
  const binding = parseProviderPaymentBinding(input.binding), merchant = input.trustedMerchantWalletId;
  const principal = { ...input.principal }, token = input.grantToken;
  const canonical = providerPaymentConsentPayload(binding, merchant), digest = providerPaymentConsentFingerprint(binding, merchant);
  if (principal.method !== "owner_jwt" || principal.walletId !== binding.ownerWalletId || !principal.userId ||
      !Number.isSafeInteger(principal.authVersion) || !/^[a-f0-9]{64}$/.test(principal.sessionFingerprint ?? ""))
    throw new Error("PROVIDER_OWNER_AUTHENTICATION_REQUIRED");
  return withTransactionSavepoint(client, async () => {
    const owner = await client.query("SELECT user_id FROM users WHERE user_id=$1 AND wallet_id=$2 AND auth_version=$3 AND NOT owner_recovery_pending FOR UPDATE",
      [principal.userId, principal.walletId, principal.authVersion]);
    if (!owner.rowCount) throw new Error("PROVIDER_OWNER_AUTHENTICATION_REQUIRED");
    const previous = await client.query(`SELECT payment.*,consent.operation_fingerprint AS consent_fingerprint
      FROM rail_provider_payments payment LEFT JOIN rail_provider_payment_consents consent USING(operation_id)
      WHERE payment.operation_id=$1`, [binding.operationId]);
    if (previous.rows[0]) {
      if (!previous.rows[0].authorization_required || previous.rows[0].fingerprint !== providerPaymentFingerprint(binding) || previous.rows[0].consent_fingerprint !== digest)
        throw new Error("PROVIDER_PAYMENT_BINDING_REUSED");
      return restore(previous.rows[0]);
    }
    const grant = await passkeys.consumeGrant(client, principal, token, "provider_payment", digest);
    const agent = await client.query("SELECT status FROM rail_agents WHERE agent_id=$1 AND owner_wallet_id=$2 FOR UPDATE", [binding.agentId, binding.ownerWalletId]);
    const policy = await client.query("SELECT *,expires_at>clock_timestamp() AS valid FROM rail_agent_mandates WHERE mandate_id=$1 AND agent_id=$2 AND owner_wallet_id=$3 FOR UPDATE",
      [binding.mandateId, binding.agentId, binding.ownerWalletId]);
    const mandate = policy.rows[0];
    if (agent.rows[0]?.status !== "active" || !mandate?.valid || mandate.revoked_at || mandate.shared_budget_id !== binding.sharedBudgetId ||
        mandate.currency !== binding.currency || Number(mandate.per_payment_limit_minor) < binding.amountMinor ||
        !mandate.allowed_receiver_wallet_ids.includes(merchant) || Date.parse(binding.authorizationExpiresAt) > new Date(mandate.expires_at).getTime())
      throw new Error("PROVIDER_POLICY_DENIED");
    const consent = await evidence.verifyMandateConsent(client, binding.mandateId);
    const authentication = consent.record.authentication as OwnerPrincipal | undefined;
    if (authentication?.stepUp?.method !== "passkey") throw new Error("PROVIDER_FRESH_MANDATE_CONSENT_REQUIRED");
    const budget = await requireSharedBudget(client, { budgetId: binding.sharedBudgetId, owner: binding.ownerWalletId,
      agentId: binding.agentId, currency: binding.currency, stepUpRequired: true });
    if (Date.parse(binding.authorizationExpiresAt) > new Date(budget.expires_at).getTime()) throw new Error("PROVIDER_POLICY_DENIED");
    const payment = await createProviderPaymentInTransaction(client, binding, { authorizationRequired: true });
    await client.query(`INSERT INTO rail_provider_payment_consents(operation_id,merchant_wallet_id,challenge_id,canonical_payload,operation_fingerprint)
      VALUES($1,$2,$3,$4,$5)`, [binding.operationId, merchant, grant.challengeId, canonical, digest]);
    return payment;
  });
}

/** Revocation/expiry can cancel only definitely unsubmitted payments, never an unresolved external effect. */
export async function cancelUnsubmittedProviderPayments(client: PoolClient, input: {
  readonly agentIds: readonly string[]; readonly mandateId?: string; readonly budgetId?: string; readonly onlyExpired?: boolean;
}): Promise<void> {
  await client.query(`UPDATE rail_provider_payments payment SET status='cancelled',revision=revision+1,
      last_event='cancel_before_submission',updated_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
    WHERE payment.agent_id=ANY($1::uuid[]) AND payment.authorization_required AND payment.status='reserved'
      AND ($2::uuid IS NULL OR payment.mandate_id=$2) AND ($3::uuid IS NULL OR payment.shared_budget_id=$3)
      AND (NOT $4::boolean OR (payment.binding->>'authorizationExpiresAt')::timestamptz<=clock_timestamp()
        OR EXISTS(SELECT 1 FROM rail_agent_mandates mandate JOIN rail_shared_budgets budget ON budget.budget_id=mandate.shared_budget_id
          WHERE mandate.mandate_id=payment.mandate_id AND (mandate.expires_at<=clock_timestamp() OR budget.expires_at<=clock_timestamp())))`,
  [input.agentIds, input.mandateId ?? null, input.budgetId ?? null, input.onlyExpired ?? false]);
}

export async function readProviderPaymentInTransaction(client: PoolClient, ownerWalletId: string, operationId: string): Promise<ProviderPaymentRecord> {
  const found = await client.query("SELECT * FROM rail_provider_payments WHERE operation_id=$1 AND owner_wallet_id=$2", [operationId, ownerWalletId]);
  if (!found.rows[0]) throw new Error("PROVIDER_PAYMENT_NOT_FOUND");
  return restore(found.rows[0]);
}
