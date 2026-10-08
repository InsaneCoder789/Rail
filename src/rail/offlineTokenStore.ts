import { randomBytes } from "node:crypto";
import type { PaymentTransaction } from "../domain/types.js";
import { AsyncMutex } from "./mutex.js";
import type { PoolClient } from "pg";
import { canonicalTransactionPayload } from "../crypto/transactionSigning.js";

export function validateTokenIssue(input: IssueOfflineTokenInput): void {
  if (!Number.isSafeInteger(input.amountCapMinor) || input.amountCapMinor <= 0 || input.amountCapMinor > 1e12) throw new Error("invalid_amount_cap");
  const ttl = input.ttlSeconds ?? 345600;
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 2592000) throw new Error("invalid_token_ttl");
  if (!/^[A-Z]{3}$/.test(input.currency ?? "INR")) throw new Error("invalid_currency");
  for (const id of [input.walletId, input.deviceId]) {
    if (typeof id !== "string" || id.length < 3 || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) throw new Error("invalid_token_binding");
  }
}

export function validSpendAmount(txn: PaymentTransaction): boolean {
  return Number.isSafeInteger(txn.amountMinor) && txn.amountMinor > 0 && txn.amountMinor <= 1e12;
}

export function validSpendIdentity(txn: PaymentTransaction): boolean {
  return [txn.txId, txn.idempotencyKey].every(id => typeof id === "string" && id.length >= 8 && id.length <= 128 && !/[\x00-\x1f\x7f]/.test(id));
}

type SpendRecord = { fingerprint: string; status: "reserved" | "finalized" | "rolled_back"; amount: number };

export interface IssuedOfflineToken {
  readonly tokenId: string;
  readonly walletId: string;
  readonly deviceId: string;
  readonly amountCapMinor: number;
  /** Remaining spend capacity in minor units. */
  remainingMinor: number;
  readonly currency: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface IssueOfflineTokenInput {
  readonly walletId: string;
  readonly deviceId: string;
  readonly amountCapMinor: number;
  readonly currency?: string;
  /** Default 4 days (tune per product / NPCI program). */
  readonly ttlSeconds?: number;
}

/** Common contract for in-memory and PostgreSQL offline token backends. */
export interface IOfflineTokenStore {
  readonly supportsTransactions: boolean;
  issue(input: IssueOfflineTokenInput): Promise<IssuedOfflineToken>;
  beginOfflineSpend(txn: PaymentTransaction, client?: PoolClient): Promise<{ ok: true } | { ok: false; reason: string }>;
  finalizeOfflineSpend(txn: PaymentTransaction, client?: PoolClient): Promise<void>;
  rollbackOfflineSpend(txn: PaymentTransaction, client?: PoolClient): Promise<void>;
  getToken(tokenId: string): Promise<IssuedOfflineToken | undefined>;
}

/**
 * Server-side offline spend envelope: time-bound, capped, device-bound tokens.
 * beginOfflineSpend reserves headroom; finalizeOfflineSpend or rollbackOfflineSpend completes the cycle.
 */
export class OfflineTokenStore implements IOfflineTokenStore {
  readonly supportsTransactions = false;
  private readonly tokens = new Map<string, IssuedOfflineToken>();
  private readonly spends = new Map<string, SpendRecord>();
  private readonly mutex = new AsyncMutex();

  private cloneToken(token: IssuedOfflineToken): IssuedOfflineToken {
    return { ...token };
  }

  async issue(input: IssueOfflineTokenInput): Promise<IssuedOfflineToken> {
    validateTokenIssue(input);
    return this.mutex.runExclusive(async () => {
      const tokenId = `otk_${randomBytes(12).toString("hex")}`;
      const issuedAtMs = Date.now();
      const ttlMs = (input.ttlSeconds ?? 4 * 24 * 60 * 60) * 1000;
      const row: IssuedOfflineToken = {
        tokenId,
        walletId: input.walletId,
        deviceId: input.deviceId,
        amountCapMinor: input.amountCapMinor,
        remainingMinor: input.amountCapMinor,
        currency: input.currency ?? "INR",
        issuedAtMs,
        expiresAtMs: issuedAtMs + ttlMs,
      };
      this.tokens.set(tokenId, row);
      return this.cloneToken(row);
    });
  }

  /**
   * Validates and reserves headroom for an offline transaction (call before pipeline).
   */
  async beginOfflineSpend(txn: PaymentTransaction, _client?: PoolClient): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!validSpendAmount(txn)) return { ok: false, reason: "invalid_amount" };
    if (!validSpendIdentity(txn)) return { ok: false, reason: "invalid_transaction" };
    if (txn.channel === "online") {
      return { ok: true };
    }
    if (!txn.offlineTokenId) {
      return { ok: false, reason: "offline_token_required" };
    }
    if (!txn.deviceId) {
      return { ok: false, reason: "offline_device_required" };
    }
    const tid = txn.offlineTokenId;

    return this.mutex.runExclusive(async () => {
      const row = this.tokens.get(tid);
      if (!row) {
        return { ok: false, reason: "unknown_or_expired_token" };
      }
      if (row.walletId !== txn.senderWalletId) {
        return { ok: false, reason: "wallet_mismatch" };
      }
      if (txn.deviceId !== row.deviceId) {
        return { ok: false, reason: "device_mismatch" };
      }
      if (txn.currency !== row.currency) {
        return { ok: false, reason: "currency_mismatch" };
      }
      const fingerprint = canonicalTransactionPayload(txn);
      const spend = this.spends.get(txn.txId);
      if (spend && spend.fingerprint !== fingerprint) return { ok: false, reason: "offline_spend_mismatch" };
      if (spend && spend.status !== "rolled_back") return { ok: true };
      if (Date.now() >= row.expiresAtMs) return { ok: false, reason: "token_expired" };
      if (txn.amountMinor > row.remainingMinor) {
        return { ok: false, reason: "insufficient_token_headroom" };
      }

      row.remainingMinor -= txn.amountMinor;
      this.spends.set(txn.txId, { fingerprint, status: "reserved", amount: txn.amountMinor });
      return { ok: true };
    });
  }

  /** Retain completed spend records so retries cannot consume capacity again. */
  async finalizeOfflineSpend(txn: PaymentTransaction, _client?: PoolClient): Promise<void> {
    if (txn.channel === "online" || !txn.offlineTokenId) return;
    await this.mutex.runExclusive(async () => {
      const spend = this.spends.get(txn.txId);
      if (!spend || spend.fingerprint !== canonicalTransactionPayload(txn) || spend.status === "rolled_back") throw new Error("offline_spend_not_reserved");
      spend.status = "finalized";
    });
  }

  /** Restores reserved headroom if pipeline rejects or errors after beginOfflineSpend. */
  async rollbackOfflineSpend(txn: PaymentTransaction, _client?: PoolClient): Promise<void> {
    if (txn.channel === "online" || !txn.offlineTokenId) return;
    const tid = txn.offlineTokenId;

    await this.mutex.runExclusive(async () => {
      const row = this.tokens.get(tid);
      const spend = this.spends.get(txn.txId);
      if (!spend) return;
      if (spend.fingerprint !== canonicalTransactionPayload(txn)) throw new Error("offline_spend_mismatch");
      if (!row || spend.status !== "reserved") return;
      row.remainingMinor += spend.amount;
      spend.status = "rolled_back";
    });
  }

  async getToken(tokenId: string): Promise<IssuedOfflineToken | undefined> {
    const token = this.tokens.get(tokenId);
    return token ? this.cloneToken(token) : undefined;
  }
}
