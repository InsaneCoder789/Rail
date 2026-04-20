import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentTransaction } from "../domain/types.js";
import { PipelineError } from "../pipeline/errors.js";

/**
 * Canonical UTF-8 string for HMAC. Version this format if you add fields (e.g. `v1:` prefix).
 */
export function canonicalTransactionPayload(txn: PaymentTransaction): string {
  return [
    txn.txId,
    txn.idempotencyKey,
    txn.senderWalletId,
    txn.receiverWalletId,
    String(txn.amountMinor),
    txn.currency,
    txn.channel,
    txn.offlineTokenId ?? "",
    txn.deviceId ?? "",
    txn.createdAt,
  ].join("|");
}

export function verifyTransactionHmac(txn: PaymentTransaction, signatureB64: string | undefined, secret: string): boolean {
  if (!signatureB64) return false;
  const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(canonicalTransactionPayload(txn)).digest();
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(sig, expected);
}

/** Client-side helper for tests / mobile integration (never ship the server secret to clients for request signing). */
export function signTransactionHmac(txn: PaymentTransaction, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(canonicalTransactionPayload(txn)).digest("base64");
}

/**
 * When RAIL_REQUIRE_TX_SIGNATURE=true, every execute/sync payload must include paymentSignature (HMAC-SHA256, base64).
 * Production: replace secret comparison with HSM/PKCS#11 or cloud KMS verify using the same canonical payload.
 */
export async function verifyTransactionSignatureIfRequired(txn: PaymentTransaction): Promise<void> {
  const requireSig = process.env.RAIL_REQUIRE_TX_SIGNATURE === "true";
  if (!requireSig) return;
  const secret = process.env.RAIL_SIGNING_SECRET ?? "";
  if (!secret) {
    throw new Error("RAIL_REQUIRE_TX_SIGNATURE requires RAIL_SIGNING_SECRET");
  }
  if (!verifyTransactionHmac(txn, txn.paymentSignature, secret)) {
    throw new PipelineError("invalid_payment_signature", "SIGNATURE_INVALID", false);
  }
}
