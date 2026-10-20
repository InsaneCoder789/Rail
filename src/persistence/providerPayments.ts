import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { advanceProviderPayment, createProviderPayment, parseProviderPaymentBinding, providerBudgetDisposition, providerPaymentConsentPayload,
  providerPaymentConsentFingerprint,
  providerPaymentFingerprint, type ProviderPayment, type ProviderPaymentBinding, type ProviderPaymentEvent } from "../domain/providerPayment.js";
import type { OwnerPasskeyStore } from "./ownerPasskeys.js";
import type { AgentEvidenceStore } from "./agentEvidence.js";
import type { OwnerPrincipal } from "../server/types.js";
import { requireSharedBudget } from "./sharedBudgets.js";
import { withTransactionSavepoint } from "./transaction.js";
import { ProviderTargetRegistry, parseProviderTarget, providerTargetFingerprint } from "../domain/providerTargets.js";
import { RequestError } from "../server/http.js";
import { isCurrency, isRecord, isSafeText, isValidAmountMinor } from "../server/validation.js";

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
}, event: ProviderPaymentEvent, targets?: ProviderTargetRegistry): Promise<ProviderPaymentRecord> {
  const { operationId, ownerWalletId, fingerprint } = identity;
  const snapshot = structuredClone(event);
  return withTransactionSavepoint(client, async () => {
    const lookup = await client.query("SELECT * FROM rail_provider_payments WHERE operation_id=$1 AND owner_wallet_id=$2", [operationId, ownerWalletId]);
    if (lookup.rows[0]?.authorization_required) {
      const binding = parseProviderPaymentBinding(lookup.rows[0].binding);
      await lockProviderAuthority(client, binding, snapshot.type === "begin_submission" || snapshot.type === "retry_submission");
      if (snapshot.type === "begin_submission" || snapshot.type === "retry_submission") {
        const proposal = await client.query("SELECT target_snapshot FROM rail_provider_proposals WHERE operation_id=$1", [operationId]);
        if (proposal.rows[0]) (targets ?? new ProviderTargetRegistry()).requireCurrent(parseProviderTarget(proposal.rows[0].target_snapshot));
      }
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

export async function requireProviderSubmission(client: PoolClient, operationId: string, targets: ProviderTargetRegistry) {
  const found = await client.query(`SELECT payment.*,proposal.target_snapshot FROM rail_provider_payments payment
    JOIN rail_provider_proposals proposal USING(operation_id) WHERE operation_id=$1`, [operationId]);
  const row = found.rows[0];
  if (!row?.authorization_required) throw new Error("PROVIDER_ADMITTED_PROPOSAL_REQUIRED");
  const payment = restore(row);
  await lockProviderAuthority(client, payment.binding, true);
  targets.requireCurrent(parseProviderTarget(row.target_snapshot));
  if (Date.parse(payment.binding.authorizationExpiresAt) <= await databaseTime(client)) throw new Error("PROVIDER_AUTHORIZATION_EXPIRED");
  return payment;
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

export interface ProviderProposalRequest {
  readonly mandateId: string; readonly clientRequestId: string; readonly targetId: string;
  readonly amountMinor: number; readonly currency: string; readonly ttlSeconds: number;
}

export function parseProviderProposalRequest(value: unknown): ProviderProposalRequest {
  if (!isRecord(value) || Object.keys(value).some(key => !["mandateId", "clientRequestId", "targetId", "amountMinor", "currency", "ttlSeconds"].includes(key)) ||
      typeof value.mandateId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.mandateId) ||
      !isSafeText(value.clientRequestId, 8, 128) || typeof value.targetId !== "string" || !/^[A-Za-z0-9_.:-]{3,128}$/.test(value.targetId) ||
      !isValidAmountMinor(value.amountMinor) || !isCurrency(value.currency)) throw new RequestError(422, "invalid_provider_proposal", "invalid provider proposal");
  const seconds = value.ttlSeconds ?? 300;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > 900)
    throw new RequestError(422, "invalid_provider_proposal", "invalid provider proposal lifetime");
  return Object.freeze({ mandateId: value.mandateId, clientRequestId: value.clientRequestId, targetId: value.targetId,
    amountMinor: value.amountMinor, currency: value.currency, ttlSeconds: seconds });
}

export function providerProposalView(row: Record<string, unknown>, owner = false) {
  const binding = parseProviderPaymentBinding(row.binding), target = parseProviderTarget(row.target_snapshot);
  if (providerPaymentFingerprint(binding) !== row.binding_fingerprint || providerTargetFingerprint(target) !== row.target_fingerprint)
    throw new Error("PROVIDER_PROPOSAL_CORRUPT");
  return { operationId: binding.operationId, intentId: binding.intentId, agentId: binding.agentId, mandateId: binding.mandateId,
    clientRequestId: String(row.client_request_id), targetId: target.targetId, targetRevision: target.revision,
    amountMinor: binding.amountMinor, currency: binding.currency, requestFingerprint: String(row.binding_fingerprint),
    expiresAt: binding.authorizationExpiresAt, status: row.operation_status ? String(row.operation_status) : "awaiting_owner_approval",
    ...(owner ? { binding, merchantWalletId: target.merchantWalletId,
      consentFingerprint: providerPaymentConsentFingerprint(binding, target.merchantWalletId) } : {}) };
}

/** Credential/proof admission must already be claimed by the caller in this transaction. No budget is held yet. */
export async function prepareProviderProposalInTransaction(client: PoolClient, input: ProviderProposalRequest, identity: {
  readonly agentId: string; readonly ownerWalletId: string; readonly credentialId: string; readonly proofId: string; readonly keyThumbprint: string;
}, targets: ProviderTargetRegistry, evidence: AgentEvidenceStore, stepUpRequired: boolean) {
  const request = parseProviderProposalRequest(input), agent = { ...identity };
  const proposalFingerprint = createHash("sha256").update(JSON.stringify(["rail:provider-request:v1", agent.agentId, request.mandateId,
    request.clientRequestId, request.targetId, request.amountMinor, request.currency, request.ttlSeconds])).digest("hex");
  const previous = await client.query("SELECT * FROM rail_provider_proposals WHERE agent_id=$1 AND client_request_id=$2", [agent.agentId, request.clientRequestId]);
  if (previous.rows[0]) {
    if (previous.rows[0].proposal_fingerprint !== proposalFingerprint) throw new RequestError(409, "provider_request_reused", "request ID is bound to different provider terms");
    const status = await client.query("SELECT status AS operation_status FROM rail_provider_payments WHERE operation_id=$1", [previous.rows[0].operation_id]);
    return providerProposalView({ ...previous.rows[0], ...status.rows[0] });
  }
  const target = targets.resolve(request.targetId, agent.ownerWalletId, request.currency);
  const policy = await client.query("SELECT *,expires_at>clock_timestamp() AS valid FROM rail_agent_mandates WHERE mandate_id=$1 AND agent_id=$2 AND owner_wallet_id=$3 FOR UPDATE",
    [request.mandateId, agent.agentId, agent.ownerWalletId]);
  const mandate = policy.rows[0];
  if (!mandate?.valid || mandate.revoked_at || !mandate.shared_budget_id || mandate.currency !== request.currency ||
      Number(mandate.per_payment_limit_minor) < request.amountMinor || !mandate.allowed_receiver_wallet_ids.includes(target.merchantWalletId))
    throw new RequestError(403, "provider_policy_denied", "provider proposal is outside the current mandate");
  const consent = await evidence.verifyMandateConsent(client, request.mandateId);
  if ((consent.record.authentication as OwnerPrincipal | undefined)?.stepUp?.method !== "passkey")
    throw new RequestError(409, "provider_mandate_consent_required", "fresh owner mandate consent required");
  const budget = await requireSharedBudget(client, { budgetId: mandate.shared_budget_id, owner: agent.ownerWalletId,
    agentId: agent.agentId, currency: request.currency, stepUpRequired });
  const count = await client.query("SELECT count(*) FROM rail_provider_proposals WHERE agent_id=$1", [agent.agentId]);
  if (Number(count.rows[0].count) >= 1000) throw new RequestError(409, "provider_proposal_capacity", "retained provider proposal capacity reached");
  const time = await client.query("SELECT LEAST(clock_timestamp()+$1*interval '1 second',$2::timestamptz,$3::timestamptz) AS expires_at",
    [request.ttlSeconds, mandate.expires_at, budget.expires_at]);
  const operationId = randomUUID();
  const binding: ProviderPaymentBinding = { version: 1, operationId, intentId: randomUUID(), ownerWalletId: agent.ownerWalletId,
    agentId: agent.agentId, mandateId: request.mandateId, sharedBudgetId: mandate.shared_budget_id, provider: target.provider,
    providerAccountRef: target.providerAccountRef, instrumentRef: target.instrumentRef, merchantRef: target.merchantRef,
    amountMinor: request.amountMinor, currency: request.currency, requestFingerprint: proposalFingerprint,
    authorizationExpiresAt: new Date(time.rows[0].expires_at).toISOString() };
  if (Date.parse(binding.authorizationExpiresAt) <= await databaseTime(client))
    throw new RequestError(409, "provider_proposal_expired", "provider proposal expired before persistence");
  const row = await client.query(`INSERT INTO rail_provider_proposals(operation_id,agent_id,owner_wallet_id,mandate_id,shared_budget_id,
      client_request_id,proposal_fingerprint,binding,binding_fingerprint,target_snapshot,target_fingerprint,credential_id,proof_id,key_thumbprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14) RETURNING *`,
  [operationId, agent.agentId, agent.ownerWalletId, request.mandateId, mandate.shared_budget_id, request.clientRequestId, proposalFingerprint,
    JSON.stringify(binding), providerPaymentFingerprint(binding), JSON.stringify(target), providerTargetFingerprint(target),
    agent.credentialId, agent.proofId, agent.keyThumbprint]);
  return providerProposalView(row.rows[0]);
}
