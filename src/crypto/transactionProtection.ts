import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PaymentTransaction } from "../domain/types.js";
import { canonicalTransactionPayload } from "./transactionSigning.js";
import { isPaymentTransaction } from "../server/validation.js";

export interface TransactionProtectionKeys {
  readonly keyId: string;
  readonly encryptionKey: Uint8Array;
  readonly authenticationKey: Uint8Array;
}

export interface ProtectedTransaction {
  readonly version: 1;
  readonly algorithm: "AES-256-GCM+HMAC-SHA256";
  readonly keyId: string;
  readonly txId: string;
  readonly requestFingerprint: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly mac: string;
}

/** Explicit server-side key ring. Keep retired versions until retained evidence expires. */
export class TransactionKeyRing {
  private readonly keys = new Map<string, TransactionProtectionKeys>();
  readonly maxRecordsPerKey: number;

  constructor(readonly activeKeyId: string, keys: readonly TransactionProtectionKeys[], maxRecordsPerKey = 1_000_000) {
    if (!Number.isSafeInteger(maxRecordsPerKey) || maxRecordsPerKey < 1 || maxRecordsPerKey > 1_000_000 || keys.length < 1 || keys.length > 32) {
      throw new Error("invalid_transaction_key_ring");
    }
    const material = new Set<string>();
    for (const key of keys) {
      validateKeys(key);
      if (this.keys.has(key.keyId)) throw new Error("duplicate_transaction_key_id");
      // Prevent aliases or cross-purpose reuse from hiding key reuse during rotation.
      for (const value of [key.encryptionKey, key.authenticationKey]) {
        const digest = createHash("sha256").update(value).digest("hex");
        if (material.has(digest)) throw new Error("duplicate_transaction_key_material");
        material.add(digest);
      }
      this.keys.set(key.keyId, { keyId: key.keyId, encryptionKey: Buffer.from(key.encryptionKey), authenticationKey: Buffer.from(key.authenticationKey) });
    }
    this.get(activeKeyId);
    this.maxRecordsPerKey = maxRecordsPerKey;
  }

  get(keyId: string): TransactionProtectionKeys {
    const key = this.keys.get(keyId);
    if (!key) throw new Error("transaction_evidence_key_unavailable");
    return { keyId, encryptionKey: Buffer.from(key.encryptionKey), authenticationKey: Buffer.from(key.authenticationKey) };
  }
}

export function loadTransactionKeyRing(raw: string | undefined): TransactionKeyRing {
  if (!raw || raw.length > 16384) throw new Error("TRANSACTION_EVIDENCE_KEY_RING_REQUIRED");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.activeKeyId !== "string" || !Array.isArray(value.keys)) throw new Error();
    const keys = value.keys.map((key: Record<string, unknown>) => {
      if (!key || typeof key.keyId !== "string" || typeof key.encryptionKey !== "string" || typeof key.authenticationKey !== "string") throw new Error();
      return { keyId: key.keyId, encryptionKey: decode(key.encryptionKey, 32), authenticationKey: decode(key.authenticationKey, 32) };
    });
    return new TransactionKeyRing(value.activeKeyId, keys, value.maxRecordsPerKey ?? 1_000_000);
  } catch { throw new Error("INVALID_TRANSACTION_EVIDENCE_KEY_RING"); }
}

function validateKeys(keys: TransactionProtectionKeys): void {
  if (!keys || typeof keys.keyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(keys.keyId) ||
      !(keys.encryptionKey instanceof Uint8Array) || !(keys.authenticationKey instanceof Uint8Array) ||
      keys.encryptionKey.length !== 32 || keys.authenticationKey.length !== 32 ||
      timingSafeEqual(keys.encryptionKey, keys.authenticationKey)) throw new Error("invalid_transaction_protection_keys");
}

function fingerprint(payload: string): string { return createHash("sha256").update(payload).digest("hex"); }
function aad(record: Pick<ProtectedTransaction, "keyId" | "txId" | "requestFingerprint">): Buffer {
  return Buffer.from(JSON.stringify(["rail:protected-transaction:v1", record.keyId, record.txId, record.requestFingerprint]), "utf8");
}
function authenticatedBytes(record: Omit<ProtectedTransaction, "mac">): string {
  return JSON.stringify([record.version, record.algorithm, record.keyId, record.txId, record.requestFingerprint,
    record.nonce, record.ciphertext, record.tag]);
}
function decode(value: string, bytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > 131072) throw new Error("invalid_protected_transaction");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (bytes !== undefined && decoded.length !== bytes)) throw new Error("invalid_protected_transaction");
  return decoded;
}

/** Server-side protection: never distribute these symmetric keys to frontend/device clients. */
export function protectTransaction(txn: PaymentTransaction, keys: TransactionProtectionKeys): ProtectedTransaction {
  validateKeys(keys);
  if (!isPaymentTransaction(txn) || !txn.authorizationId) throw new Error("invalid_transaction_for_protection");
  const payload = canonicalTransactionPayload(txn);
  const nonce = randomBytes(12);
  const record = { version: 1 as const, algorithm: "AES-256-GCM+HMAC-SHA256" as const,
    keyId: keys.keyId, txId: txn.txId, requestFingerprint: fingerprint(payload) };
  const cipher = createCipheriv("aes-256-gcm", keys.encryptionKey, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(record));
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const encrypted = { ...record, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  return { ...encrypted, mac: createHmac("sha256", keys.authenticationKey).update(authenticatedBytes(encrypted)).digest("base64") };
}

/** Caller supplies the trusted database binding; envelope metadata is not authority. */
export function verifyAndDecryptTransaction(record: ProtectedTransaction,
  expected: { txId: string; requestFingerprint: string }, keys: TransactionProtectionKeys): string {
  validateKeys(keys);
  try {
    if (!record || record.version !== 1 || record.algorithm !== "AES-256-GCM+HMAC-SHA256" || record.keyId !== keys.keyId ||
        record.txId !== expected.txId || record.requestFingerprint !== expected.requestFingerprint ||
        !/^[a-f0-9]{64}$/.test(record.requestFingerprint)) throw new Error("binding_mismatch");
    const nonce = decode(record.nonce, 12);
    const ciphertext = decode(record.ciphertext);
    const tag = decode(record.tag, 16);
    const mac = decode(record.mac, 32);
    const expectedMac = createHmac("sha256", keys.authenticationKey).update(authenticatedBytes(record)).digest();
    if (!timingSafeEqual(mac, expectedMac)) throw new Error("mac_mismatch");
    const decipher = createDecipheriv("aes-256-gcm", keys.encryptionKey, nonce, { authTagLength: 16 });
    decipher.setAAD(aad(record));
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (fingerprint(payload) !== expected.requestFingerprint) throw new Error("fingerprint_mismatch");
    return payload;
  } catch { throw new Error("protected_transaction_verification_failed"); }
}

/** Hash only: verify and persist the envelope before batching. Not a settlement receipt. */
export function protectedTransactionCommitment(record: ProtectedTransaction): string {
  return createHash("sha256").update(JSON.stringify(["rail:protected-commitment:v1", authenticatedBytes(record), record.mac])).digest("hex");
}
