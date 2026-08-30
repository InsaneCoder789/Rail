import { randomBytes } from "node:crypto";
import type { PaymentTransaction } from "../domain/types.js";
import { AsyncMutex } from "./mutex.js";
import type { PoolClient } from "pg";

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
  private readonly tokens = new Map<string, IssuedOfflineToken>();
  private readonly mutex = new AsyncMutex();

  private cloneToken(token: IssuedOfflineToken): IssuedOfflineToken {
    return { ...token };
  }

  async issue(input: IssueOfflineTokenInput): Promise<IssuedOfflineToken> {
    return this.mutex.runExclusive(async () => {
      if (input.amountCapMinor <= 0) {
        throw new Error("invalid_amount_cap");
      }
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
      if (Date.now() > row.expiresAtMs) {
        this.tokens.delete(tid);
        return { ok: false, reason: "token_expired" };
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
      if (txn.amountMinor > row.remainingMinor) {
        return { ok: false, reason: "insufficient_token_headroom" };
      }

      row.remainingMinor -= txn.amountMinor;
      return { ok: true };
    });
  }

  /** Call after pipeline accepts the transaction. Removes token when fully spent. */
  async finalizeOfflineSpend(txn: PaymentTransaction, _client?: PoolClient): Promise<void> {
    if (txn.channel === "online" || !txn.offlineTokenId) return;
    const tid = txn.offlineTokenId;

    await this.mutex.runExclusive(async () => {
      const row = this.tokens.get(tid);
      if (!row) return;
      if (row.remainingMinor <= 0) {
        this.tokens.delete(tid);
      }
    });
  }

  /** Restores reserved headroom if pipeline rejects or errors after beginOfflineSpend. */
  async rollbackOfflineSpend(txn: PaymentTransaction, _client?: PoolClient): Promise<void> {
    if (txn.channel === "online" || !txn.offlineTokenId) return;
    const tid = txn.offlineTokenId;

    await this.mutex.runExclusive(async () => {
      const row = this.tokens.get(tid);
      if (!row) return;
      row.remainingMinor += txn.amountMinor;
    });
  }

  async getToken(tokenId: string): Promise<IssuedOfflineToken | undefined> {
    const token = this.tokens.get(tokenId);
    return token ? this.cloneToken(token) : undefined;
  }
}
