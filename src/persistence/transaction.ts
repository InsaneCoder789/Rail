import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/** Bounded transaction ownership shared by provider workers; no network I/O in work. */
export async function withPoolTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  const onError = () => { discard = true; };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
    const result = await work(client); await client.query("COMMIT"); return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); client.removeListener("error", onError); }
}

/** Requires an existing transaction; the caller owns deadlines, final commit and client disposal. */
export async function withTransactionSavepoint<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  const name = `rail_scope_${randomUUID().replaceAll("-", "")}`;
  // SAVEPOINT fails before work starts if this client is in autocommit mode.
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await work();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    } catch {
      // An unusable connection must be rolled back/discarded by its transaction owner.
    }
    throw error;
  }
}
