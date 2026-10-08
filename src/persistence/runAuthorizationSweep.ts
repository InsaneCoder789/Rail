import dotenv from "dotenv";
import { createPool } from "./postgresPool.js";
import { releaseExpiredAuthorizations } from "../stages/authorizationStage.js";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const pool = createPool(databaseUrl, 1);
try {
  const released = await releaseExpiredAuthorizations(pool, 1000);
  console.log(JSON.stringify({ released, batchLimit: 1000 }));
} finally {
  await pool.end();
}
