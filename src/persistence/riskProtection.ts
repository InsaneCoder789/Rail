import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { TransactionKeyRing, loadTransactionKeyRing, type TransactionProtectionKeys } from "../crypto/transactionProtection.js";

export interface RiskRecord {
  readonly observedAt: string;
  readonly features: unknown;
  readonly assessment: unknown;
  readonly modelStatus: string;
  readonly modelVersion: string | null;
  readonly modelHash: string | null;
  readonly synthetic: boolean | null;
  readonly prediction: unknown;
  readonly anomaly?: { readonly summary: unknown; readonly modelHash: string | null; readonly prediction: unknown };
}
interface Binding { readonly txId: string; readonly requestFingerprint: string; }
interface RiskEnvelope extends Binding {
  readonly version: 1;
  readonly purpose: "risk-v1";
  readonly keyId: string;
  readonly payloadHash: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly mac: string;
}
interface ProtectedRiskSummary {
  readonly envelope: RiskEnvelope;
  readonly commitment: string;
  readonly observed_at: string | Date;
  readonly assessment: unknown;
  readonly model_status: string;
  readonly model_version: string | null;
  readonly synthetic: boolean | null;
  readonly anomaly_summary?: unknown;
}
function aad(record: RiskEnvelope | (Binding & { keyId: string; payloadHash: string })): string {
  return JSON.stringify(["rail:protected-risk:v1", record.keyId, record.txId, record.requestFingerprint, record.payloadHash]);
}
function bytes(record: Omit<RiskEnvelope, "mac">): string {
  return JSON.stringify([record.version, record.purpose, record.keyId, record.txId, record.requestFingerprint,
    record.payloadHash, record.nonce, record.ciphertext, record.tag]);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function decode(value: string, length?: number): Buffer {
  if (typeof value !== "string" || !value.length || value.length > 131072) throw new Error();
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value || (length !== undefined && result.length !== length)) throw new Error();
  return result;
}
export function loadRiskKeyRing(raw: string | undefined, paymentKeys: TransactionKeyRing): TransactionKeyRing {
  if (!raw) throw new Error("RISK_RECORD_KEY_RING_REQUIRED");
  let ring: TransactionKeyRing;
  try { ring = loadTransactionKeyRing(raw); } catch { throw new Error("INVALID_RISK_RECORD_KEY_RING"); }
  const paymentMaterial = new Set(paymentKeys.materialFingerprints());
  if (ring.materialFingerprints().some(value => paymentMaterial.has(value))) throw new Error("RISK_KEYS_MUST_BE_INDEPENDENT");
  return ring;
}
export function protectRiskRecord(value: RiskRecord, expected: Binding, keys: TransactionProtectionKeys): RiskEnvelope {
  new TransactionKeyRing(keys.keyId, [keys]);
  if (!expected.txId || expected.txId.length > 128 || !/^[a-f0-9]{64}$/.test(expected.requestFingerprint)) throw new Error("invalid_risk_binding");
  const payload = JSON.stringify(value);
  if (!payload || Buffer.byteLength(payload) > 65536) throw new Error("risk_record_size_limit");
  const base = { version: 1 as const, purpose: "risk-v1" as const, keyId: keys.keyId, ...expected, payloadHash: hash(payload) };
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keys.encryptionKey, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad(base)));
  const encrypted = { ...base, nonce: nonce.toString("base64"), ciphertext: Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64") };
  return { ...encrypted, mac: createHmac("sha256", keys.authenticationKey).update(bytes(encrypted)).digest("base64") };
}
export function decryptRiskRecord(envelope: RiskEnvelope, expected: Binding, keys: TransactionProtectionKeys): RiskRecord {
  try {
    new TransactionKeyRing(keys.keyId, [keys]);
    if (!envelope || envelope.version !== 1 || envelope.purpose !== "risk-v1" || envelope.keyId !== keys.keyId ||
        envelope.txId !== expected.txId || envelope.requestFingerprint !== expected.requestFingerprint ||
        !/^[a-f0-9]{64}$/.test(envelope.payloadHash) || !/^[a-f0-9]{64}$/.test(expected.requestFingerprint)) throw new Error();
    const mac = decode(envelope.mac, 32), expectedMac = createHmac("sha256", keys.authenticationKey).update(bytes(envelope)).digest();
    if (!timingSafeEqual(mac, expectedMac)) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", keys.encryptionKey, decode(envelope.nonce, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad(envelope))); decipher.setAuthTag(decode(envelope.tag, 16));
    const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]).toString("utf8");
    if (Buffer.byteLength(plaintext) > 65536 || hash(plaintext) !== envelope.payloadHash) throw new Error();
    const value = JSON.parse(plaintext);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error("protected_risk_verification_failed"); }
}
export class RiskProtectionStore {
  constructor(private readonly ring: TransactionKeyRing) {}
  async persist(client: PoolClient, binding: Binding, record: RiskRecord): Promise<void> {
    const key = this.ring.get(this.ring.activeKeyId), fingerprint = createHash("sha256").update(key.encryptionKey).digest("hex");
    const quota = await client.query(`INSERT INTO rail_risk_key_usage(key_fingerprint, record_count) VALUES ($1,1)
      ON CONFLICT (key_fingerprint) DO UPDATE SET record_count = rail_risk_key_usage.record_count + 1
      WHERE rail_risk_key_usage.record_count < $2 RETURNING record_count`, [fingerprint, this.ring.maxRecordsPerKey]);
    if (quota.rowCount !== 1) throw new Error("risk_key_rotation_required");
    const envelope = protectRiskRecord(record, binding, key);
    decryptRiskRecord(envelope, binding, key);
    await client.query(`INSERT INTO rail_protected_risk(tx_id, request_fingerprint, key_fingerprint, nonce, envelope, commitment)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [binding.txId, binding.requestFingerprint, fingerprint, envelope.nonce,
      JSON.stringify(envelope), hash(JSON.stringify(["rail:risk-commitment:v1", bytes(envelope), envelope.mac]))]);
  }
  verify(row: ProtectedRiskSummary, binding: Binding): void {
    const envelope = row.envelope as RiskEnvelope;
    const record = decryptRiskRecord(envelope, binding, this.ring.get(envelope.keyId));
    if (hash(JSON.stringify(["rail:risk-commitment:v1", bytes(envelope), envelope.mac])) !== row.commitment ||
        record.observedAt !== new Date(row.observed_at).toISOString() || !isDeepStrictEqual(record.assessment, row.assessment) ||
        record.modelStatus !== row.model_status || record.modelVersion !== row.model_version || record.synthetic !== row.synthetic ||
        !isDeepStrictEqual(record.anomaly?.summary ?? { status: "not_configured" }, row.anomaly_summary ?? { status: "not_configured" })) {
      throw new Error("protected_risk_summary_mismatch");
    }
  }
}
