import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { TransactionKeyRing, loadTransactionKeyRing } from "../crypto/transactionProtection.js";
import { protectRecord, decryptRecord, type RiskEnvelope } from "./riskProtection.js";
import type { OwnerPrincipal } from "../server/types.js";
import { RequestError } from "../server/http.js";
import type { AgentCheckout } from "./agentAuthority.js";
import { verifyMerchantAttestation, type MerchantAttestation } from "../crypto/merchantQuotes.js";

export interface AgentAuthorityReceipt {
  readonly version: 1;
  readonly assurance: "server_observed_authority";
  readonly ownerWalletId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly intentId: string;
  readonly txId: string;
  readonly intentFingerprint: string;
  readonly paymentFingerprint: string;
  readonly credentialId: string;
  readonly credentialScope: "payments:execute";
  readonly consentSource: "exact_approved_intent" | "advance_budget_mandate";
  readonly receiverWalletId: string;
  readonly amountMinor: number;
  readonly executedAt: string;
  readonly mandateConsentCommitment?: string;
  readonly approvalCommitment?: string;
  readonly checkout?: AgentCheckout;
  readonly quoteAssurance?: "agent_proposed_unverified" | "configured_merchant_signature";
  readonly merchantAttestation?: MerchantAttestation;
  readonly policy: {
    readonly mode: "approval_required" | "budgeted";
    readonly currency: string;
    readonly perPaymentLimitMinor: number;
    readonly totalBudgetMinor: number;
    readonly allowedReceiverWalletIds: readonly string[];
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

// Reuse the existing bounded authenticated envelope implementation with an independent
// ring and a domain-separated binding. This is not a risk assessment or user signature.
function binding(txId: string, paymentFingerprint: string) {
  return { txId, requestFingerprint: createHash("sha256").update(JSON.stringify(
    ["rail:agent-authority:v1", txId, paymentFingerprint])).digest("hex") };
}
function commitment(envelope: RiskEnvelope): string {
  return createHash("sha256").update(JSON.stringify(["rail:agent-authority-envelope:v1", envelope.version, envelope.purpose,
    envelope.keyId, envelope.txId, envelope.requestFingerprint, envelope.payloadHash, envelope.nonce,
    envelope.ciphertext, envelope.tag, envelope.mac])).digest("hex");
}
export function loadAgentAuthorityKeyRing(raw: string, otherRings: readonly TransactionKeyRing[]): TransactionKeyRing {
  let ring: TransactionKeyRing;
  try { ring = loadTransactionKeyRing(raw); } catch { throw new Error("INVALID_AGENT_AUTHORITY_KEY_RING"); }
  const used = new Set(otherRings.flatMap(other => other.materialFingerprints()));
  if (ring.materialFingerprints().some(value => used.has(value))) throw new Error("AGENT_AUTHORITY_KEYS_MUST_BE_INDEPENDENT");
  return ring;
}

const SELECT = `SELECT intent.*, execution.request_fingerprint AS payment_fingerprint,
  mandate.mode, mandate.currency AS policy_currency, mandate.per_payment_limit_minor, mandate.total_budget_minor,
  mandate.allowed_receiver_wallet_ids, mandate.created_at AS policy_created_at, mandate.expires_at AS policy_expires_at,
  credential.credential_id, credential.scope, credential.created_at AS credential_created_at, credential.expires_at AS credential_expires_at
  FROM rail_agent_intents intent JOIN rail_payment_executions execution ON execution.tx_id = intent.payment_tx_id
  JOIN rail_agent_mandates mandate ON mandate.mandate_id = intent.mandate_id
  JOIN rail_agent_credentials credential ON credential.agent_id = intent.agent_id`;

interface AuthorityRow {
  checkout: AgentCheckout | null;
  merchant_attestation: MerchantAttestation | null;
  owner_evidence_version: number | null;
  status: string; owner_wallet_id: string; agent_id: string; mandate_id: string; intent_id: string; payment_tx_id: string;
  request_fingerprint: string; payment_fingerprint: string; credential_id: string; scope: string; receiver_wallet_id: string;
  amount_minor: string; executed_at: Date; credential_created_at: Date; credential_expires_at: Date;
  mode: "approval_required" | "budgeted"; policy_currency: string; per_payment_limit_minor: string;
  total_budget_minor: string; allowed_receiver_wallet_ids: string[]; policy_created_at: Date; policy_expires_at: Date;
}
function receipt(row: AuthorityRow): AgentAuthorityReceipt {
  if (row.merchant_attestation) verifyMerchantAttestation(row.checkout!, row.merchant_attestation);
  if (row.status !== "executed" || row.scope !== "payments:execute" ||
      new Date(row.executed_at) < new Date(row.credential_created_at) || new Date(row.executed_at) >= new Date(row.credential_expires_at)) {
    throw new Error("agent_authority_binding_invalid");
  }
  return { version: 1, assurance: "server_observed_authority", ownerWalletId: row.owner_wallet_id,
    agentId: row.agent_id, mandateId: row.mandate_id, intentId: row.intent_id, txId: row.payment_tx_id,
    intentFingerprint: row.request_fingerprint, paymentFingerprint: row.payment_fingerprint,
    credentialId: row.credential_id, credentialScope: "payments:execute",
    consentSource: row.mode === "budgeted" ? "advance_budget_mandate" : "exact_approved_intent",
    receiverWalletId: row.receiver_wallet_id, amountMinor: Number(row.amount_minor), executedAt: new Date(row.executed_at).toISOString(),
    ...(row.checkout ? { checkout: row.checkout, quoteAssurance: row.merchant_attestation ? "configured_merchant_signature" as const : "agent_proposed_unverified" as const,
      ...(row.merchant_attestation ? { merchantAttestation: row.merchant_attestation } : {}) } : {}),
    policy: { mode: row.mode, currency: row.policy_currency, perPaymentLimitMinor: Number(row.per_payment_limit_minor),
      totalBudgetMinor: Number(row.total_budget_minor), allowedReceiverWalletIds: [...row.allowed_receiver_wallet_ids].sort(),
      createdAt: new Date(row.policy_created_at).toISOString(), expiresAt: new Date(row.policy_expires_at).toISOString() } };
}

export class AgentEvidenceStore {
  constructor(private readonly ring: TransactionKeyRing) {}

  private async protect(client: PoolClient, value: object, expected: { txId: string; requestFingerprint: string }, purpose: RiskEnvelope["purpose"]) {
    const key = this.ring.get(this.ring.activeKeyId), keyFingerprint = createHash("sha256").update(key.encryptionKey).digest("hex");
    const quota = await client.query(`INSERT INTO rail_agent_evidence_key_usage(key_fingerprint, record_count) VALUES ($1,1)
      ON CONFLICT (key_fingerprint) DO UPDATE SET record_count = rail_agent_evidence_key_usage.record_count + 1
      WHERE rail_agent_evidence_key_usage.record_count < $2 RETURNING record_count`, [keyFingerprint, this.ring.maxRecordsPerKey]);
    if (quota.rowCount !== 1) throw new Error("agent_authority_key_rotation_required");
    const envelope = protectRecord(value, expected, key, purpose);
    await client.query("INSERT INTO rail_agent_evidence_nonces(key_fingerprint, nonce) VALUES ($1,$2)", [keyFingerprint, envelope.nonce]);
    return { envelope, keyFingerprint, commitment: commitment(envelope) };
  }

  private verify(stored: { envelope: RiskEnvelope; key_fingerprint: string; nonce: string; commitment: string }, expected: { txId: string; requestFingerprint: string }, purpose: RiskEnvelope["purpose"]) {
    const key = this.ring.get(stored.envelope.keyId);
    if (stored.nonce !== stored.envelope.nonce || stored.key_fingerprint !== createHash("sha256").update(key.encryptionKey).digest("hex") || commitment(stored.envelope) !== stored.commitment)
      throw new Error("agent_authority_verification_failed");
    return decryptRecord(stored.envelope, expected, key, purpose);
  }

  private async ownerBody(client: PoolClient, mandateId: string, intentId?: string) {
    const found = await client.query("SELECT * FROM rail_agent_mandates WHERE mandate_id=$1", [mandateId]);
    const row = found.rows[0];
    if (!row) throw new Error("agent_owner_evidence_binding_missing");
    const body = { version: 1, ownerWalletId: String(row.owner_wallet_id), agentId: String(row.agent_id), mandateId,
      policy: { mode: String(row.mode), currency: String(row.currency), perPaymentLimitMinor: Number(row.per_payment_limit_minor),
        totalBudgetMinor: Number(row.total_budget_minor), allowedReceiverWalletIds: [...row.allowed_receiver_wallet_ids].sort(),
        createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() } };
    if (!intentId) return body;
    const intents = await client.query("SELECT * FROM rail_agent_intents WHERE intent_id=$1 AND mandate_id=$2", [intentId, mandateId]);
    const intent = intents.rows[0];
    if (!intent) throw new Error("agent_owner_evidence_binding_missing");
    if (intent.merchant_attestation) verifyMerchantAttestation(intent.checkout, intent.merchant_attestation);
    return { ...body, intentId, intentFingerprint: String(intent.request_fingerprint), receiverWalletId: String(intent.receiver_wallet_id), amountMinor: Number(intent.amount_minor),
      ...(intent.checkout ? { checkout: intent.checkout, quoteAssurance: intent.merchant_attestation ? "configured_merchant_signature" as const : "agent_proposed_unverified" as const,
        ...(intent.merchant_attestation ? { merchantAttestation: intent.merchant_attestation } : {}) } : {}) };
  }

  /** Owner context comes from trusted authentication, never from request JSON. */
  async persistOwner(client: PoolClient, mandateId: string, principal: OwnerPrincipal, decision?: { intentId: string; decision: "approve" | "reject" }) {
    const body = await this.ownerBody(client, mandateId, decision?.intentId);
    if (principal.walletId !== body.ownerWalletId || (principal.method !== "owner_jwt" && principal.method !== "trusted_library")) throw new Error("agent_owner_context_invalid");
    let authentication: OwnerPrincipal = { walletId: principal.walletId, method: "trusted_library" };
    if (principal.method === "owner_jwt") {
      if (typeof principal.userId !== "string" || !principal.userId.trim() || principal.userId.length > 128 ||
          !Number.isSafeInteger(principal.authVersion) || principal.authVersion! < 0) throw new Error("agent_owner_context_invalid");
      const user = await client.query("SELECT user_id FROM users WHERE user_id=$1 AND wallet_id=$2 AND auth_version=$3 FOR SHARE",
        [principal.userId, principal.walletId, principal.authVersion]);
      if (!user.rowCount) throw new RequestError(401, "invalid_owner_credentials", "owner authentication is no longer valid");
      authentication = { walletId: principal.walletId, method: "owner_jwt", userId: principal.userId, authVersion: principal.authVersion };
    }
    const purpose = decision ? (decision.decision === "approve" ? "agent-approval-v1" : "agent-rejection-v1") : "agent-mandate-v1";
    const subjectId = decision?.intentId ?? mandateId;
    const recordedAt = new Date((await client.query("SELECT clock_timestamp() AS now")).rows[0].now).toISOString();
    const value = { ...body, authentication, recordedAt, decision: decision?.decision ?? "mandate_consent" };
    const expected = this.ownerBinding(purpose, subjectId, body);
    const protectedRecord = await this.protect(client, value, expected, purpose);
    await client.query(`INSERT INTO rail_agent_owner_evidence(subject_id, purpose, mandate_id, intent_id, recorded_at, key_fingerprint, nonce, envelope, commitment)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::jsonb,$9)`, [subjectId, purpose, mandateId, decision?.intentId ?? null,
      recordedAt, protectedRecord.keyFingerprint, protectedRecord.envelope.nonce, JSON.stringify(protectedRecord.envelope), protectedRecord.commitment]);
  }

  private ownerBinding(purpose: string, subjectId: string, body: object) {
    return { txId: subjectId, requestFingerprint: createHash("sha256").update(JSON.stringify(["rail:owner-evidence:v1", purpose, body])).digest("hex") };
  }

  private async readOwner(client: PoolClient, mandateId: string, purpose: "agent-mandate-v1" | "agent-approval-v1", intentId?: string) {
    const subjectId = intentId ?? mandateId, body = await this.ownerBody(client, mandateId, intentId);
    const found = await client.query("SELECT * FROM rail_agent_owner_evidence WHERE subject_id=$1 AND purpose=$2 AND mandate_id=$3", [subjectId, purpose, mandateId]);
    const stored = found.rows[0];
    if (!stored) throw new Error("agent_owner_evidence_missing");
    const decoded = this.verify(stored, this.ownerBinding(purpose, subjectId, body), purpose);
    const auth = decoded.authentication as OwnerPrincipal | undefined;
    if (!auth || auth.walletId !== body.ownerWalletId || (auth.method !== "trusted_library" && auth.method !== "owner_jwt") ||
        (auth.method === "owner_jwt" && (typeof auth.userId !== "string" || !auth.userId.trim() || !Number.isSafeInteger(auth.authVersion) || auth.authVersion! < 0)))
      throw new Error("agent_owner_evidence_invalid");
    const authentication: OwnerPrincipal = auth.method === "owner_jwt"
      ? { walletId: auth.walletId, method: auth.method, userId: auth.userId, authVersion: auth.authVersion }
      : { walletId: auth.walletId, method: auth.method };
    const expected = { ...body, authentication, recordedAt: new Date(stored.recorded_at).toISOString(),
      decision: intentId ? "approve" : "mandate_consent" };
    if (!isDeepStrictEqual(decoded, expected)) throw new Error("agent_owner_evidence_invalid");
    return { commitment: stored.commitment as string, record: decoded };
  }

  async verifyOwnerAuthority(client: PoolClient, intentId: string) {
    const found = await client.query(`SELECT intent.mandate_id, intent.owner_evidence_version, mandate.consent_receipt_version, mandate.mode
      FROM rail_agent_intents intent JOIN rail_agent_mandates mandate ON mandate.mandate_id=intent.mandate_id WHERE intent.intent_id=$1`, [intentId]);
    const row = found.rows[0];
    if (row?.owner_evidence_version !== 1 || row.consent_receipt_version !== 1) throw new Error("new_agent_owner_consent_required");
    const mandate = await this.readOwner(client, row.mandate_id, "agent-mandate-v1");
    const approval = row.mode === "approval_required" ? await this.readOwner(client, row.mandate_id, "agent-approval-v1", intentId) : undefined;
    return { mandate, approval };
  }

  async verifyMandateConsent(client: PoolClient, mandateId: string) {
    return this.readOwner(client, mandateId, "agent-mandate-v1");
  }

  /** Called after intent completion using the same outer financial client. */
  async persist(client: PoolClient, intentId: string, credentialId: string): Promise<void> {
    const found = await client.query<AuthorityRow>(`${SELECT} WHERE intent.intent_id = $1 AND credential.credential_id = $2`, [intentId, credentialId]);
    if (!found.rows[0]) throw new Error("agent_authority_binding_missing");
    const owner = await this.verifyOwnerAuthority(client, intentId);
    const value = { ...receipt(found.rows[0]), mandateConsentCommitment: owner.mandate.commitment,
      ...(owner.approval ? { approvalCommitment: owner.approval.commitment } : {}) };
    const protectedRecord = await this.protect(client, value, binding(value.txId, value.paymentFingerprint), "agent-authority-v1");
    const { envelope, keyFingerprint } = protectedRecord;
    await client.query(`INSERT INTO rail_agent_authority_evidence(intent_id, tx_id, credential_id, payment_fingerprint,
      key_fingerprint, nonce, envelope, commitment) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [intentId, value.txId, credentialId, value.paymentFingerprint, keyFingerprint, envelope.nonce, JSON.stringify(envelope), commitment(envelope)]);
  }

  async read(client: PoolClient, intentId: string, owner: string, agentId: string) {
    const state = await client.query("SELECT status, authority_receipt_version FROM rail_agent_intents WHERE intent_id=$1 AND owner_wallet_id=$2 AND agent_id=$3", [intentId, owner, agentId]);
    if (!state.rows[0]) return undefined;
    if (state.rows[0].status !== "executed") return { status: "not_executed" as const };
    if (state.rows[0].authority_receipt_version === null) return { status: "legacy_unavailable" as const };
    const result = await client.query<AuthorityRow>(`${SELECT} JOIN rail_agent_authority_evidence evidence ON evidence.intent_id = intent.intent_id
      AND evidence.credential_id = credential.credential_id
      WHERE intent.intent_id=$1 AND intent.owner_wallet_id=$2 AND intent.agent_id=$3`, [intentId, owner, agentId]);
    const protectedRow = await client.query("SELECT * FROM rail_agent_authority_evidence WHERE intent_id=$1", [intentId]);
    try {
      const ownerEvidence = result.rows[0]?.owner_evidence_version === 1 ? await this.verifyOwnerAuthority(client, intentId) : undefined;
      const expected = { ...receipt(result.rows[0]), ...(ownerEvidence ? { mandateConsentCommitment: ownerEvidence.mandate.commitment,
        ...(ownerEvidence.approval ? { approvalCommitment: ownerEvidence.approval.commitment } : {}) } : {}) }, stored = protectedRow.rows[0];
      const key = this.ring.get(stored.envelope.keyId);
      if (stored.tx_id !== expected.txId || stored.payment_fingerprint !== expected.paymentFingerprint || stored.nonce !== stored.envelope.nonce ||
          stored.key_fingerprint !== createHash("sha256").update(key.encryptionKey).digest("hex") || commitment(stored.envelope) !== stored.commitment) {
        throw new Error("agent_authority_verification_failed");
      }
      const decoded = decryptRecord(stored.envelope, binding(expected.txId, expected.paymentFingerprint), key, "agent-authority-v1");
      if (!isDeepStrictEqual(decoded, expected)) {
        throw new Error("agent_authority_verification_failed");
      }
      return { status: "verified" as const, commitment: stored.commitment as string, receipt: expected,
        ownerEvidence: ownerEvidence ?? { status: "legacy_unavailable" as const } };
    } catch (error) {
      return { status: "verification_unavailable" as const, reason: error instanceof Error && error.message === "transaction_evidence_key_unavailable"
        ? "key_unavailable" as const : "verification_failed" as const };
    }
  }
}
