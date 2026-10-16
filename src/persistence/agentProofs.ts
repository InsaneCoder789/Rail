import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { agentKeyThumbprint, agentProofNonce, verifyAgentProof, type AgentProofRequest } from "../crypto/agentProof.js";
import { RequestError } from "../server/http.js";

function denied(): never { throw new RequestError(401, "invalid_agent_proof", "invalid agent proof"); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface AgentAdmission { readonly credentialId: string; readonly agentId: string; readonly scope: string; readonly keyThumbprint: string; readonly proofId: string }
const admissions = new WeakMap<object, { nonceHash: string; method: string; path: string; body: string }>();

export async function dispatchAgentAdmission(client: PoolClient, admission: AgentAdmission | undefined,
  expected: { credentialId: string; keyThumbprint: string; method: string; path: string; value?: unknown }, claim = true): Promise<void> {
  const saved = admission && admissions.get(admission);
  if (!admission || !saved || admission.credentialId !== expected.credentialId || admission.keyThumbprint !== expected.keyThumbprint ||
      saved.method !== expected.method || saved.path !== expected.path) denied();
  if (expected.method === "POST") {
    let value: unknown;
    try { value = JSON.parse(saved.body); } catch { denied(); }
    if (JSON.stringify(value) !== JSON.stringify(expected.value)) denied();
  }
  const query = claim ? `UPDATE rail_agent_proof_nonces SET dispatched_at=clock_timestamp()
    WHERE nonce_hash=$1 AND credential_id=$2 AND key_thumbprint=$3 AND proof_id=$4 AND consumed_at IS NOT NULL
      AND dispatched_at IS NULL AND expires_at>clock_timestamp() AND proof_expires_at>clock_timestamp() RETURNING nonce_hash`
    : `SELECT nonce_hash FROM rail_agent_proof_nonces WHERE nonce_hash=$1 AND credential_id=$2 AND key_thumbprint=$3
      AND proof_id=$4 AND dispatched_at IS NOT NULL AND expires_at>clock_timestamp() AND proof_expires_at>clock_timestamp()`;
  if ((await client.query(query, [saved.nonceHash, admission.credentialId, admission.keyThumbprint, admission.proofId])).rowCount !== 1) denied();
}

/** Durable admission is separate from financial idempotency; each retry needs a fresh proof. */
export class AgentProofStore {
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
      if ((error as { code?: string }).code === "23505") denied();
      throw error;
    } finally {
      client.release(discard);
      client.removeListener("error", onError);
    }
  }

  private async credential(client: PoolClient, token: unknown) {
    if (typeof token !== "string" || !/^rail_agent_[A-Za-z0-9_-]{43}$/.test(token)) denied();
    const lookup = await client.query(`SELECT agent.agent_id,agent.owner_wallet_id FROM rail_agent_credentials credential
      JOIN rail_agents agent ON agent.agent_id=credential.agent_id WHERE credential.token_hash=$1`, [hash(token)]);
    if (!lookup.rowCount) denied();
    const agent = lookup.rows[0];
    // Same owner -> agent -> credential order as authority withdrawal and money dispatch.
    const owner = await client.query("SELECT owner_recovery_pending FROM users WHERE wallet_id=$1 FOR SHARE", [agent.owner_wallet_id]);
    if (owner.rowCount !== 1 || owner.rows[0].owner_recovery_pending) denied();
    const identity = await client.query("SELECT status FROM rail_agents WHERE agent_id=$1 FOR SHARE", [agent.agent_id]);
    if (identity.rows[0]?.status !== "active") denied();
    const result = await client.query(`SELECT credential_id,agent_id,scope,proof_public_key,proof_key_thumbprint
      FROM rail_agent_credentials WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [hash(token)]);
    const row = result.rows[0];
    if (!row?.proof_public_key || !row.proof_key_thumbprint || agentKeyThumbprint(row.proof_public_key) !== row.proof_key_thumbprint) denied();
    return { row, token };
  }

  async issueNonce(token: unknown) {
    return this.transaction(async client => {
      const { row } = await this.credential(client, token);
      await client.query("DELETE FROM rail_agent_proof_nonces WHERE credential_id=$1 AND expires_at<=clock_timestamp()", [row.credential_id]);
      const capacity = await client.query(`SELECT count(*) AS retained,count(*) FILTER(WHERE consumed_at IS NULL) AS active
        FROM rail_agent_proof_nonces WHERE credential_id=$1`, [row.credential_id]);
      if (Number(capacity.rows[0].active) >= 5 || Number(capacity.rows[0].retained) >= 200)
        throw new RequestError(429, "agent_proof_capacity", "agent proof capacity reached");
      const nonce = randomBytes(32).toString("base64url");
      const result = await client.query(`WITH timestamp AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_agent_proof_nonces(nonce_hash,credential_id,key_thumbprint,created_at,expires_at)
        SELECT $1,$2,$3,now,now+interval '60 seconds' FROM timestamp RETURNING expires_at`, [hash(nonce), row.credential_id, row.proof_key_thumbprint]);
      return { nonce, agentId: String(row.agent_id), expiresAt: new Date(result.rows[0].expires_at).toISOString() };
    });
  }

  async authenticate(token: unknown, proof: unknown, request: Pick<AgentProofRequest, "method" | "url" | "body">) {
    const nonce = agentProofNonce(proof);
    // Snapshot exact bytes before any asynchronous database work.
    if (!(request.body instanceof Uint8Array)) denied();
    const body = Buffer.from(request.body), method = request.method, url = request.url;
    return this.transaction(async client => {
      const { row, token: accessToken } = await this.credential(client, token);
      const result = await client.query(`SELECT *,floor(extract(epoch FROM clock_timestamp()))::bigint AS now_seconds
        FROM rail_agent_proof_nonces WHERE nonce_hash=$1 AND credential_id=$2 AND key_thumbprint=$3
          AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [hash(nonce), row.credential_id, row.proof_key_thumbprint]);
      if (!result.rowCount) denied();
      const verified = verifyAgentProof(proof, { method, url, body, accessToken, nonce,
        keyThumbprint: row.proof_key_thumbprint, nowSeconds: Number(result.rows[0].now_seconds) });
      const consumed = await client.query(`UPDATE rail_agent_proof_nonces SET consumed_at=clock_timestamp(),proof_id=$2,proof_expires_at=to_timestamp($3)
        WHERE nonce_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING nonce_hash`, [hash(nonce), verified.proofId, verified.validUntil]);
      if (consumed.rowCount !== 1) denied();
      const admission = Object.freeze({ credentialId: String(row.credential_id), agentId: String(row.agent_id), scope: String(row.scope),
        keyThumbprint: row.proof_key_thumbprint as string, proofId: verified.proofId });
      admissions.set(admission, { nonceHash: hash(nonce), method, path: new URL(url).pathname, body: new TextDecoder("utf-8", { fatal: true }).decode(body) });
      return admission;
    });
  }
}
