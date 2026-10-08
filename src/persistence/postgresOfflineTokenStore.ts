import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PaymentTransaction } from "../domain/types.js";
import { canonicalTransactionPayload } from "../crypto/transactionSigning.js";
import { validateTokenIssue, validSpendAmount, validSpendIdentity, type IssuedOfflineToken, type IssueOfflineTokenInput, type IOfflineTokenStore } from "../rail/offlineTokenStore.js";

function mapRow(row: Record<string, unknown>): IssuedOfflineToken {
  return {
    tokenId: String(row.token_id), walletId: String(row.wallet_id), deviceId: String(row.device_id),
    amountCapMinor: Number(row.amount_cap_minor), remainingMinor: Number(row.remaining_minor),
    currency: String(row.currency), issuedAtMs: Number(row.issued_at_ms), expiresAtMs: Number(row.expires_at_ms),
  };
}

function fingerprint(txn: PaymentTransaction): string {
  return createHash("sha256").update(canonicalTransactionPayload(txn)).digest("hex");
}

export class PostgresOfflineTokenStore implements IOfflineTokenStore {
  readonly supportsTransactions = true;
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(provided: PoolClient | undefined, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (provided) return work(provided);
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
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

  async issue(input: IssueOfflineTokenInput): Promise<IssuedOfflineToken> {
    validateTokenIssue(input);
    const tokenId = `otk_${randomBytes(12).toString("hex")}`;
    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + (input.ttlSeconds ?? 345600) * 1000;
    const currency = input.currency ?? "INR";
    await this.pool.query(`INSERT INTO rail_offline_tokens
      (token_id, wallet_id, device_id, amount_cap_minor, remaining_minor, currency, issued_at_ms, expires_at_ms)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`, [tokenId, input.walletId, input.deviceId, input.amountCapMinor, currency, issuedAtMs, expiresAtMs]);
    return { tokenId, walletId: input.walletId, deviceId: input.deviceId, amountCapMinor: input.amountCapMinor,
      remainingMinor: input.amountCapMinor, currency, issuedAtMs, expiresAtMs };
  }

  async beginOfflineSpend(txn: PaymentTransaction, provided?: PoolClient): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!validSpendAmount(txn)) return { ok: false, reason: "invalid_amount" };
    if (!validSpendIdentity(txn)) return { ok: false, reason: "invalid_transaction" };
    if (txn.channel === "online") return { ok: true };
    if (!txn.offlineTokenId) return { ok: false, reason: "offline_token_required" };
    if (!txn.deviceId) return { ok: false, reason: "offline_device_required" };
    return this.transaction(provided, async client => {
      // Serialize the spend identity as well as the token: one transaction cannot reserve two tokens.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`offline_spend:${txn.txId}`]);
      const tokenResult = await client.query("SELECT * FROM rail_offline_tokens WHERE token_id = $1 FOR UPDATE", [txn.offlineTokenId]);
      if (!tokenResult.rows.length) return { ok: false, reason: "unknown_or_expired_token" };
      const token = mapRow(tokenResult.rows[0]);
      if (token.walletId !== txn.senderWalletId) return { ok: false, reason: "wallet_mismatch" };
      if (token.deviceId !== txn.deviceId) return { ok: false, reason: "device_mismatch" };
      if (token.currency !== txn.currency) return { ok: false, reason: "currency_mismatch" };
      const existing = await client.query("SELECT * FROM rail_offline_spends WHERE tx_id = $1", [txn.txId]);
      const spend = existing.rows[0];
      const hash = fingerprint(txn);
      if (spend && spend.request_fingerprint !== hash) return { ok: false, reason: "offline_spend_mismatch" };
      if (spend && spend.status !== "rolled_back") return { ok: true };
      if (Date.now() >= token.expiresAtMs) return { ok: false, reason: "token_expired" };
      if (txn.amountMinor > token.remainingMinor) return { ok: false, reason: "insufficient_token_headroom" };
      await client.query("UPDATE rail_offline_tokens SET remaining_minor = remaining_minor - $2 WHERE token_id = $1", [token.tokenId, txn.amountMinor]);
      await client.query(`INSERT INTO rail_offline_spends (tx_id, token_id, request_fingerprint, amount_minor, status)
        VALUES ($1,$2,$3,$4,'reserved') ON CONFLICT (tx_id) DO UPDATE SET status = 'reserved'`,
      [txn.txId, token.tokenId, hash, txn.amountMinor]);
      return { ok: true };
    });
  }

  private async finish(txn: PaymentTransaction, rollback: boolean, provided?: PoolClient): Promise<void> {
    if (txn.channel === "online") return;
    await this.transaction(provided, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`offline_spend:${txn.txId}`]);
      const result = await client.query("SELECT * FROM rail_offline_spends WHERE tx_id = $1 FOR UPDATE", [txn.txId]);
      const spend = result.rows[0];
      if (!spend) {
        if (rollback) return;
        throw new Error("offline_spend_not_reserved");
      }
      if (spend.request_fingerprint !== fingerprint(txn)) throw new Error("offline_spend_mismatch");
      if (spend.status === "finalized") return;
      if (spend.status === "rolled_back") {
        if (rollback) return;
        throw new Error("offline_spend_not_reserved");
      }
      if (rollback) await client.query("UPDATE rail_offline_tokens SET remaining_minor = remaining_minor + $2 WHERE token_id = $1", [spend.token_id, spend.amount_minor]);
      await client.query("UPDATE rail_offline_spends SET status = $2 WHERE tx_id = $1", [txn.txId, rollback ? "rolled_back" : "finalized"]);
    });
  }

  async finalizeOfflineSpend(txn: PaymentTransaction, client?: PoolClient): Promise<void> { await this.finish(txn, false, client); }
  async rollbackOfflineSpend(txn: PaymentTransaction, client?: PoolClient): Promise<void> { await this.finish(txn, true, client); }

  async getToken(tokenId: string): Promise<IssuedOfflineToken | undefined> {
    const result = await this.pool.query("SELECT * FROM rail_offline_tokens WHERE token_id = $1", [tokenId]);
    return result.rows.length ? mapRow(result.rows[0]) : undefined;
  }
}
