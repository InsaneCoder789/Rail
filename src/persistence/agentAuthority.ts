import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isCurrency, isRecord, isSafeText, isValidAmountMinor } from "../server/validation.js";
import { RequestError } from "../server/http.js";
import type { PaymentPipelineEngine } from "../pipeline/engine.js";
import type { PaymentTransaction } from "../domain/types.js";
import { createAuthorizationInTransaction } from "../stages/authorizationStage.js";
import { signTransactionHmac } from "../crypto/transactionSigning.js";
import type { AgentEvidenceStore } from "./agentEvidence.js";
import type { OwnerPrincipal } from "../server/types.js";
import { MerchantQuoteRegistry, parseMerchantQuoteProof } from "../crypto/merchantQuotes.js";
import type { OwnerPasskeyStore, OwnerOperation } from "./ownerPasskeys.js";
import { agentKeyThumbprint, parseAgentPublicKey, type AgentPublicKey } from "../crypto/agentProof.js";
import { dispatchAgentAdmission, type AgentAdmission } from "./agentProofs.js";
import { isBudgetId, mapSharedBudget, parseSharedBudgetInput, requireSharedBudget, sharedBudgetOperationFingerprint,
  sharedBudgetOperationPayload, type SharedBudgetAction } from "./sharedBudgets.js";
import { cancelUnsubmittedProviderPayments } from "./providerPayments.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

function invalid(): never { throw new RequestError(422, "invalid_agent_request", "invalid agent request"); }
export function isAgentId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function ttl(value: unknown): number {
  const seconds = value === undefined ? 86400 : value;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > MAX_TTL_SECONDS) invalid();
  return seconds;
}

export interface MandateInput {
  readonly sharedBudgetId?: string;
  readonly mode: "approval_required" | "budgeted";
  readonly currency: string;
  readonly perPaymentLimitMinor: number;
  readonly totalBudgetMinor: number;
  readonly allowedReceiverWalletIds: readonly string[];
  readonly ttlSeconds: number;
}

export interface AgentCheckout {
  readonly version: 1;
  readonly merchantWalletId: string;
  readonly quoteId: string;
  readonly quoteVersion: number;
  readonly subtotalMinor: number;
  readonly feeMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly expiresAt: string;
  readonly fundingSource: { readonly type: "internal_wallet"; readonly walletId: string };
}

export function parseAgentCheckout(value: unknown): AgentCheckout {
  const keys = ["version", "merchantWalletId", "quoteId", "quoteVersion", "subtotalMinor", "feeMinor", "totalMinor", "currency", "expiresAt", "fundingSource"];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      value.version !== 1 || !isSafeText(value.merchantWalletId, 3, 128) || !isSafeText(value.quoteId, 3, 128) ||
      typeof value.quoteVersion !== "number" || !Number.isSafeInteger(value.quoteVersion) || value.quoteVersion < 1 || value.quoteVersion > 1_000_000 ||
      !isValidAmountMinor(value.subtotalMinor) || !isValidAmountMinor(value.totalMinor) || typeof value.feeMinor !== "number" ||
      !Number.isSafeInteger(value.feeMinor) || value.feeMinor < 0 || value.feeMinor > 1e12 || value.subtotalMinor + value.feeMinor !== value.totalMinor ||
      !isCurrency(value.currency) || typeof value.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt) ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) < 0 || new Date(value.expiresAt).toISOString() !== value.expiresAt ||
      !isRecord(value.fundingSource) || Object.keys(value.fundingSource).length !== 2 || value.fundingSource.type !== "internal_wallet" ||
      !isSafeText(value.fundingSource.walletId, 3, 128)) invalid();
  return Object.freeze({ version: 1, merchantWalletId: value.merchantWalletId, quoteId: value.quoteId, quoteVersion: value.quoteVersion,
    subtotalMinor: value.subtotalMinor, feeMinor: value.feeMinor, totalMinor: value.totalMinor, currency: value.currency,
    expiresAt: value.expiresAt, fundingSource: Object.freeze({ type: "internal_wallet", walletId: value.fundingSource.walletId }) });
}

// JSONB does not preserve object key order; fingerprints use an explicit tuple.
function checkoutTuple(value: AgentCheckout): readonly unknown[] {
  return [value.version, value.merchantWalletId, value.quoteId, value.quoteVersion, value.subtotalMinor, value.feeMinor,
    value.totalMinor, value.currency, value.expiresAt, value.fundingSource.type, value.fundingSource.walletId];
}

export function parseMandateInput(value: unknown): MandateInput {
  if (!isRecord(value) || (value.mode !== "approval_required" && value.mode !== "budgeted") || !isCurrency(value.currency) ||
      !isValidAmountMinor(value.perPaymentLimitMinor) || !isValidAmountMinor(value.totalBudgetMinor) ||
      value.perPaymentLimitMinor > value.totalBudgetMinor || !Array.isArray(value.allowedReceiverWalletIds) ||
      value.allowedReceiverWalletIds.length < 1 || value.allowedReceiverWalletIds.length > 20 ||
      !value.allowedReceiverWalletIds.every(item => isSafeText(item, 3, 128)) ||
      new Set(value.allowedReceiverWalletIds).size !== value.allowedReceiverWalletIds.length ||
      (value.sharedBudgetId !== undefined && !isBudgetId(value.sharedBudgetId))) invalid();
  return { mode: value.mode as MandateInput["mode"], currency: value.currency,
    perPaymentLimitMinor: value.perPaymentLimitMinor, totalBudgetMinor: value.totalBudgetMinor,
    allowedReceiverWalletIds: [...value.allowedReceiverWalletIds], ttlSeconds: ttl(value.ttlSeconds),
    ...(value.sharedBudgetId === undefined ? {} : { sharedBudgetId: value.sharedBudgetId }) };
}

export function credentialOperationFingerprint(agentId: string, value: unknown): string {
  if (!isAgentId(agentId) || !isRecord(value)) invalid();
  const scope = value.scope ?? "payments:propose", seconds = ttl(value.ttlSeconds);
  if (scope !== "payments:propose" && scope !== "payments:execute") invalid();
  if (Object.hasOwn(value, "rotatedFromCredentialId")) {
    if (!isAgentId(value.rotatedFromCredentialId) || !Object.hasOwn(value, "publicKey")) invalid();
    return createHash("sha256").update(JSON.stringify(["rail:owner-operation:v3", "agent_credential_rotate", agentId,
      value.rotatedFromCredentialId, scope, seconds, agentKeyThumbprint(value.publicKey)])).digest("hex");
  }
  if (Object.hasOwn(value, "publicKey")) return createHash("sha256").update(JSON.stringify([
    "rail:owner-operation:v2", "agent_credential", agentId, scope, seconds, agentKeyThumbprint(value.publicKey)])).digest("hex");
  return createHash("sha256").update(JSON.stringify(["rail:owner-operation:v1", "agent_credential", agentId, scope, seconds])).digest("hex");
}
export function credentialRotationFingerprint(agentId: string, credentialId: string, value: unknown): string {
  if (!isAgentId(credentialId) || !isRecord(value) || !["payments:propose", "payments:execute"].includes(String(value.scope)) ||
      !Object.hasOwn(value, "ttlSeconds") || !Object.hasOwn(value, "publicKey") ||
      Object.keys(value).some(key => !["scope", "ttlSeconds", "publicKey", "grantToken"].includes(key))) invalid();
  return credentialOperationFingerprint(agentId, { ...value, rotatedFromCredentialId: credentialId });
}
export function mandateOperationFingerprint(agentId: string, value: unknown): string {
  if (!isAgentId(agentId)) invalid();
  const policy = parseMandateInput(value);
  return createHash("sha256").update(JSON.stringify([policy.sharedBudgetId ? "rail:owner-operation:v2" : "rail:owner-operation:v1", "agent_mandate", agentId, policy.mode, policy.currency,
    policy.perPaymentLimitMinor, policy.totalBudgetMinor, [...policy.allowedReceiverWalletIds].sort(), policy.ttlSeconds,
    ...(policy.sharedBudgetId ? [policy.sharedBudgetId] : [])])).digest("hex");
}
export function approvalOperationFingerprint(agentId: string, intentId: string, fingerprint: string): string {
  if (!isAgentId(agentId) || !isAgentId(intentId) || !/^[a-f0-9]{64}$/.test(fingerprint)) invalid();
  return createHash("sha256").update(JSON.stringify(["rail:owner-operation:v1", "agent_approval", agentId, intentId, fingerprint])).digest("hex");
}

function date(value: unknown): string { return (value instanceof Date ? value : new Date(String(value))).toISOString(); }
function mapAgent(row: Record<string, unknown>, enabled = false) {
  return { agentId: String(row.agent_id), name: String(row.name), status: String(row.status),
    createdAt: date(row.created_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null, executionEnabled: enabled && row.status === "active" };
}
function mapMandate(row: Record<string, unknown>, enabled = false, stepUpRequired = false) {
  return { mandateId: String(row.mandate_id), agentId: String(row.agent_id), mode: String(row.mode), currency: String(row.currency),
    ...(row.shared_budget_id ? { sharedBudgetId: String(row.shared_budget_id) } : {}),
    status: row.revoked_at ? "revoked" : row.expired === true ? "expired" : "active",
    perPaymentLimitMinor: Number(row.per_payment_limit_minor), totalBudgetMinor: Number(row.total_budget_minor),
    reservedBudgetMinor: Number(row.reserved_budget_minor),
    spentBudgetMinor: Number(row.spent_budget_minor),
    allowedReceiverWalletIds: row.allowed_receiver_wallet_ids as string[], createdAt: date(row.created_at),
    expiresAt: date(row.expires_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null,
    executionEnabled: enabled && !row.revoked_at && row.expired !== true && row.consent_receipt_version === 1 && (!stepUpRequired || Boolean(row.owner_step_up_challenge_id)) };
}

function mapIntent(row: Record<string, unknown>, enabled = false, stepUpRequired = false) {
  return { intentId: String(row.intent_id), agentId: String(row.agent_id), mandateId: String(row.mandate_id),
    ...(row.shared_budget_id ? { sharedBudgetId: String(row.shared_budget_id) } : {}),
    clientRequestId: String(row.client_request_id), requestFingerprint: String(row.request_fingerprint),
    senderWalletId: String(row.owner_wallet_id), receiverWalletId: String(row.receiver_wallet_id), amountMinor: Number(row.amount_minor),
    currency: String(row.currency), status: String(row.status), reason: row.terminal_reason ? String(row.terminal_reason) : null,
    ...(row.checkout ? { checkout: row.checkout, quoteAssurance: row.merchant_attestation ? "configured_merchant_signature" : "agent_proposed_unverified",
      ...(row.merchant_attestation ? { merchantAttestation: row.merchant_attestation } : {}) } : {}),
    createdAt: date(row.created_at), expiresAt: date(row.expires_at),
    paymentTxId: row.payment_tx_id ? String(row.payment_tx_id) : null, executedAt: row.executed_at ? date(row.executed_at) : null,
    executionEnabled: enabled && row.status === "approved" && row.authority_receipt_version === 1 && row.owner_evidence_version === 1 && (!stepUpRequired || row.owner_step_up_version === 1) };
}

/** Recovery calls this while holding the owner-user lock; committed money/history stays intact. */
export async function withdrawOwnerAgentAuthority(client: PoolClient, owner: string): Promise<number> {
  const agents = await client.query("SELECT agent_id FROM rail_agents WHERE owner_wallet_id=$1 ORDER BY agent_id FOR UPDATE", [owner]);
  const ids = agents.rows.map(row => String(row.agent_id));
  if (!ids.length) return 0;
  await cancelUnsubmittedProviderPayments(client, { agentIds: ids });
  const released = await client.query(`UPDATE rail_agent_intents SET status='rejected',terminal_reason='agent_revoked'
    WHERE agent_id=ANY($1::uuid[]) AND status IN ('pending','approved') RETURNING mandate_id,amount_minor`, [ids]);
  const totals = new Map<string, bigint>();
  for (const row of released.rows) totals.set(row.mandate_id, (totals.get(row.mandate_id) ?? 0n) + BigInt(row.amount_minor));
  for (const [mandateId, amount] of totals) {
    const changed = await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor=reserved_budget_minor-$2 WHERE mandate_id=$1 AND reserved_budget_minor>=$2 RETURNING mandate_id", [mandateId, amount.toString()]);
    if (changed.rowCount !== 1) throw new Error("agent_budget_reservation_mismatch");
  }
  await client.query("UPDATE rail_agent_credentials SET revoked_at=clock_timestamp() WHERE agent_id=ANY($1::uuid[]) AND revoked_at IS NULL", [ids]);
  await client.query("UPDATE rail_agent_mandates SET revoked_at=clock_timestamp() WHERE agent_id=ANY($1::uuid[]) AND revoked_at IS NULL", [ids]);
  await client.query("UPDATE rail_agents SET status='revoked',revoked_at=clock_timestamp() WHERE agent_id=ANY($1::uuid[]) AND status='active'", [ids]);
  return ids.length;
}

/** Agent credentials never resolve to owner JWTs or wallet API keys. */
export class AgentAuthorityStore {
  constructor(private readonly pool: Pool, private readonly engine?: PaymentPipelineEngine, private readonly authorityEvidence?: AgentEvidenceStore,
    private readonly merchantQuotes = new MerchantQuoteRegistry(),
    private readonly ownerControl?: { readonly required: boolean; readonly store?: OwnerPasskeyStore },
    private readonly proofControl?: { readonly required: boolean; readonly ready: boolean }) {}

  private get executionEnabled(): boolean {
    return Boolean(this.authorityEvidence) && (!this.ownerControl?.required || Boolean(this.ownerControl.store)) && (!this.proofControl?.required || this.proofControl.ready) &&
      this.engine?.supportsProtectedTransactions === true && (process.env.RAIL_SIGNING_SECRET ?? "").trim().length >= 32;
  }

  private async lockOwnerContext(client: PoolClient, owner: string, principal: OwnerPrincipal) {
    if (!this.ownerControl?.required) return;
    if (principal.method !== "owner_jwt" || principal.walletId !== owner || !principal.userId || !Number.isSafeInteger(principal.authVersion))
      throw new RequestError(401, "owner_authentication_required", "current owner session required");
    const row = await client.query("SELECT user_id,owner_recovery_pending FROM users WHERE user_id=$1 AND wallet_id=$2 AND auth_version=$3 FOR UPDATE", [principal.userId, owner, principal.authVersion]);
    if (!row.rowCount) throw new RequestError(401, "invalid_credentials", "owner session is stale");
    if (row.rows[0].owner_recovery_pending) throw new RequestError(403, "recovery_enrollment_required", "complete recovery enrollment first");
  }

  private async requireOwnerGrant(client: PoolClient, owner: string, principal: OwnerPrincipal, token: unknown, operation: OwnerOperation, fingerprint: string): Promise<OwnerPrincipal> {
    if (!this.ownerControl?.required) return principal;
    if (!this.ownerControl.store) throw new RequestError(503, "owner_step_up_unavailable", "configure owner passkeys before granting spending authority");
    await this.lockOwnerContext(client, owner, principal);
    const stepUp = await this.ownerControl.store.consumeGrant(client, principal, token, operation, fingerprint);
    return { ...principal, stepUp };
  }

  private requireSteppedConsent(record: Record<string, unknown>): void {
    const authentication = record.authentication as OwnerPrincipal | undefined;
    if (this.ownerControl?.required && authentication?.stepUp?.method !== "passkey")
      throw new RequestError(409, "fresh_owner_step_up_required", "replace legacy spending authority with passkey-authorized consent");
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally {
      client.release(discard);
      client.removeListener("error", onError);
    }
  }

  private async audit(client: PoolClient, type: string, walletId: string, fields: Record<string, unknown>): Promise<void> {
    await client.query("INSERT INTO outbox(type, payload) VALUES ($1, $2::jsonb)", [type, JSON.stringify({ walletId, ...fields })]);
  }

  private async ownedAgent(client: PoolClient, owner: string, agentId: string, active = true) {
    if (!isAgentId(agentId)) invalid();
    const result = await client.query("SELECT * FROM rail_agents WHERE agent_id = $1 AND owner_wallet_id = $2 FOR UPDATE", [agentId, owner]);
    const row = result.rows[0];
    if (!row) throw new RequestError(404, "agent_not_found", "agent not found");
    if (active && row.status !== "active") throw new RequestError(409, "agent_revoked", "agent is revoked");
    return row;
  }

  private async sharedControl(client: PoolClient, owner: string, budgetId: string, action: SharedBudgetAction,
    payload: string, principal: OwnerPrincipal) {
    const controlId = randomUUID();
    await client.query(`INSERT INTO rail_shared_budget_controls(control_id,budget_id,owner_wallet_id,action,canonical_payload,step_up_challenge_id,operation_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6::uuid,$7)`, [controlId, budgetId, owner, action, payload, principal.stepUp?.challengeId ?? null, createHash("sha256").update(payload).digest("hex")]);
    return controlId;
  }

  async createSharedBudget(owner: string, value: unknown, principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    const input = parseSharedBudgetInput(value), payload = sharedBudgetOperationPayload("create", null, input);
    const grantToken = isRecord(value) ? value.grantToken : undefined;
    return this.transaction(async client => {
      const authorized = await this.requireOwnerGrant(client, owner, principal, grantToken, "shared_budget", sharedBudgetOperationFingerprint("create", null, input));
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`shared-budget-owner:${owner}`]);
      const count = await client.query("SELECT count(*) FROM rail_shared_budgets WHERE owner_wallet_id=$1", [owner]);
      if (Number(count.rows[0].count) >= 50) throw new RequestError(409, "shared_budget_capacity", "retained shared budget capacity reached");
      for (const agentId of input.agentIds) await this.ownedAgent(client, owner, agentId);
      if (!(await client.query("SELECT 1 FROM wallets WHERE wallet_id=$1 AND currency=$2", [owner, input.currency])).rowCount)
        throw new RequestError(409, "shared_budget_currency_denied", "owner wallet currency does not match");
      const budgetId = randomUUID(), controlId = await this.sharedControl(client, owner, budgetId, "create", payload, authorized);
      const result = await client.query(`WITH instant AS(SELECT clock_timestamp() AS now)
        INSERT INTO rail_shared_budgets(budget_id,owner_wallet_id,name,currency,total_budget_minor,created_at,expires_at,created_control_id,current_control_id)
        SELECT $1,$2,$3,$4,$5,now,now+$6*interval '1 second',$7,$7 FROM instant RETURNING *`,
      [budgetId, owner, input.name, input.currency, input.totalBudgetMinor, input.ttlSeconds, controlId]);
      for (const agentId of input.agentIds) await client.query(`INSERT INTO rail_shared_budget_members(budget_id,agent_id,owner_wallet_id,created_control_id)
        VALUES($1,$2,$3,$4)`, [budgetId, agentId, owner, controlId]);
      await this.audit(client, "agent.shared_budget_created", owner, { budgetId, controlId, agentIds: input.agentIds });
      return mapSharedBudget(result.rows[0]);
    });
  }

  async listSharedBudgets(owner: string, principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    return this.transaction(async client => {
      await this.lockOwnerContext(client, owner, principal);
      const agents = await client.query("SELECT agent_id FROM rail_agents WHERE owner_wallet_id=$1 ORDER BY agent_id FOR UPDATE", [owner]);
      for (const row of agents.rows) await this.releaseIntents(client, row.agent_id, "expired", "deadline_expired");
      const budgets = await client.query("SELECT *,expires_at<=clock_timestamp() AS expired FROM rail_shared_budgets WHERE owner_wallet_id=$1 ORDER BY created_at,budget_id LIMIT 50", [owner]);
      const members = await client.query("SELECT budget_id,agent_id,revoked_at FROM rail_shared_budget_members WHERE owner_wallet_id=$1 ORDER BY budget_id,agent_id", [owner]);
      return budgets.rows.map(row => ({ ...mapSharedBudget(row), members: members.rows.filter(member => member.budget_id === row.budget_id)
        .map(member => ({ agentId: String(member.agent_id), status: member.revoked_at ? "revoked" : "active" })) }));
    });
  }

  async changeSharedBudget(owner: string, budgetId: string, action: Exclude<SharedBudgetAction, "create">, value: unknown,
    principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    const payload = sharedBudgetOperationPayload(action, budgetId, value);
    const input = structuredClone(value) as Record<string, unknown>;
    return this.transaction(async client => {
      await this.lockOwnerContext(client, owner, principal);
      const authorized = action === "limit" || action === "member_add"
        ? await this.requireOwnerGrant(client, owner, principal, input.grantToken, "shared_budget", createHash("sha256").update(payload).digest("hex")) : principal;
      // All affected agents precede the shared budget lock, matching proposal/recovery order.
      const agents = await client.query(`SELECT agent_id,status FROM rail_agents agent WHERE owner_wallet_id=$1
        AND (agent_id=$3::uuid OR EXISTS(SELECT 1 FROM rail_shared_budget_members member WHERE member.agent_id=agent.agent_id AND member.budget_id=$2))
        ORDER BY agent_id FOR UPDATE`, [owner, budgetId, input.agentId ?? null]);
      const found = await client.query("SELECT *,expires_at<=clock_timestamp() AS expired FROM rail_shared_budgets WHERE budget_id=$1 AND owner_wallet_id=$2 FOR UPDATE", [budgetId, owner]);
      const budget = found.rows[0];
      if (!budget) throw new RequestError(404, "shared_budget_not_found", "shared budget not found");
      if (action !== "revoke" && (budget.revoked_at || budget.expired)) throw new RequestError(409, "shared_budget_inactive", "shared budget is inactive");
      for (const row of agents.rows) await this.releaseIntents(client, row.agent_id, "expired", "deadline_expired");
      if (action === "revoke" && budget.revoked_at) return mapSharedBudget(budget);
      if (action === "limit") {
        const current = (await client.query("SELECT * FROM rail_shared_budgets WHERE budget_id=$1", [budgetId])).rows[0];
        if (Number(current.revision) !== input.revision) throw new RequestError(409, "shared_budget_revision_changed", "refresh the budget before changing its limit");
        if (BigInt(input.totalBudgetMinor as number) < BigInt(current.reserved_budget_minor) + BigInt(current.spent_budget_minor))
          throw new RequestError(409, "shared_budget_committed", "new limit is below existing commitments");
        const controlId = await this.sharedControl(client, owner, budgetId, action, payload, authorized);
        await client.query("UPDATE rail_shared_budgets SET total_budget_minor=$2,revision=revision+1,current_control_id=$3 WHERE budget_id=$1", [budgetId, input.totalBudgetMinor, controlId]);
      } else if (action === "member_add") {
        if (!agents.rows.some(row => row.agent_id === input.agentId && row.status === "active")) throw new RequestError(404, "agent_not_found", "active agent not found");
        if ((await client.query("SELECT 1 FROM rail_shared_budget_members WHERE budget_id=$1 AND agent_id=$2", [budgetId, input.agentId])).rowCount)
          throw new RequestError(409, "shared_budget_member_exists", "membership already exists; withdrawn memberships cannot be revived");
        const controlId = await this.sharedControl(client, owner, budgetId, action, payload, authorized);
        await client.query("INSERT INTO rail_shared_budget_members(budget_id,agent_id,owner_wallet_id,created_control_id) VALUES($1,$2,$3,$4)", [budgetId, input.agentId, owner, controlId]);
      } else if (action === "member_remove") {
        const member = (await client.query("SELECT * FROM rail_shared_budget_members WHERE budget_id=$1 AND agent_id=$2 FOR UPDATE", [budgetId, input.agentId])).rows[0];
        if (!member) throw new RequestError(404, "shared_budget_member_not_found", "shared budget member not found");
        if (!member.revoked_at) {
          const controlId = await this.sharedControl(client, owner, budgetId, action, payload, authorized);
          await client.query("UPDATE rail_shared_budget_members SET revoked_at=clock_timestamp(),revoked_control_id=$3 WHERE budget_id=$1 AND agent_id=$2", [budgetId, input.agentId, controlId]);
          await this.releaseIntents(client, String(input.agentId), "rejected", "shared_budget_membership_revoked", undefined, budgetId);
        }
      } else {
        const controlId = await this.sharedControl(client, owner, budgetId, action, payload, authorized);
        await client.query("UPDATE rail_shared_budgets SET revoked_at=clock_timestamp(),revoked_control_id=$2 WHERE budget_id=$1", [budgetId, controlId]);
        for (const row of agents.rows) await this.releaseIntents(client, row.agent_id, "rejected", "shared_budget_revoked", undefined, budgetId);
      }
      await this.audit(client, `agent.shared_budget_${action}`, owner, { budgetId, ...(input.agentId ? { agentId: input.agentId } : {}) });
      return mapSharedBudget((await client.query("SELECT *,expires_at<=clock_timestamp() AS expired FROM rail_shared_budgets WHERE budget_id=$1", [budgetId])).rows[0]);
    });
  }

  async createAgent(owner: string, input: unknown) {
    if (!isRecord(input) || !isSafeText(input.name, 1, 80) || !input.name.trim()) invalid();
    const name = input.name.trim();
    return this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`agent-owner:${owner}`]);
      const count = await client.query("SELECT count(*) FROM rail_agents WHERE owner_wallet_id = $1", [owner]);
      if (Number(count.rows[0].count) >= 50) throw new RequestError(409, "agent_capacity", "owner agent capacity reached");
      const result = await client.query("INSERT INTO rail_agents(agent_id, owner_wallet_id, name) VALUES ($1, $2, $3) RETURNING *", [randomUUID(), owner, name]);
      const agent = mapAgent(result.rows[0], this.executionEnabled);
      await this.audit(client, "agent.created", owner, { agentId: agent.agentId });
      return agent;
    });
  }

  async listAgents(owner: string) {
    const result = await this.pool.query("SELECT * FROM rail_agents WHERE owner_wallet_id = $1 ORDER BY created_at, agent_id LIMIT 50", [owner]);
    return result.rows.map(row => mapAgent(row, this.executionEnabled));
  }

  async issueCredential(owner: string, agentId: string, input: unknown, principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    if (!isRecord(input)) invalid();
    if (Object.hasOwn(input, "rotatedFromCredentialId")) invalid();
    const seconds = ttl(input.ttlSeconds);
    const scope = input.scope ?? "payments:propose";
    if (scope !== "payments:propose" && scope !== "payments:execute") invalid();
    if (scope === "payments:execute" && !this.executionEnabled) throw new RequestError(503, "agent_execution_unavailable", "protected agent execution is unavailable");
    if (this.proofControl?.required && !Object.hasOwn(input, "publicKey")) throw new RequestError(422, "agent_public_key_required", "enroll an agent public key before issuing a credential");
    const grantToken = input.grantToken, operationFingerprint = credentialOperationFingerprint(agentId, input);
    const publicKey = Object.hasOwn(input, "publicKey") ? parseAgentPublicKey(input.publicKey) : undefined;
    if (publicKey && (!this.ownerControl?.required || !this.ownerControl.store))
      throw new RequestError(503, "owner_step_up_unavailable", "public-key credentials require owner passkey authorization");
    return this.transaction(async client => {
      await this.lockOwnerContext(client, owner, principal);
      const authorized = scope === "payments:execute" || publicKey ? await this.requireOwnerGrant(client, owner, principal, grantToken, "agent_credential", operationFingerprint) : principal;
      await this.ownedAgent(client, owner, agentId);
      const credential = await this.insertCredential(client, agentId, scope, seconds, authorized, publicKey);
      await this.audit(client, "agent.credential_issued", owner, { agentId, credentialId: credential.credentialId, scope });
      return credential;
    });
  }

  private async insertCredential(client: PoolClient, agentId: string, scope: string, seconds: number,
    authorized: OwnerPrincipal, publicKey?: AgentPublicKey, predecessor?: string) {
    const count = await client.query("SELECT count(*) FROM rail_agent_credentials WHERE agent_id=$1", [agentId]);
    if (Number(count.rows[0].count) >= 100) throw new RequestError(409, "credential_capacity", "agent credential capacity reached");
    const token = `rail_agent_${randomBytes(32).toString("base64url")}`, credentialId = randomUUID();
    // Native database time binds revocation and replacement without losing microseconds in JS dates.
    const result = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now), predecessor AS (
      UPDATE rail_agent_credentials SET revoked_at=timestamp.now FROM timestamp
      WHERE credential_id=$9::uuid AND agent_id=$2 AND revoked_at IS NULL AND expires_at>timestamp.now RETURNING credential_id)
      INSERT INTO rail_agent_credentials(credential_id,agent_id,token_hash,scope,created_at,expires_at,
        owner_step_up_challenge_id,proof_public_key,proof_key_thumbprint,rotated_from_credential_id)
      SELECT $1,$2,$3,$5,now,now+$4*interval '1 second',$6::uuid,$7::jsonb,$8,$9::uuid FROM timestamp
      WHERE $9::uuid IS NULL OR EXISTS(SELECT 1 FROM predecessor) RETURNING expires_at`,
      [credentialId, agentId, createHash("sha256").update(token).digest("hex"), seconds, scope, authorized.stepUp?.challengeId ?? null,
        publicKey ? JSON.stringify(publicKey) : null, publicKey ? agentKeyThumbprint(publicKey) : null, predecessor ?? null]);
    if (result.rowCount !== 1) throw new RequestError(409, "credential_inactive", "credential is no longer active");
    return { credentialId, agentId, scope, expiresAt: date(result.rows[0].expires_at), token,
      ...(predecessor ? { rotatedFromCredentialId: predecessor } : {}),
      ...(publicKey ? { proofKeyThumbprint: agentKeyThumbprint(publicKey), proofRouteReady: !this.proofControl?.required || this.proofControl.ready } : {}),
      executionEnabled: scope === "payments:execute" && this.executionEnabled };
  }

  async rotateCredential(owner: string, agentId: string, credentialId: string, input: unknown,
    principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    const fingerprint = credentialRotationFingerprint(agentId, credentialId, input);
    if (!isRecord(input)) invalid();
    const scope = String(input.scope), seconds = ttl(input.ttlSeconds), publicKey = parseAgentPublicKey(input.publicKey), grantToken = input.grantToken;
    if (!this.ownerControl?.required || !this.ownerControl.store) throw new RequestError(503, "owner_step_up_unavailable", "rotation requires owner passkey authorization");
    if (scope === "payments:execute" && !this.executionEnabled) throw new RequestError(503, "agent_execution_unavailable", "protected agent execution is unavailable");
    return this.transaction(async client => {
      const authorized = await this.requireOwnerGrant(client, owner, principal, grantToken, "agent_credential", fingerprint);
      await this.ownedAgent(client, owner, agentId);
      const source = (await client.query(`SELECT scope,revoked_at,expires_at>clock_timestamp() AS valid
        FROM rail_agent_credentials WHERE credential_id=$1 AND agent_id=$2 FOR UPDATE`, [credentialId, agentId])).rows[0];
      if (!source) throw new RequestError(404, "credential_not_found", "credential not found");
      if (source.revoked_at || !source.valid) throw new RequestError(409, "credential_inactive", "credential is no longer active; inspect owner credential history");
      if (source.scope !== scope) throw new RequestError(403, "credential_scope_change_denied", "rotation cannot change credential scope");
      if ((await client.query("SELECT 1 FROM rail_agent_credentials WHERE agent_id=$1 AND proof_key_thumbprint=$2", [agentId, agentKeyThumbprint(publicKey)])).rowCount)
        throw new RequestError(422, "rotation_requires_fresh_key", "rotation requires a fresh agent public key");
      const credential = await this.insertCredential(client, agentId, scope, seconds, authorized, publicKey, credentialId);
      await this.audit(client, "agent.credential_rotated", owner, { agentId, credentialId: credential.credentialId, predecessorCredentialId: credentialId, scope });
      return credential;
    });
  }

  async resolveCredential(token: unknown, admission?: AgentAdmission) {
    if (typeof token !== "string" || !/^rail_agent_[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const result = await this.pool.query(`SELECT credential.credential_id, credential.agent_id, credential.scope, credential.expires_at, credential.owner_step_up_challenge_id, credential.proof_key_thumbprint
      FROM rail_agent_credentials credential JOIN rail_agents agent ON agent.agent_id = credential.agent_id
      WHERE credential.token_hash = $1 AND credential.revoked_at IS NULL AND credential.expires_at > clock_timestamp()
        AND agent.status = 'active'`, [createHash("sha256").update(token).digest("hex")]);
    if (!result.rows[0]) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const row = result.rows[0];
    if (this.proofControl?.required && !row.proof_key_thumbprint) throw new RequestError(401, "agent_public_key_required", "replace legacy bearer credentials with proof-bound credentials");
    if (row.proof_key_thumbprint) return this.transaction(async client => {
      const agent = await this.credentialForMutation(client, token, false, admission, { method: "GET", path: "/v2/agent/identity" });
      return { credentialId: agent.credentialId, agentId: String(agent.agent_id), scope: agent.scope, expiresAt: agent.credentialExpiresAt,
        proofKeyThumbprint: row.proof_key_thumbprint, executionEnabled: agent.scope === "payments:execute" && this.executionEnabled };
    });
    return { credentialId: String(row.credential_id), agentId: String(row.agent_id), scope: String(row.scope),
      expiresAt: date(row.expires_at), executionEnabled: row.scope === "payments:execute" && this.executionEnabled && (!this.ownerControl?.required || Boolean(row.owner_step_up_challenge_id)) };
  }

  async listCredentials(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query(`SELECT credential.credential_id,credential.scope,credential.created_at,credential.expires_at,credential.revoked_at,
        credential.proof_key_thumbprint,credential.rotated_from_credential_id,successor.credential_id AS replaced_by
        FROM rail_agent_credentials credential LEFT JOIN rail_agent_credentials successor ON successor.rotated_from_credential_id=credential.credential_id
        WHERE credential.agent_id=$1 ORDER BY credential.created_at,credential.credential_id LIMIT 100`, [agentId]);
      return result.rows.map(row => ({ credentialId: String(row.credential_id), scope: String(row.scope), createdAt: date(row.created_at),
        expiresAt: date(row.expires_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null,
        proofKeyThumbprint: row.proof_key_thumbprint ?? null, rotatedFromCredentialId: row.rotated_from_credential_id ?? null,
        replacedByCredentialId: row.replaced_by ?? null }));
    });
  }

  async revokeCredential(owner: string, agentId: string, credentialId: string) {
    if (!isAgentId(credentialId)) invalid();
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query("UPDATE rail_agent_credentials SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE credential_id = $1 AND agent_id = $2 RETURNING credential_id", [credentialId, agentId]);
      if (!result.rowCount) throw new RequestError(404, "credential_not_found", "credential not found");
      await this.audit(client, "agent.credential_revoked", owner, { agentId, credentialId });
      return { credentialId, revoked: true };
    });
  }

  async revokeAgent(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "rejected", "agent_revoked");
      const result = await client.query("UPDATE rail_agents SET status = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE agent_id = $1 RETURNING *", [agentId]);
      await client.query("UPDATE rail_agent_credentials SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE agent_id = $1", [agentId]);
      await client.query("UPDATE rail_agent_mandates SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE agent_id = $1", [agentId]);
      await this.audit(client, "agent.revoked", owner, { agentId });
      return mapAgent(result.rows[0], this.executionEnabled);
    });
  }

  async createMandate(owner: string, agentId: string, value: unknown, principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    const input = parseMandateInput(value);
    if (input.allowedReceiverWalletIds.includes(owner)) invalid();
    if (!this.authorityEvidence) throw new RequestError(503, "agent_authority_unavailable", "protected mandate consent is not configured");
    const grantToken = isRecord(value) ? value.grantToken : undefined;
    const operationFingerprint = mandateOperationFingerprint(agentId, input);
    return this.transaction(async client => {
      const authorized = await this.requireOwnerGrant(client, owner, principal, grantToken, "agent_mandate", operationFingerprint);
      await this.ownedAgent(client, owner, agentId);
      if (input.sharedBudgetId) await requireSharedBudget(client, { budgetId: input.sharedBudgetId, owner, agentId,
        currency: input.currency, stepUpRequired: Boolean(this.ownerControl?.required) });
      const count = await client.query("SELECT count(*) FROM rail_agent_mandates WHERE agent_id = $1", [agentId]);
      if (Number(count.rows[0].count) >= 100) throw new RequestError(409, "mandate_capacity", "agent mandate capacity reached");
      const wallets = await client.query("SELECT wallet_id FROM wallets WHERE wallet_id = ANY($1::text[]) AND currency = $2", [[owner, ...input.allowedReceiverWalletIds], input.currency]);
      if (wallets.rowCount !== input.allowedReceiverWalletIds.length + 1) invalid();
      const result = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_agent_mandates(mandate_id, agent_id, owner_wallet_id, mode, currency, per_payment_limit_minor,
          total_budget_minor, allowed_receiver_wallet_ids, created_at, expires_at, owner_step_up_challenge_id, shared_budget_id)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, now, now + $9 * interval '1 second', $10::uuid, $11::uuid FROM timestamp RETURNING *`,
        [randomUUID(), agentId, owner, input.mode, input.currency, input.perPaymentLimitMinor, input.totalBudgetMinor, input.allowedReceiverWalletIds, input.ttlSeconds, authorized.stepUp?.challengeId ?? null, input.sharedBudgetId ?? null]);
      const mandate = mapMandate(result.rows[0], this.executionEnabled, this.ownerControl?.required);
      await this.authorityEvidence!.persistOwner(client, mandate.mandateId, authorized);
      await this.audit(client, "agent.mandate_created", owner, { agentId, mandateId: mandate.mandateId });
      return mandate;
    });
  }

  async listMandates(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "expired", "deadline_expired");
      const result = await client.query("SELECT *, expires_at <= clock_timestamp() AS expired FROM rail_agent_mandates WHERE agent_id = $1 ORDER BY created_at, mandate_id LIMIT 100", [agentId]);
      return result.rows.map(row => mapMandate(row, this.executionEnabled, this.ownerControl?.required));
    });
  }

  async revokeMandate(owner: string, agentId: string, mandateId: string) {
    if (!isAgentId(mandateId)) invalid();
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "rejected", "mandate_revoked", mandateId);
      const result = await client.query("UPDATE rail_agent_mandates SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE mandate_id = $1 AND agent_id = $2 RETURNING *", [mandateId, agentId]);
      if (!result.rowCount) throw new RequestError(404, "mandate_not_found", "mandate not found");
      await this.audit(client, "agent.mandate_revoked", owner, { agentId, mandateId });
      return mapMandate(result.rows[0], this.executionEnabled, this.ownerControl?.required);
    });
  }

  private async credentialForMutation(client: PoolClient, token: unknown, requireExecution = false, admission?: AgentAdmission,
    request?: { method: string; path: string; value?: unknown }, claim = true) {
    if (typeof token !== "string" || !/^rail_agent_[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const hash = createHash("sha256").update(token).digest("hex");
    const lookup = await client.query(`SELECT agent.agent_id, agent.owner_wallet_id FROM rail_agent_credentials credential
      JOIN rail_agents agent ON agent.agent_id = credential.agent_id WHERE credential.token_hash = $1`, [hash]);
    if (!lookup.rows[0]) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    if (this.ownerControl?.required) await client.query("SELECT user_id FROM users WHERE wallet_id=$1 ORDER BY user_id FOR UPDATE", [lookup.rows[0].owner_wallet_id]);
    // Same agent-first lock order as owner revocation and credential issuance.
    const agent = await this.ownedAgent(client, lookup.rows[0].owner_wallet_id, lookup.rows[0].agent_id, false);
    const credential = await client.query(`SELECT credential_id, scope, expires_at, owner_step_up_challenge_id, proof_key_thumbprint FROM rail_agent_credentials WHERE token_hash = $1
      AND agent_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, [hash, agent.agent_id]);
    if (agent.status !== "active" || !credential.rowCount) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    if (this.proofControl?.required && !credential.rows[0].proof_key_thumbprint) throw new RequestError(401, "agent_public_key_required", "replace legacy bearer credentials with proof-bound credentials");
    if (credential.rows[0].proof_key_thumbprint) {
      if (!request) throw new RequestError(401, "invalid_agent_proof", "invalid agent proof");
      await dispatchAgentAdmission(client, admission, { ...request, credentialId: String(credential.rows[0].credential_id), keyThumbprint: credential.rows[0].proof_key_thumbprint }, claim);
    }
    if (requireExecution && credential.rows[0].scope !== "payments:execute") throw new RequestError(403, "agent_execution_scope_required", "execution scope is required");
    if (requireExecution && this.ownerControl?.required && !credential.rows[0].owner_step_up_challenge_id)
      throw new RequestError(409, "fresh_execution_credential_required", "replace legacy execution credentials after owner step-up");
    return { ...agent, credentialId: String(credential.rows[0].credential_id), scope: String(credential.rows[0].scope), credentialExpiresAt: date(credential.rows[0].expires_at) };
  }

  private async releaseIntents(client: PoolClient, agentId: string, status: "expired" | "rejected", reason: string, mandateId?: string, budgetId?: string) {
    await cancelUnsubmittedProviderPayments(client, { agentIds: [agentId], mandateId, budgetId, onlyExpired: status === "expired" });
    const released = await client.query(`UPDATE rail_agent_intents intent SET status = $2, terminal_reason = $3
      WHERE agent_id = $1 AND status IN ('pending','approved') AND ($4::uuid IS NULL OR mandate_id = $4)
        AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM rail_agent_mandates mandate WHERE mandate.mandate_id=intent.mandate_id AND mandate.shared_budget_id=$5))
        AND ($2 = 'rejected' OR expires_at <= clock_timestamp() OR EXISTS
          (SELECT 1 FROM rail_agent_mandates mandate LEFT JOIN rail_shared_budgets budget ON budget.budget_id=mandate.shared_budget_id
            WHERE mandate.mandate_id = intent.mandate_id AND (mandate.expires_at <= clock_timestamp() OR budget.expires_at<=clock_timestamp())))
      RETURNING mandate_id, amount_minor`, [agentId, status, reason, mandateId ?? null, budgetId ?? null]);
    const totals = new Map<string, bigint>();
    for (const row of released.rows) totals.set(row.mandate_id, (totals.get(row.mandate_id) ?? 0n) + BigInt(row.amount_minor));
    for (const [id, amount] of totals) {
      const changed = await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor - $2 WHERE mandate_id = $1 AND reserved_budget_minor >= $2 RETURNING mandate_id", [id, amount.toString()]);
      if (changed.rowCount !== 1) throw new Error("agent_budget_reservation_mismatch");
    }
    if (released.rowCount) await this.audit(client, "agent.intents_released", String((await client.query("SELECT owner_wallet_id FROM rail_agents WHERE agent_id = $1", [agentId])).rows[0].owner_wallet_id),
      { agentId, count: released.rowCount, reason });
  }

  async createIntent(token: unknown, value: unknown, admission?: AgentAdmission) {
    if (!isRecord(value) || !isAgentId(value.mandateId) || !isSafeText(value.clientRequestId, 8, 128) ||
        !isSafeText(value.receiverWalletId, 3, 128) || !isValidAmountMinor(value.amountMinor) || !isCurrency(value.currency) || Object.hasOwn(value, "sharedBudgetId")) invalid();
    const input = { mandateId: value.mandateId, clientRequestId: value.clientRequestId, receiverWalletId: value.receiverWalletId,
      amountMinor: value.amountMinor, currency: value.currency, ttlSeconds: value.ttlSeconds === undefined ? 300 : value.ttlSeconds,
      checkout: value.checkout === undefined ? undefined : parseAgentCheckout(value.checkout),
      merchantQuoteProof: value.merchantQuoteProof === undefined ? undefined : parseMerchantQuoteProof(value.merchantQuoteProof) };
    if (typeof input.ttlSeconds !== "number" || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 900) invalid();
    if (input.checkout && (input.checkout.merchantWalletId !== input.receiverWalletId || input.checkout.totalMinor !== input.amountMinor || input.checkout.currency !== input.currency)) invalid();
    if (input.merchantQuoteProof && !input.checkout) invalid();
    if (!input.merchantQuoteProof && this.merchantQuotes.requiresProof(input.receiverWalletId))
      throw new RequestError(403, "merchant_quote_required", "configured merchant requires a signed checkout");
    const attestation = input.merchantQuoteProof ? this.merchantQuotes.authenticate(input.checkout!, input.merchantQuoteProof) : undefined;
    const proofTuple = attestation ? [attestation.version, attestation.keyId, attestation.keyFingerprint, attestation.signature] : [];
    const proofValue = structuredClone(value);
    return this.transaction(async client => {
      const agent = await this.credentialForMutation(client, token, false, admission, { method: "POST", path: "/v2/agent/intents", value: proofValue });
      if (input.checkout && input.checkout.fundingSource.walletId !== agent.owner_wallet_id)
        throw new RequestError(403, "checkout_funding_denied", "checkout funding must use the owner's internal wallet");
      await this.releaseIntents(client, agent.agent_id, "expired", "deadline_expired");
      const binding = await client.query("SELECT shared_budget_id FROM rail_agent_mandates WHERE mandate_id=$1 AND agent_id=$2 AND owner_wallet_id=$3", [input.mandateId, agent.agent_id, agent.owner_wallet_id]);
      const sharedBudgetId = binding.rows[0]?.shared_budget_id as string | undefined;
      const proposal = createHash("sha256").update(JSON.stringify([sharedBudgetId ? "rail:agent-proposal:v4" : attestation ? "rail:agent-proposal:v3" : input.checkout ? "rail:agent-proposal:v2" : "rail:agent-proposal:v1", agent.agent_id, input.mandateId,
        input.clientRequestId, input.receiverWalletId, input.amountMinor, input.currency, input.ttlSeconds,
        ...(input.checkout ? [checkoutTuple(input.checkout)] : []), ...(attestation ? [proofTuple] : []), ...(sharedBudgetId ? [sharedBudgetId] : [])])).digest("hex");
      const previous = await client.query("SELECT * FROM rail_agent_intents WHERE agent_id = $1 AND client_request_id = $2", [agent.agent_id, input.clientRequestId]);
      if (previous.rows[0]) {
        if (previous.rows[0].proposal_fingerprint !== proposal) throw new RequestError(409, "intent_request_reused", "intent request ID is already bound to different data");
        return mapIntent(previous.rows[0], this.executionEnabled, this.ownerControl?.required);
      }
      const policy = await client.query(`SELECT *, expires_at > clock_timestamp() AS valid FROM rail_agent_mandates
        WHERE mandate_id = $1 AND agent_id = $2 AND owner_wallet_id = $3 FOR UPDATE`, [input.mandateId, agent.agent_id, agent.owner_wallet_id]);
      const mandate = policy.rows[0];
      if (!mandate) throw new RequestError(404, "mandate_not_found", "mandate not found");
      if (!mandate.valid || mandate.revoked_at) throw new RequestError(409, "mandate_inactive", "mandate is inactive");
      const sharedBudget = sharedBudgetId ? await requireSharedBudget(client, { budgetId: sharedBudgetId, owner: agent.owner_wallet_id,
        agentId: agent.agent_id, currency: input.currency, stepUpRequired: Boolean(this.ownerControl?.required) }) : undefined;
      if (sharedBudget && BigInt(sharedBudget.reserved_budget_minor) + BigInt(sharedBudget.spent_budget_minor) + BigInt(input.amountMinor) > BigInt(sharedBudget.total_budget_minor))
        throw new RequestError(409, "shared_budget_exceeded", "insufficient shared budget headroom");
      if (mandate.consent_receipt_version !== 1) throw new RequestError(409, "new_agent_owner_consent_required", "legacy mandate requires fresh owner consent");
      if (mandate.currency !== input.currency || input.amountMinor > Number(mandate.per_payment_limit_minor) ||
          !mandate.allowed_receiver_wallet_ids.includes(input.receiverWalletId) || input.receiverWalletId === agent.owner_wallet_id) {
        throw new RequestError(403, "mandate_policy_denied", "intent is outside mandate policy");
      }
      if (!this.authorityEvidence) throw new RequestError(503, "agent_authority_unavailable", "protected mandate consent is not configured");
      try { const consent = await this.authorityEvidence.verifyMandateConsent(client, input.mandateId); this.requireSteppedConsent(consent.record); }
      catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(503, "agent_owner_evidence_unavailable", "owner mandate consent cannot be verified"); }
      const wallets = await client.query("SELECT wallet_id FROM wallets WHERE wallet_id = ANY($1::text[]) AND currency = $2", [[agent.owner_wallet_id, input.receiverWalletId], input.currency]);
      if (wallets.rowCount !== 2) throw new RequestError(409, "mandate_currency_changed", "wallet currency no longer matches mandate");
      const count = await client.query("SELECT count(*) FROM rail_agent_intents WHERE agent_id = $1", [agent.agent_id]);
      if (Number(count.rows[0].count) >= 1000) throw new RequestError(409, "intent_capacity", "retained intent capacity reached");
      if (attestation) {
        // Same quote ID is single-use across versions, owners and agents; retries return above.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["merchant-quote", input.receiverWalletId, input.checkout!.quoteId])]);
        const used = await client.query("SELECT 1 FROM rail_agent_intents WHERE receiver_wallet_id=$1 AND checkout->>'quoteId'=$2 AND merchant_attestation IS NOT NULL LIMIT 1", [input.receiverWalletId, input.checkout!.quoteId]);
        if (used.rowCount) throw new RequestError(409, "merchant_quote_used", "merchant quote is already bound to an intent");
      }
      const reservation = await client.query(`UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor + $2
        WHERE mandate_id = $1 AND reserved_budget_minor + spent_budget_minor + $2 <= total_budget_minor RETURNING mandate_id`, [input.mandateId, input.amountMinor]);
      if (reservation.rowCount !== 1) throw new RequestError(409, "mandate_budget_exceeded", "insufficient mandate budget headroom");
      const time = await client.query("WITH timestamp AS (SELECT clock_timestamp() AS now) SELECT now AS created_at, LEAST(now + $1 * interval '1 second', $2::timestamptz, $3::timestamptz, $4::timestamptz) AS expires_at FROM timestamp", [input.ttlSeconds, mandate.expires_at, input.checkout?.expiresAt ?? null, sharedBudget?.expires_at ?? null]);
      const createdAt = date(time.rows[0].created_at), expiresAt = date(time.rows[0].expires_at), intentId = randomUUID();
      if (expiresAt <= createdAt) throw new RequestError(409, "quote_expired", "checkout quote has expired");
      const fingerprint = createHash("sha256").update(JSON.stringify([sharedBudgetId ? "rail:agent-intent:v4" : attestation ? "rail:agent-intent:v3" : input.checkout ? "rail:agent-intent:v2" : "rail:agent-intent:v1", intentId, agent.agent_id, input.mandateId,
        agent.owner_wallet_id, input.receiverWalletId, input.amountMinor, input.currency, createdAt, expiresAt,
        ...(input.checkout ? [checkoutTuple(input.checkout)] : []), ...(attestation ? [proofTuple] : []), ...(sharedBudgetId ? [sharedBudgetId] : [])])).digest("hex");
      const result = await client.query(`INSERT INTO rail_agent_intents(intent_id, agent_id, mandate_id, owner_wallet_id,
        client_request_id, proposal_fingerprint, request_fingerprint, receiver_wallet_id, amount_minor, currency, status, created_at, expires_at, checkout, merchant_attestation, owner_step_up_version, shared_budget_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14::jsonb,$15::jsonb,$16,$17::uuid) RETURNING *`,
        [intentId, agent.agent_id, input.mandateId, agent.owner_wallet_id, input.clientRequestId, proposal, fingerprint,
          input.receiverWalletId, input.amountMinor, input.currency, mandate.mode === "budgeted" ? "approved" : "pending", createdAt, expiresAt,
          input.checkout ? JSON.stringify(input.checkout) : null, attestation ? JSON.stringify(attestation) : null, this.ownerControl?.required ? 1 : null, sharedBudgetId ?? null]);
      await this.audit(client, "agent.intent_created", agent.owner_wallet_id, { agentId: agent.agent_id, intentId, mandateId: input.mandateId,
        status: result.rows[0].status, requestFingerprint: fingerprint });
      return mapIntent(result.rows[0], this.executionEnabled, this.ownerControl?.required);
    });
  }

  async listIntents(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "expired", "deadline_expired");
      return (await client.query("SELECT * FROM rail_agent_intents WHERE agent_id = $1 ORDER BY created_at, intent_id LIMIT 1000", [agentId])).rows.map(row => mapIntent(row, this.executionEnabled, this.ownerControl?.required));
    });
  }

  async listAgentIntents(token: unknown, admission?: AgentAdmission) {
    return this.transaction(async client => {
      const agent = await this.credentialForMutation(client, token, false, admission, { method: "GET", path: "/v2/agent/intents" });
      await this.releaseIntents(client, agent.agent_id, "expired", "deadline_expired");
      return (await client.query("SELECT * FROM rail_agent_intents WHERE agent_id = $1 ORDER BY created_at, intent_id LIMIT 1000", [agent.agent_id])).rows.map(row => mapIntent(row, this.executionEnabled, this.ownerControl?.required));
    });
  }

  async decideIntent(owner: string, agentId: string, intentId: string, value: unknown, principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    if (!isAgentId(intentId) || !isRecord(value) || (value.decision !== "approve" && value.decision !== "reject") ||
        typeof value.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.requestFingerprint)) invalid();
    const decision = value.decision, fingerprint = value.requestFingerprint;
    const grantToken = value.grantToken;
    return this.transaction(async client => {
      await this.lockOwnerContext(client, owner, principal);
      const authorized = decision === "approve" ? await this.requireOwnerGrant(client, owner, principal, grantToken, "agent_approval", approvalOperationFingerprint(agentId, intentId, fingerprint)) : principal;
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "expired", "deadline_expired");
      const result = await client.query("SELECT * FROM rail_agent_intents WHERE intent_id = $1 AND agent_id = $2 AND owner_wallet_id = $3 FOR UPDATE", [intentId, agentId, owner]);
      const intent = result.rows[0];
      if (!intent) throw new RequestError(404, "intent_not_found", "intent not found");
      if (intent.request_fingerprint !== fingerprint) throw new RequestError(409, "intent_fingerprint_mismatch", "approval does not match the exact intent");
      if (decision === "approve" && this.ownerControl?.required && intent.owner_step_up_version !== 1 && intent.status !== "executed")
        throw new RequestError(409, "fresh_owner_step_up_required", "replace legacy intents after owner step-up");
      if (intent.status === "expired" || intent.status === "rejected" || intent.status === "executed") return mapIntent(intent, this.executionEnabled, this.ownerControl?.required);
      if (decision === "approve") {
        if (intent.shared_budget_id) await requireSharedBudget(client, { budgetId: intent.shared_budget_id, owner, agentId,
          currency: intent.currency, stepUpRequired: Boolean(this.ownerControl?.required) });
        if (!intent.merchant_attestation && this.merchantQuotes.requiresProof(intent.receiver_wallet_id))
          throw new RequestError(403, "merchant_quote_required", "configured merchant requires a signed checkout");
        if (intent.merchant_attestation) this.merchantQuotes.requireCurrent(intent.checkout, intent.merchant_attestation);
      }
      if (decision === "approve" && intent.status === "approved") {
        if (intent.owner_evidence_version === 1) {
          if (!this.authorityEvidence) throw new RequestError(503, "agent_authority_unavailable", "protected owner evidence is not configured");
          try { await this.authorityEvidence.verifyOwnerAuthority(client, intentId); }
          catch { throw new RequestError(503, "agent_owner_evidence_unavailable", "owner consent or approval cannot be verified"); }
        }
        return mapIntent(intent, this.executionEnabled, this.ownerControl?.required);
      }
      if (!this.authorityEvidence) throw new RequestError(503, "agent_authority_unavailable", "protected owner decision is not configured");
      const status = decision === "approve" ? "approved" : "rejected";
      await client.query("UPDATE rail_agent_intents SET status = $2, terminal_reason = $3 WHERE intent_id = $1", [intentId, status, decision === "reject" ? "owner_rejected" : null]);
      if (decision === "reject") await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor - $2 WHERE mandate_id = $1", [intent.mandate_id, intent.amount_minor]);
      await this.authorityEvidence.persistOwner(client, intent.mandate_id, authorized, { intentId, decision });
      await this.audit(client, `agent.intent_${status}`, owner, { agentId, intentId, requestFingerprint: fingerprint });
      return mapIntent({ ...intent, status, terminal_reason: decision === "reject" ? "owner_rejected" : null }, this.executionEnabled, this.ownerControl?.required);
    });
  }

  async executeIntent(token: unknown, intentId: string, value: unknown, admission?: AgentAdmission) {
    if (!isAgentId(intentId) || !isRecord(value) || Object.keys(value).length !== 1 ||
        typeof value.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.requestFingerprint)) invalid();
    const fingerprint = value.requestFingerprint;
    const proofValue = structuredClone(value);
    if (!this.executionEnabled) throw new RequestError(503, "agent_execution_unavailable", "protected agent execution is unavailable");
    const signingSecret = process.env.RAIL_SIGNING_SECRET!;
    return this.transaction(async client => {
      const agent = await this.credentialForMutation(client, token, true, admission, { method: "POST", path: `/v2/agent/intents/${intentId}/execute`, value: proofValue });
      await this.releaseIntents(client, agent.agent_id, "expired", "deadline_expired");
      const found = await client.query("SELECT * FROM rail_agent_intents WHERE intent_id = $1 AND agent_id = $2 AND owner_wallet_id = $3 FOR UPDATE", [intentId, agent.agent_id, agent.owner_wallet_id]);
      const intent = found.rows[0];
      if (!intent) throw new RequestError(404, "intent_not_found", "intent not found");
      if (intent.request_fingerprint !== fingerprint) throw new RequestError(409, "intent_fingerprint_mismatch", "execution does not match the exact intent");
      const policy = await client.query("SELECT *, expires_at > clock_timestamp() AS valid FROM rail_agent_mandates WHERE mandate_id = $1 FOR UPDATE", [intent.mandate_id]);
      const mandate = policy.rows[0];
      if (!mandate?.valid || mandate.revoked_at) throw new RequestError(409, "mandate_inactive", "mandate is inactive");
      if (intent.status === "executed") {
        if (intent.authority_receipt_version === 1) {
          const evidence = await this.authorityEvidence!.read(client, intentId, agent.owner_wallet_id, agent.agent_id);
          if (evidence?.status !== "verified") throw new RequestError(503, "agent_authority_verification_unavailable", "authority receipt cannot be verified");
        }
        const replay = await client.query(`SELECT execution.result_json FROM rail_payment_executions execution
          JOIN rail_idempotency replay ON replay.idempotency_key = execution.idempotency_key AND replay.status = 'completed'
            AND replay.request_fingerprint = execution.request_fingerprint AND replay.result_json = execution.result_json
          WHERE execution.tx_id = $1 AND execution.idempotency_key = $2`, [intent.payment_tx_id, `rail_agent_intent:${intentId}`]);
        if (!replay.rows[0]) throw new Error("agent_replay_missing");
        return { intent: mapIntent(intent, this.executionEnabled, this.ownerControl?.required), result: replay.rows[0].result_json };
      }
      if (intent.status !== "approved") throw new RequestError(409, "intent_not_approved", "intent is not approved for execution");
      if (intent.shared_budget_id) await requireSharedBudget(client, { budgetId: intent.shared_budget_id, owner: agent.owner_wallet_id,
        agentId: agent.agent_id, currency: intent.currency, stepUpRequired: Boolean(this.ownerControl?.required) });
      if (this.ownerControl?.required && intent.owner_step_up_version !== 1)
        throw new RequestError(409, "fresh_owner_step_up_required", "replace legacy intents after owner step-up");
      if (!intent.merchant_attestation && this.merchantQuotes.requiresProof(intent.receiver_wallet_id))
        throw new RequestError(403, "merchant_quote_required", "configured merchant requires a signed checkout");
      if (intent.merchant_attestation) this.merchantQuotes.requireCurrent(intent.checkout, intent.merchant_attestation);
      if (intent.authority_receipt_version !== 1) throw new RequestError(409, "new_agent_intent_required", "legacy intent must be replaced before execution");
      if (intent.owner_evidence_version !== 1 || mandate.consent_receipt_version !== 1)
        throw new RequestError(409, "new_agent_owner_consent_required", "legacy authority requires fresh owner consent and intent");
      try { const authority = await this.authorityEvidence!.verifyOwnerAuthority(client, intentId);
        this.requireSteppedConsent(authority.mandate.record); if (authority.approval) this.requireSteppedConsent(authority.approval.record); }
      catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(503, "agent_owner_evidence_unavailable", "owner consent or approval cannot be verified"); }
      if (mandate.currency !== intent.currency || Number(intent.amount_minor) > Number(mandate.per_payment_limit_minor) ||
          !mandate.allowed_receiver_wallet_ids.includes(intent.receiver_wallet_id)) throw new RequestError(403, "mandate_policy_denied", "intent is outside mandate policy");
      const wallets = await client.query("SELECT wallet_id, currency, balance FROM wallets WHERE wallet_id = ANY($1::text[]) ORDER BY wallet_id FOR UPDATE", [[intent.owner_wallet_id, intent.receiver_wallet_id]]);
      if (wallets.rowCount !== 2 || wallets.rows.some(row => row.currency !== intent.currency)) throw new RequestError(409, "mandate_currency_changed", "wallet currency no longer matches mandate");
      if (BigInt(wallets.rows.find(row => row.wallet_id === intent.owner_wallet_id).balance) < BigInt(intent.amount_minor)) throw new RequestError(409, "insufficient_funds", "insufficient available wallet funds");
      const auth = await createAuthorizationInTransaction({ txId: `rail_agent:${intentId}`, senderWalletId: intent.owner_wallet_id,
        receiverWalletId: intent.receiver_wallet_id, amountMinor: Number(intent.amount_minor), currency: intent.currency }, client, { cleanupExpired: false });
      const payment: PaymentTransaction = { txId: auth.txId, idempotencyKey: `rail_agent_intent:${intentId}`, authorizationId: auth.authId,
        senderWalletId: intent.owner_wallet_id, receiverWalletId: intent.receiver_wallet_id, amountMinor: Number(intent.amount_minor),
        currency: intent.currency, channel: "online", createdAt: date(intent.created_at) };
      const result = await this.engine!.executeInTransaction({ ...payment, paymentSignature: signTransactionHmac(payment, signingSecret) }, client);
      if (result.status !== "accepted") throw new Error("agent_payment_not_accepted");
      // Recheck live deadlines after waiting for financial locks and running the engine.
      await this.credentialForMutation(client, token, true, admission, { method: "POST", path: `/v2/agent/intents/${intentId}/execute`, value: proofValue }, false);
      const spent = await client.query(`UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor - $2,
        spent_budget_minor = spent_budget_minor + $2 WHERE mandate_id = $1 AND reserved_budget_minor >= $2
          AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING mandate_id`, [intent.mandate_id, intent.amount_minor]);
      if (spent.rowCount !== 1) throw new RequestError(409, "mandate_inactive", "mandate is inactive");
      const executed = await client.query(`UPDATE rail_agent_intents SET status = 'executed', payment_tx_id = $2, executed_at = clock_timestamp()
        WHERE intent_id = $1 AND status = 'approved' AND expires_at > clock_timestamp() RETURNING *`, [intentId, payment.txId]);
      if (executed.rowCount !== 1) throw new RequestError(409, "intent_expired", "intent expired before execution completed");
      await this.authorityEvidence!.persist(client, intentId, agent.credentialId);
      await this.audit(client, "agent.intent_executed", agent.owner_wallet_id, { agentId: agent.agent_id, intentId, txId: payment.txId, requestFingerprint: fingerprint });
      return { intent: mapIntent(executed.rows[0], this.executionEnabled, this.ownerControl?.required), result };
    });
  }

  async readAuthority(owner: string, agentId: string, intentId: string) {
    if (!isAgentId(agentId) || !isAgentId(intentId)) invalid();
    if (!this.authorityEvidence) throw new RequestError(503, "agent_authority_unavailable", "authority verification is not configured");
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const evidence = await this.authorityEvidence!.read(client, intentId, owner, agentId);
      if (!evidence) throw new RequestError(404, "intent_not_found", "intent not found");
      return evidence;
    });
  }
}
