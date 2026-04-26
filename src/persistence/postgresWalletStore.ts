

import type { Pool } from "pg";

export class PostgresWalletStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getBalance(walletId: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT balance_minor FROM wallets WHERE wallet_id = $1`,
      [walletId]
    );

    if (res.rows.length === 0) {
      throw new Error("wallet_not_found");
    }

    return Number(res.rows[0].balance_minor);
  }

  async reserve(walletId: string, amount: number): Promise<void> {
    const res = await this.pool.query(
      `UPDATE wallets
       SET reserved_minor = reserved_minor + $2
       WHERE wallet_id = $1
       AND (balance_minor - reserved_minor) >= $2`,
      [walletId, amount]
    );

    if (res.rowCount === 0) {
      throw new Error("insufficient_balance");
    }
  }

  async release(walletId: string, amount: number): Promise<void> {
    await this.pool.query(
      `UPDATE wallets
       SET reserved_minor = GREATEST(reserved_minor - $2, 0)
       WHERE wallet_id = $1`,
      [walletId, amount]
    );
  }

  async consume(walletId: string, amount: number): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const res = await client.query(
        `SELECT reserved_minor FROM wallets WHERE wallet_id = $1 FOR UPDATE`,
        [walletId]
      );

      if (res.rows.length === 0) {
        throw new Error("wallet_not_found");
      }

      const reserved = Number(res.rows[0].reserved_minor);

      if (reserved < amount) {
        throw new Error("reservation_mismatch");
      }

      await client.query(
        `UPDATE wallets
         SET
           reserved_minor = reserved_minor - $2,
           balance_minor = balance_minor - $2
         WHERE wallet_id = $1`,
        [walletId, amount]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async credit(walletId: string, amount: number): Promise<void> {
    await this.pool.query(
      `UPDATE wallets
       SET balance_minor = balance_minor + $2
       WHERE wallet_id = $1`,
      [walletId, amount]
    );
  }
}