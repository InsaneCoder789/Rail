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
      new Set(value.allowedReceiverWalletIds).size !== value.allowedReceiverWalletIds.length) invalid();
  return { mode: value.mode as MandateInput["mode"], currency: value.currency,
    perPaymentLimitMinor: value.perPaymentLimitMinor, totalBudgetMinor: value.totalBudgetMinor,
    allowedReceiverWalletIds: [...value.allowedReceiverWalletIds], ttlSeconds: ttl(value.ttlSeconds) };
}

function date(value: unknown): string { return (value instanceof Date ? value : new Date(String(value))).toISOString(); }
function mapAgent(row: Record<string, unknown>, enabled = false) {
  return { agentId: String(row.agent_id), name: String(row.name), status: String(row.status),
    createdAt: date(row.created_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null, executionEnabled: enabled && row.status === "active" };
}
function mapMandate(row: Record<string, unknown>, enabled = false) {
  return { mandateId: String(row.mandate_id), agentId: String(row.agent_id), mode: String(row.mode), currency: String(row.currency),
    status: row.revoked_at ? "revoked" : row.expired === true ? "expired" : "active",
    perPaymentLimitMinor: Number(row.per_payment_limit_minor), totalBudgetMinor: Number(row.total_budget_minor),
    reservedBudgetMinor: Number(row.reserved_budget_minor),
    spentBudgetMinor: Number(row.spent_budget_minor),
    allowedReceiverWalletIds: row.allowed_receiver_wallet_ids as string[], createdAt: date(row.created_at),
    expiresAt: date(row.expires_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null,
    executionEnabled: enabled && !row.revoked_at && row.expired !== true && row.consent_receipt_version === 1 };
}

function mapIntent(row: Record<string, unknown>, enabled = false) {
  return { intentId: String(row.intent_id), agentId: String(row.agent_id), mandateId: String(row.mandate_id),
    clientRequestId: String(row.client_request_id), requestFingerprint: String(row.request_fingerprint),
    senderWalletId: String(row.owner_wallet_id), receiverWalletId: String(row.receiver_wallet_id), amountMinor: Number(row.amount_minor),
    currency: String(row.currency), status: String(row.status), reason: row.terminal_reason ? String(row.terminal_reason) : null,
    ...(row.checkout ? { checkout: row.checkout, quoteAssurance: row.merchant_attestation ? "configured_merchant_signature" : "agent_proposed_unverified",
      ...(row.merchant_attestation ? { merchantAttestation: row.merchant_attestation } : {}) } : {}),
    createdAt: date(row.created_at), expiresAt: date(row.expires_at),
    paymentTxId: row.payment_tx_id ? String(row.payment_tx_id) : null, executedAt: row.executed_at ? date(row.executed_at) : null,
    executionEnabled: enabled && row.status === "approved" && row.authority_receipt_version === 1 && row.owner_evidence_version === 1 };
}

/** Agent credentials never resolve to owner JWTs or wallet API keys. */
export class AgentAuthorityStore {
  constructor(private readonly pool: Pool, private readonly engine?: PaymentPipelineEngine, private readonly authorityEvidence?: AgentEvidenceStore,
    private readonly merchantQuotes = new MerchantQuoteRegistry()) {}

  private get executionEnabled(): boolean {
    return Boolean(this.authorityEvidence) && this.engine?.supportsProtectedTransactions === true && (process.env.RAIL_SIGNING_SECRET ?? "").trim().length >= 32;
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

  async issueCredential(owner: string, agentId: string, input: unknown) {
    if (!isRecord(input)) invalid();
    const seconds = ttl(input.ttlSeconds);
    const scope = input.scope ?? "payments:propose";
    if (scope !== "payments:propose" && scope !== "payments:execute") invalid();
    if (scope === "payments:execute" && !this.executionEnabled) throw new RequestError(503, "agent_execution_unavailable", "protected agent execution is unavailable");
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId);
      const count = await client.query("SELECT count(*) FROM rail_agent_credentials WHERE agent_id = $1", [agentId]);
      if (Number(count.rows[0].count) >= 100) throw new RequestError(409, "credential_capacity", "agent credential capacity reached");
      const token = `rail_agent_${randomBytes(32).toString("base64url")}`;
      const credentialId = randomUUID();
      const result = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_agent_credentials(credential_id, agent_id, token_hash, scope, created_at, expires_at)
        SELECT $1, $2, $3, $5, now, now + $4 * interval '1 second' FROM timestamp RETURNING expires_at`,
        [credentialId, agentId, createHash("sha256").update(token).digest("hex"), seconds, scope]);
      await this.audit(client, "agent.credential_issued", owner, { agentId, credentialId, scope });
      return { credentialId, agentId, scope, expiresAt: date(result.rows[0].expires_at), token, executionEnabled: scope === "payments:execute" && this.executionEnabled };
    });
  }

  async resolveCredential(token: unknown) {
    if (typeof token !== "string" || !/^rail_agent_[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const result = await this.pool.query(`SELECT credential.credential_id, credential.agent_id, credential.scope, credential.expires_at
      FROM rail_agent_credentials credential JOIN rail_agents agent ON agent.agent_id = credential.agent_id
      WHERE credential.token_hash = $1 AND credential.revoked_at IS NULL AND credential.expires_at > clock_timestamp()
        AND agent.status = 'active'`, [createHash("sha256").update(token).digest("hex")]);
    if (!result.rows[0]) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const row = result.rows[0];
    return { credentialId: String(row.credential_id), agentId: String(row.agent_id), scope: String(row.scope),
      expiresAt: date(row.expires_at), executionEnabled: row.scope === "payments:execute" && this.executionEnabled };
  }

  async listCredentials(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query("SELECT credential_id, scope, created_at, expires_at, revoked_at FROM rail_agent_credentials WHERE agent_id = $1 ORDER BY created_at, credential_id LIMIT 100", [agentId]);
      return result.rows.map(row => ({ credentialId: String(row.credential_id), scope: String(row.scope), createdAt: date(row.created_at),
        expiresAt: date(row.expires_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null }));
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
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId);
      const count = await client.query("SELECT count(*) FROM rail_agent_mandates WHERE agent_id = $1", [agentId]);
      if (Number(count.rows[0].count) >= 100) throw new RequestError(409, "mandate_capacity", "agent mandate capacity reached");
      const wallets = await client.query("SELECT wallet_id FROM wallets WHERE wallet_id = ANY($1::text[]) AND currency = $2", [[owner, ...input.allowedReceiverWalletIds], input.currency]);
      if (wallets.rowCount !== input.allowedReceiverWalletIds.length + 1) invalid();
      const result = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_agent_mandates(mandate_id, agent_id, owner_wallet_id, mode, currency, per_payment_limit_minor,
          total_budget_minor, allowed_receiver_wallet_ids, created_at, expires_at)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, now, now + $9 * interval '1 second' FROM timestamp RETURNING *`,
        [randomUUID(), agentId, owner, input.mode, input.currency, input.perPaymentLimitMinor, input.totalBudgetMinor, input.allowedReceiverWalletIds, input.ttlSeconds]);
      const mandate = mapMandate(result.rows[0], this.executionEnabled);
      await this.authorityEvidence!.persistOwner(client, mandate.mandateId, principal);
      await this.audit(client, "agent.mandate_created", owner, { agentId, mandateId: mandate.mandateId });
      return mandate;
    });
  }

  async listMandates(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "expired", "deadline_expired");
      const result = await client.query("SELECT *, expires_at <= clock_timestamp() AS expired FROM rail_agent_mandates WHERE agent_id = $1 ORDER BY created_at, mandate_id LIMIT 100", [agentId]);
      return result.rows.map(row => mapMandate(row, this.executionEnabled));
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
      return mapMandate(result.rows[0], this.executionEnabled);
    });
  }

  private async credentialForMutation(client: PoolClient, token: unknown, requireExecution = false) {
    if (typeof token !== "string" || !/^rail_agent_[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const hash = createHash("sha256").update(token).digest("hex");
    const lookup = await client.query(`SELECT agent.agent_id, agent.owner_wallet_id FROM rail_agent_credentials credential
      JOIN rail_agents agent ON agent.agent_id = credential.agent_id WHERE credential.token_hash = $1`, [hash]);
    if (!lookup.rows[0]) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    // Same agent-first lock order as owner revocation and credential issuance.
    const agent = await this.ownedAgent(client, lookup.rows[0].owner_wallet_id, lookup.rows[0].agent_id, false);
    const credential = await client.query(`SELECT credential_id, scope FROM rail_agent_credentials WHERE token_hash = $1
      AND agent_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, [hash, agent.agent_id]);
    if (agent.status !== "active" || !credential.rowCount) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    if (requireExecution && credential.rows[0].scope !== "payments:execute") throw new RequestError(403, "agent_execution_scope_required", "execution scope is required");
    return { ...agent, credentialId: String(credential.rows[0].credential_id) };
  }

  private async releaseIntents(client: PoolClient, agentId: string, status: "expired" | "rejected", reason: string, mandateId?: string) {
    const released = await client.query(`UPDATE rail_agent_intents intent SET status = $2, terminal_reason = $3
      WHERE agent_id = $1 AND status IN ('pending','approved') AND ($4::uuid IS NULL OR mandate_id = $4)
        AND ($2 = 'rejected' OR expires_at <= clock_timestamp() OR EXISTS
          (SELECT 1 FROM rail_agent_mandates mandate WHERE mandate.mandate_id = intent.mandate_id AND mandate.expires_at <= clock_timestamp()))
      RETURNING mandate_id, amount_minor`, [agentId, status, reason, mandateId ?? null]);
    const totals = new Map<string, bigint>();
    for (const row of released.rows) totals.set(row.mandate_id, (totals.get(row.mandate_id) ?? 0n) + BigInt(row.amount_minor));
    for (const [id, amount] of totals) {
      const changed = await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor - $2 WHERE mandate_id = $1 AND reserved_budget_minor >= $2 RETURNING mandate_id", [id, amount.toString()]);
      if (changed.rowCount !== 1) throw new Error("agent_budget_reservation_mismatch");
    }
    if (released.rowCount) await this.audit(client, "agent.intents_released", String((await client.query("SELECT owner_wallet_id FROM rail_agents WHERE agent_id = $1", [agentId])).rows[0].owner_wallet_id),
      { agentId, count: released.rowCount, reason });
  }

  async createIntent(token: unknown, value: unknown) {
    if (!isRecord(value) || !isAgentId(value.mandateId) || !isSafeText(value.clientRequestId, 8, 128) ||
        !isSafeText(value.receiverWalletId, 3, 128) || !isValidAmountMinor(value.amountMinor) || !isCurrency(value.currency)) invalid();
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
    return this.transaction(async client => {
      const agent = await this.credentialForMutation(client, token);
      if (input.checkout && input.checkout.fundingSource.walletId !== agent.owner_wallet_id)
        throw new RequestError(403, "checkout_funding_denied", "checkout funding must use the owner's internal wallet");
      await this.releaseIntents(client, agent.agent_id, "expired", "deadline_expired");
      const proposal = createHash("sha256").update(JSON.stringify([attestation ? "rail:agent-proposal:v3" : input.checkout ? "rail:agent-proposal:v2" : "rail:agent-proposal:v1", agent.agent_id, input.mandateId,
        input.clientRequestId, input.receiverWalletId, input.amountMinor, input.currency, input.ttlSeconds,
        ...(input.checkout ? [checkoutTuple(input.checkout)] : []), ...(attestation ? [proofTuple] : [])])).digest("hex");
      const previous = await client.query("SELECT * FROM rail_agent_intents WHERE agent_id = $1 AND client_request_id = $2", [agent.agent_id, input.clientRequestId]);
      if (previous.rows[0]) {
        if (previous.rows[0].proposal_fingerprint !== proposal) throw new RequestError(409, "intent_request_reused", "intent request ID is already bound to different data");
        return mapIntent(previous.rows[0], this.executionEnabled);
      }
      const policy = await client.query(`SELECT *, expires_at > clock_timestamp() AS valid FROM rail_agent_mandates
        WHERE mandate_id = $1 AND agent_id = $2 AND owner_wallet_id = $3 FOR UPDATE`, [input.mandateId, agent.agent_id, agent.owner_wallet_id]);
      const mandate = policy.rows[0];
      if (!mandate) throw new RequestError(404, "mandate_not_found", "mandate not found");
      if (!mandate.valid || mandate.revoked_at) throw new RequestError(409, "mandate_inactive", "mandate is inactive");
      if (mandate.consent_receipt_version !== 1) throw new RequestError(409, "new_agent_owner_consent_required", "legacy mandate requires fresh owner consent");
      if (mandate.currency !== input.currency || input.amountMinor > Number(mandate.per_payment_limit_minor) ||
          !mandate.allowed_receiver_wallet_ids.includes(input.receiverWalletId) || input.receiverWalletId === agent.owner_wallet_id) {
        throw new RequestError(403, "mandate_policy_denied", "intent is outside mandate policy");
      }
      if (!this.authorityEvidence) throw new RequestError(503, "agent_authority_unavailable", "protected mandate consent is not configured");
      try { await this.authorityEvidence.verifyMandateConsent(client, input.mandateId); }
      catch { throw new RequestError(503, "agent_owner_evidence_unavailable", "owner mandate consent cannot be verified"); }
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
      const time = await client.query("WITH timestamp AS (SELECT clock_timestamp() AS now) SELECT now AS created_at, LEAST(now + $1 * interval '1 second', $2::timestamptz, $3::timestamptz) AS expires_at FROM timestamp", [input.ttlSeconds, mandate.expires_at, input.checkout?.expiresAt ?? null]);
      const createdAt = date(time.rows[0].created_at), expiresAt = date(time.rows[0].expires_at), intentId = randomUUID();
      if (expiresAt <= createdAt) throw new RequestError(409, "quote_expired", "checkout quote has expired");
      const fingerprint = createHash("sha256").update(JSON.stringify([attestation ? "rail:agent-intent:v3" : input.checkout ? "rail:agent-intent:v2" : "rail:agent-intent:v1", intentId, agent.agent_id, input.mandateId,
        agent.owner_wallet_id, input.receiverWalletId, input.amountMinor, input.currency, createdAt, expiresAt,
        ...(input.checkout ? [checkoutTuple(input.checkout)] : []), ...(attestation ? [proofTuple] : [])])).digest("hex");
      const result = await client.query(`INSERT INTO rail_agent_intents(intent_id, agent_id, mandate_id, owner_wallet_id,
        client_request_id, proposal_fingerprint, request_fingerprint, receiver_wallet_id, amount_minor, currency, status, created_at, expires_at, checkout, merchant_attestation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14::jsonb,$15::jsonb) RETURNING *`,
        [intentId, agent.agent_id, input.mandateId, agent.owner_wallet_id, input.clientRequestId, proposal, fingerprint,
          input.receiverWalletId, input.amountMinor, input.currency, mandate.mode === "budgeted" ? "approved" : "pending", createdAt, expiresAt,
          input.checkout ? JSON.stringify(input.checkout) : null, attestation ? JSON.stringify(attestation) : null]);
      await this.audit(client, "agent.intent_created", agent.owner_wallet_id, { agentId: agent.agent_id, intentId, mandateId: input.mandateId,
        status: result.rows[0].status, requestFingerprint: fingerprint });
      return mapIntent(result.rows[0], this.executionEnabled);
    });
  }

  async listIntents(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "expired", "deadline_expired");
      return (await client.query("SELECT * FROM rail_agent_intents WHERE agent_id = $1 ORDER BY created_at, intent_id LIMIT 1000", [agentId])).rows.map(row => mapIntent(row, this.executionEnabled));
    });
  }

  async listAgentIntents(token: unknown) {
    return this.transaction(async client => {
      const agent = await this.credentialForMutation(client, token);
      await this.releaseIntents(client, agent.agent_id, "expired", "deadline_expired");
      return (await client.query("SELECT * FROM rail_agent_intents WHERE agent_id = $1 ORDER BY created_at, intent_id LIMIT 1000", [agent.agent_id])).rows.map(row => mapIntent(row, this.executionEnabled));
    });
  }

  async decideIntent(owner: string, agentId: string, intentId: string, value: unknown, principal: OwnerPrincipal = { walletId: owner, method: "trusted_library" }) {
    if (!isAgentId(intentId) || !isRecord(value) || (value.decision !== "approve" && value.decision !== "reject") ||
        typeof value.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.requestFingerprint)) invalid();
    const decision = value.decision, fingerprint = value.requestFingerprint;
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      await this.releaseIntents(client, agentId, "expired", "deadline_expired");
      const result = await client.query("SELECT * FROM rail_agent_intents WHERE intent_id = $1 AND agent_id = $2 AND owner_wallet_id = $3 FOR UPDATE", [intentId, agentId, owner]);
      const intent = result.rows[0];
      if (!intent) throw new RequestError(404, "intent_not_found", "intent not found");
      if (intent.request_fingerprint !== fingerprint) throw new RequestError(409, "intent_fingerprint_mismatch", "approval does not match the exact intent");
      if (intent.status === "expired" || intent.status === "rejected" || intent.status === "executed") return mapIntent(intent, this.executionEnabled);
      if (decision === "approve") {
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
        return mapIntent(intent, this.executionEnabled);
      }
      if (!this.authorityEvidence) throw new RequestError(503, "agent_authority_unavailable", "protected owner decision is not configured");
      const status = decision === "approve" ? "approved" : "rejected";
      await client.query("UPDATE rail_agent_intents SET status = $2, terminal_reason = $3 WHERE intent_id = $1", [intentId, status, decision === "reject" ? "owner_rejected" : null]);
      if (decision === "reject") await client.query("UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor - $2 WHERE mandate_id = $1", [intent.mandate_id, intent.amount_minor]);
      await this.authorityEvidence.persistOwner(client, intent.mandate_id, principal, { intentId, decision });
      await this.audit(client, `agent.intent_${status}`, owner, { agentId, intentId, requestFingerprint: fingerprint });
      return mapIntent({ ...intent, status, terminal_reason: decision === "reject" ? "owner_rejected" : null }, this.executionEnabled);
    });
  }

  async executeIntent(token: unknown, intentId: string, value: unknown) {
    if (!isAgentId(intentId) || !isRecord(value) || Object.keys(value).length !== 1 ||
        typeof value.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.requestFingerprint)) invalid();
    const fingerprint = value.requestFingerprint;
    if (!this.executionEnabled) throw new RequestError(503, "agent_execution_unavailable", "protected agent execution is unavailable");
    const signingSecret = process.env.RAIL_SIGNING_SECRET!;
    return this.transaction(async client => {
      const agent = await this.credentialForMutation(client, token, true);
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
        return { intent: mapIntent(intent, this.executionEnabled), result: replay.rows[0].result_json };
      }
      if (intent.status !== "approved") throw new RequestError(409, "intent_not_approved", "intent is not approved for execution");
      if (!intent.merchant_attestation && this.merchantQuotes.requiresProof(intent.receiver_wallet_id))
        throw new RequestError(403, "merchant_quote_required", "configured merchant requires a signed checkout");
      if (intent.merchant_attestation) this.merchantQuotes.requireCurrent(intent.checkout, intent.merchant_attestation);
      if (intent.authority_receipt_version !== 1) throw new RequestError(409, "new_agent_intent_required", "legacy intent must be replaced before execution");
      if (intent.owner_evidence_version !== 1 || mandate.consent_receipt_version !== 1)
        throw new RequestError(409, "new_agent_owner_consent_required", "legacy authority requires fresh owner consent and intent");
      try { await this.authorityEvidence!.verifyOwnerAuthority(client, intentId); }
      catch { throw new RequestError(503, "agent_owner_evidence_unavailable", "owner consent or approval cannot be verified"); }
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
      await this.credentialForMutation(client, token, true);
      const spent = await client.query(`UPDATE rail_agent_mandates SET reserved_budget_minor = reserved_budget_minor - $2,
        spent_budget_minor = spent_budget_minor + $2 WHERE mandate_id = $1 AND reserved_budget_minor >= $2
          AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING mandate_id`, [intent.mandate_id, intent.amount_minor]);
      if (spent.rowCount !== 1) throw new RequestError(409, "mandate_inactive", "mandate is inactive");
      const executed = await client.query(`UPDATE rail_agent_intents SET status = 'executed', payment_tx_id = $2, executed_at = clock_timestamp()
        WHERE intent_id = $1 AND status = 'approved' AND expires_at > clock_timestamp() RETURNING *`, [intentId, payment.txId]);
      if (executed.rowCount !== 1) throw new RequestError(409, "intent_expired", "intent expired before execution completed");
      await this.authorityEvidence!.persist(client, intentId, agent.credentialId);
      await this.audit(client, "agent.intent_executed", agent.owner_wallet_id, { agentId: agent.agent_id, intentId, txId: payment.txId, requestFingerprint: fingerprint });
      return { intent: mapIntent(executed.rows[0], this.executionEnabled), result };
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
