import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { AgentCheckout } from "../persistence/agentAuthority.js";
import { isRecord, isSafeText } from "../server/validation.js";
import { RequestError } from "../server/http.js";

export interface MerchantQuoteProof {
  readonly keyId: string;
  readonly signature: string;
}
export interface MerchantAttestation extends MerchantQuoteProof {
  readonly version: 1;
  readonly publicKey: string;
  readonly keyFingerprint: string;
}

export function parseMerchantQuoteProof(value: unknown): MerchantQuoteProof {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "keyId") || !Object.hasOwn(value, "signature") ||
      !isSafeText(value.keyId, 3, 80) || typeof value.signature !== "string" || value.signature.length !== 88 ||
      Buffer.from(value.signature, "base64").length !== 64 || Buffer.from(value.signature, "base64").toString("base64") !== value.signature)
    throw new RequestError(422, "invalid_merchant_quote_proof", "invalid merchant quote proof");
  return Object.freeze({ keyId: value.keyId, signature: value.signature });
}

/** Merchant signature covers the owner funding audience as well as every checkout field. */
export function merchantQuoteBytes(checkout: AgentCheckout, keyId: string): Buffer {
  return Buffer.from(JSON.stringify(["rail:merchant-checkout:v1", keyId, checkout.version, checkout.merchantWalletId,
    checkout.quoteId, checkout.quoteVersion, checkout.subtotalMinor, checkout.feeMinor, checkout.totalMinor, checkout.currency,
    checkout.expiresAt, checkout.fundingSource.type, checkout.fundingSource.walletId]), "utf8");
}

function publicKey(raw: unknown): { key: KeyObject; encoded: string; fingerprint: string } {
  if (typeof raw !== "string" || raw.length !== 60 || Buffer.from(raw, "base64").toString("base64") !== raw) throw new Error();
  const der = Buffer.from(raw, "base64");
  const key = createPublicKey({ key: der, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519" || !key.export({ type: "spki", format: "der" }).equals(der)) throw new Error();
  return { key, encoded: raw, fingerprint: createHash("sha256").update(der).digest("hex") };
}

/** Snapshot verification proves signature consistency, not current operator trust. */
export function verifyMerchantAttestation(checkout: AgentCheckout, value: MerchantAttestation): void {
  try {
    if (!isRecord(value) || Object.keys(value).length !== 5 || value.version !== 1) throw new Error();
    const proof = parseMerchantQuoteProof({ keyId: value.keyId, signature: value.signature });
    const key = publicKey(value.publicKey);
    if (key.fingerprint !== value.keyFingerprint || !verify(null, merchantQuoteBytes(checkout, proof.keyId), key.key, Buffer.from(proof.signature, "base64"))) throw new Error();
  } catch { throw new Error("merchant_quote_attestation_invalid"); }
}

export class MerchantQuoteRegistry {
  private readonly keys = new Map<string, { merchantWalletId: string; status: "active" | "revoked"; key: KeyObject; encoded: string; fingerprint: string }>();

  constructor(raw?: string) {
    if (raw === undefined || raw === "") return;
    try {
      if (Buffer.byteLength(raw) > 65536) throw new Error();
      const values: unknown = JSON.parse(raw);
      if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new Error();
      const material = new Set<string>();
      for (const value of values) {
        if (!isRecord(value) || Object.keys(value).length !== 4 || (value.status !== "active" && value.status !== "revoked") || !isSafeText(value.keyId, 3, 80) ||
            !isSafeText(value.merchantWalletId, 3, 128) || !Object.hasOwn(value, "publicKey") || this.keys.has(value.keyId)) throw new Error();
        const key = publicKey(value.publicKey);
        if (material.has(key.fingerprint)) throw new Error();
        material.add(key.fingerprint);
        this.keys.set(value.keyId, { merchantWalletId: value.merchantWalletId, status: value.status, ...key });
      }
    } catch { throw new Error("INVALID_MERCHANT_QUOTE_KEYS"); }
  }

  requiresProof(merchantWalletId: string): boolean {
    return [...this.keys.values()].some(key => key.merchantWalletId === merchantWalletId);
  }

  authenticate(checkout: AgentCheckout, proof: MerchantQuoteProof): MerchantAttestation {
    proof = parseMerchantQuoteProof(proof);
    const key = this.keys.get(proof.keyId);
    if (!key || key.status !== "active" || key.merchantWalletId !== checkout.merchantWalletId ||
        !verify(null, merchantQuoteBytes(checkout, proof.keyId), key.key, Buffer.from(proof.signature, "base64")))
      throw new RequestError(403, "merchant_quote_denied", "merchant quote is not signed by a trusted recipient key");
    return Object.freeze({ version: 1, keyId: proof.keyId, signature: proof.signature, publicKey: key.encoded, keyFingerprint: key.fingerprint });
  }

  requireCurrent(checkout: AgentCheckout, attestation: MerchantAttestation): void {
    verifyMerchantAttestation(checkout, attestation);
    const current = this.authenticate(checkout, { keyId: attestation.keyId, signature: attestation.signature });
    if (current.keyFingerprint !== attestation.keyFingerprint) throw new RequestError(403, "merchant_quote_denied", "merchant key has changed");
  }
}
