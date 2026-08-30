import dotenv from "dotenv";
import { Pool } from "pg";
import { ensureOutboxSchema, runMigrations } from "./migrate.js";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_REQUIRED");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  await runMigrations(pool);
  await ensureOutboxSchema(pool);
  console.log("Rail: database migrations completed");
} finally {
  await pool.end();
}
