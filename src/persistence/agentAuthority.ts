import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isCurrency, isRecord, isSafeText, isValidAmountMinor } from "../server/validation.js";
import { RequestError } from "../server/http.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

function invalid(): never { throw new RequestError(422, "invalid_agent_request", "invalid agent request"); }
export function isAgentId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function ttl(value: unknown): number {
  const seconds = value === undefined ? 86400 : value;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > MAX_TTL_SECONDS) invalid();
  return seconds;
}

export interface MandateInput {
  readonly mode: "approval_required" | "budgeted";
  readonly currency: string;
  readonly perPaymentLimitMinor: number;
  readonly totalBudgetMinor: number;
  readonly allowedReceiverWalletIds: readonly string[];
  readonly ttlSeconds: number;
}

export function parseMandateInput(value: unknown): MandateInput {
  if (!isRecord(value) || (value.mode !== "approval_required" && value.mode !== "budgeted") || !isCurrency(value.currency) ||
      !isValidAmountMinor(value.perPaymentLimitMinor) || !isValidAmountMinor(value.totalBudgetMinor) ||
      value.perPaymentLimitMinor > value.totalBudgetMinor || !Array.isArray(value.allowedReceiverWalletIds) ||
      value.allowedReceiverWalletIds.length < 1 || value.allowedReceiverWalletIds.length > 20 ||
      !value.allowedReceiverWalletIds.every(item => isSafeText(item, 3, 128)) ||
      new Set(value.allowedReceiverWalletIds).size !== value.allowedReceiverWalletIds.length) invalid();
  return { mode: value.mode as MandateInput["mode"], currency: value.currency,
    perPaymentLimitMinor: value.perPaymentLimitMinor, totalBudgetMinor: value.totalBudgetMinor,
    allowedReceiverWalletIds: [...value.allowedReceiverWalletIds], ttlSeconds: ttl(value.ttlSeconds) };
}

function date(value: unknown): string { return (value instanceof Date ? value : new Date(String(value))).toISOString(); }
function mapAgent(row: Record<string, unknown>) {
  return { agentId: String(row.agent_id), name: String(row.name), status: String(row.status),
    createdAt: date(row.created_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null, executionEnabled: false };
}
function mapMandate(row: Record<string, unknown>) {
  return { mandateId: String(row.mandate_id), agentId: String(row.agent_id), mode: String(row.mode), currency: String(row.currency),
    status: row.revoked_at ? "revoked" : row.expired === true ? "expired" : "active",
    perPaymentLimitMinor: Number(row.per_payment_limit_minor), totalBudgetMinor: Number(row.total_budget_minor),
    allowedReceiverWalletIds: row.allowed_receiver_wallet_ids as string[], createdAt: date(row.created_at),
    expiresAt: date(row.expires_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null, executionEnabled: false };
}

/** Control-plane only: credentials never resolve to an owner JWT or wallet API key. */
export class AgentAuthorityStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
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

  private async audit(client: PoolClient, type: string, walletId: string, fields: Record<string, unknown>): Promise<void> {
    await client.query("INSERT INTO outbox(type, payload) VALUES ($1, $2::jsonb)", [type, JSON.stringify({ walletId, ...fields })]);
  }

  private async ownedAgent(client: PoolClient, owner: string, agentId: string, active = true) {
    if (!isAgentId(agentId)) invalid();
    const result = await client.query("SELECT * FROM rail_agents WHERE agent_id = $1 AND owner_wallet_id = $2 FOR UPDATE", [agentId, owner]);
    const row = result.rows[0];
    if (!row) throw new RequestError(404, "agent_not_found", "agent not found");
    if (active && row.status !== "active") throw new RequestError(409, "agent_revoked", "agent is revoked");
    return row;
  }

  async createAgent(owner: string, input: unknown) {
    if (!isRecord(input) || !isSafeText(input.name, 1, 80) || !input.name.trim()) invalid();
    const name = input.name.trim();
    return this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`agent-owner:${owner}`]);
      const count = await client.query("SELECT count(*) FROM rail_agents WHERE owner_wallet_id = $1", [owner]);
      if (Number(count.rows[0].count) >= 50) throw new RequestError(409, "agent_capacity", "owner agent capacity reached");
      const result = await client.query("INSERT INTO rail_agents(agent_id, owner_wallet_id, name) VALUES ($1, $2, $3) RETURNING *", [randomUUID(), owner, name]);
      const agent = mapAgent(result.rows[0]);
      await this.audit(client, "agent.created", owner, { agentId: agent.agentId });
      return agent;
    });
  }

  async listAgents(owner: string) {
    const result = await this.pool.query("SELECT * FROM rail_agents WHERE owner_wallet_id = $1 ORDER BY created_at, agent_id LIMIT 50", [owner]);
    return result.rows.map(mapAgent);
  }

  async issueCredential(owner: string, agentId: string, input: unknown) {
    if (!isRecord(input)) invalid();
    const seconds = ttl(input.ttlSeconds);
    if (input.scope !== undefined && input.scope !== "payments:propose") invalid();
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId);
      const count = await client.query("SELECT count(*) FROM rail_agent_credentials WHERE agent_id = $1", [agentId]);
      if (Number(count.rows[0].count) >= 100) throw new RequestError(409, "credential_capacity", "agent credential capacity reached");
      const token = `rail_agent_${randomBytes(32).toString("base64url")}`;
      const credentialId = randomUUID();
      const result = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_agent_credentials(credential_id, agent_id, token_hash, scope, created_at, expires_at)
        SELECT $1, $2, $3, 'payments:propose', now, now + $4 * interval '1 second' FROM timestamp RETURNING expires_at`,
        [credentialId, agentId, createHash("sha256").update(token).digest("hex"), seconds]);
      await this.audit(client, "agent.credential_issued", owner, { agentId, credentialId });
      return { credentialId, agentId, scope: "payments:propose", expiresAt: date(result.rows[0].expires_at), token, executionEnabled: false };
    });
  }

  async resolveCredential(token: unknown) {
    if (typeof token !== "string" || !/^rail_agent_[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const result = await this.pool.query(`SELECT credential.credential_id, credential.agent_id, credential.scope, credential.expires_at
      FROM rail_agent_credentials credential JOIN rail_agents agent ON agent.agent_id = credential.agent_id
      WHERE credential.token_hash = $1 AND credential.revoked_at IS NULL AND credential.expires_at > clock_timestamp()
        AND agent.status = 'active'`, [createHash("sha256").update(token).digest("hex")]);
    if (!result.rows[0]) throw new RequestError(401, "invalid_agent_credentials", "invalid agent credentials");
    const row = result.rows[0];
    return { credentialId: String(row.credential_id), agentId: String(row.agent_id), scope: String(row.scope),
      expiresAt: date(row.expires_at), executionEnabled: false };
  }

  async listCredentials(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query("SELECT credential_id, scope, created_at, expires_at, revoked_at FROM rail_agent_credentials WHERE agent_id = $1 ORDER BY created_at, credential_id LIMIT 100", [agentId]);
      return result.rows.map(row => ({ credentialId: String(row.credential_id), scope: String(row.scope), createdAt: date(row.created_at),
        expiresAt: date(row.expires_at), revokedAt: row.revoked_at ? date(row.revoked_at) : null }));
    });
  }

  async revokeCredential(owner: string, agentId: string, credentialId: string) {
    if (!isAgentId(credentialId)) invalid();
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query("UPDATE rail_agent_credentials SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE credential_id = $1 AND agent_id = $2 RETURNING credential_id", [credentialId, agentId]);
      if (!result.rowCount) throw new RequestError(404, "credential_not_found", "credential not found");
      await this.audit(client, "agent.credential_revoked", owner, { agentId, credentialId });
      return { credentialId, revoked: true };
    });
  }

  async revokeAgent(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query("UPDATE rail_agents SET status = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE agent_id = $1 RETURNING *", [agentId]);
      await client.query("UPDATE rail_agent_credentials SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE agent_id = $1", [agentId]);
      await client.query("UPDATE rail_agent_mandates SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE agent_id = $1", [agentId]);
      await this.audit(client, "agent.revoked", owner, { agentId });
      return mapAgent(result.rows[0]);
    });
  }

  async createMandate(owner: string, agentId: string, value: unknown) {
    const input = parseMandateInput(value);
    if (input.allowedReceiverWalletIds.includes(owner)) invalid();
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId);
      const count = await client.query("SELECT count(*) FROM rail_agent_mandates WHERE agent_id = $1", [agentId]);
      if (Number(count.rows[0].count) >= 100) throw new RequestError(409, "mandate_capacity", "agent mandate capacity reached");
      const wallets = await client.query("SELECT wallet_id FROM wallets WHERE wallet_id = ANY($1::text[]) AND currency = $2", [[owner, ...input.allowedReceiverWalletIds], input.currency]);
      if (wallets.rowCount !== input.allowedReceiverWalletIds.length + 1) invalid();
      const result = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_agent_mandates(mandate_id, agent_id, owner_wallet_id, mode, currency, per_payment_limit_minor,
          total_budget_minor, allowed_receiver_wallet_ids, created_at, expires_at)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, now, now + $9 * interval '1 second' FROM timestamp RETURNING *`,
        [randomUUID(), agentId, owner, input.mode, input.currency, input.perPaymentLimitMinor, input.totalBudgetMinor, input.allowedReceiverWalletIds, input.ttlSeconds]);
      const mandate = mapMandate(result.rows[0]);
      await this.audit(client, "agent.mandate_created", owner, { agentId, mandateId: mandate.mandateId });
      return mandate;
    });
  }

  async listMandates(owner: string, agentId: string) {
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query("SELECT *, expires_at <= clock_timestamp() AS expired FROM rail_agent_mandates WHERE agent_id = $1 ORDER BY created_at, mandate_id LIMIT 100", [agentId]);
      return result.rows.map(mapMandate);
    });
  }

  async revokeMandate(owner: string, agentId: string, mandateId: string) {
    if (!isAgentId(mandateId)) invalid();
    return this.transaction(async client => {
      await this.ownedAgent(client, owner, agentId, false);
      const result = await client.query("UPDATE rail_agent_mandates SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE mandate_id = $1 AND agent_id = $2 RETURNING *", [mandateId, agentId]);
      if (!result.rowCount) throw new RequestError(404, "mandate_not_found", "mandate not found");
      await this.audit(client, "agent.mandate_revoked", owner, { agentId, mandateId });
      return mapMandate(result.rows[0]);
    });
  }
}
