import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

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
