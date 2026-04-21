import { randomBytes } from "node:crypto";
import type { PaymentTransaction } from "../domain/types.js";
import type {
  IssuedOfflineToken,
  IssueOfflineTokenInput,
  IOfflineTokenStore,
} from "../rail/offlineTokenStore.js";
import type { Pool } from "pg";

function mapRow(row: Record<string, unknown>): IssuedOfflineToken {
  return {
    tokenId: String(row.token_id),
    walletId: String(row.wallet_id),
    deviceId: String(row.device_id),
    amountCapMinor: Number(row.amount_cap_minor),
    remainingMinor: Number(row.remaining_minor),
    currency: String(row.currency),
    issuedAtMs: Number(row.issued_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

export class PostgresOfflineTokenStore implements IOfflineTokenStore {
  constructor(private readonly pool: Pool) {}

  async issue(input: IssueOfflineTokenInput): Promise<IssuedOfflineToken> {
    if (input.amountCapMinor <= 0) {
      throw new Error("invalid_amount_cap");
    }
    const tokenId = `otk_${randomBytes(12).toString("hex")}`;
    const issuedAtMs = Date.now();
    const ttlMs = (input.ttlSeconds ?? 4 * 24 * 60 * 60) * 1000;
    const expiresAtMs = issuedAtMs + ttlMs;
    const currency = input.currency ?? "INR";

    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO rail_offline_tokens (
          token_id, wallet_id, device_id, amount_cap_minor, remaining_minor, currency, issued_at_ms, expires_at_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tokenId,
          input.walletId,
          input.deviceId,
          input.amountCapMinor,
          input.amountCapMinor,
          currency,
          issuedAtMs,
          expiresAtMs,
        ],
      );
    } finally {
      client.release();
    }

    return {
      tokenId,
      walletId: input.walletId,
      deviceId: input.deviceId,
      amountCapMinor: input.amountCapMinor,
      remainingMinor: input.amountCapMinor,
      currency,
      issuedAtMs,
      expiresAtMs,
    };
  }

  async beginOfflineSpend(txn: PaymentTransaction): Promise<{ ok: true } | { ok: false; reason: string }> {
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

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sel = await client.query(
        `SELECT * FROM rail_offline_tokens WHERE token_id = $1 FOR UPDATE`,
        [tid],
      );
      if (sel.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "unknown_or_expired_token" };
      }
      const row = sel.rows[0] as Record<string, unknown>;

      if (Date.now() > Number(row.expires_at_ms)) {
        await client.query(`DELETE FROM rail_offline_tokens WHERE token_id = $1`, [tid]);
        await client.query("COMMIT");
        return { ok: false, reason: "token_expired" };
      }
      if (String(row.wallet_id) !== txn.senderWalletId) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "wallet_mismatch" };
      }
      if (txn.deviceId !== String(row.device_id)) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "device_mismatch" };
      }
      if (txn.currency !== String(row.currency)) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "currency_mismatch" };
      }
      const remaining = Number(row.remaining_minor);
      if (txn.amountMinor > remaining) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "insufficient_token_headroom" };
      }

      await client.query(
        `UPDATE rail_offline_tokens SET remaining_minor = remaining_minor - $2 WHERE token_id = $1`,
        [tid, txn.amountMinor],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async finalizeOfflineSpend(txn: PaymentTransaction): Promise<void> {
    if (txn.channel === "online" || !txn.offlineTokenId) return;
    await this.pool.query(
      `DELETE FROM rail_offline_tokens WHERE token_id = $1 AND remaining_minor <= 0`,
      [txn.offlineTokenId],
    );
  }

  async rollbackOfflineSpend(txn: PaymentTransaction): Promise<void> {
    if (txn.channel === "online" || !txn.offlineTokenId) return;
    await this.pool.query(
      `UPDATE rail_offline_tokens SET remaining_minor = remaining_minor + $2 WHERE token_id = $1`,
      [txn.offlineTokenId, txn.amountMinor],
    );
  }

  async getToken(tokenId: string): Promise<IssuedOfflineToken | undefined> {
    const r = await this.pool.query(`SELECT * FROM rail_offline_tokens WHERE token_id = $1`, [tokenId]);
    if (r.rows.length === 0) return undefined;
    return mapRow(r.rows[0] as Record<string, unknown>);
  }
}
