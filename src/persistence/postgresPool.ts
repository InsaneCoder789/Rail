import { Pool } from "pg";

export function createPool(connectionString: string, max = 20): Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error("[DB POOL ERROR]", err);
  });
  pool.on("connect", () => {
    console.log("[DB] New client connected");
  });

  return pool;
}
