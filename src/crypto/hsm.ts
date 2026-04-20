/**
 * HSM integration boundary for Rail.
 *
 * Today: request integrity uses HMAC (`transactionSigning.ts`) with `RAIL_SIGNING_SECRET`
 * (rotate via KMS or sealed env in production).
 *
 * Replace with one of:
 * - **AWS CloudHSM** / **Azure Dedicated HSM** with PKCS#11 — load vendor `.so`, use `graphene-pk11` / `pkcs11js` in Node.
 * - **Cloud KMS** (AWS KMS, GCP KMS, Azure Key Vault) — sign/verify via HTTP API; map `canonicalTransactionPayload` to `Message` field.
 * - **Thales Luna / Utimaco** — PKCS#11 CTK via vendor Node bindings.
 *
 * Keep `canonicalTransactionPayload` stable so mobile and server agree on bytes being attested.
 */
export type HsmMode = "none" | "hmac_env" | "kms" | "pkcs11";

export function resolveHsmMode(): HsmMode {
  if (process.env.RAIL_PKCS11_MODULE_PATH) return "pkcs11";
  if (process.env.RAIL_KMS_KEY_ID) return "kms";
  if (process.env.RAIL_SIGNING_SECRET) return "hmac_env";
  return "none";
}
