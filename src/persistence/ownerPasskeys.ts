import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { compare, hash as hashPassword } from "bcryptjs";
import type { Pool, PoolClient } from "pg";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { assertEd25519PublicKey } from "../crypto/transactionSigning.js";
import type { OwnerPrincipal } from "../server/types.js";
import { RequestError } from "../server/http.js";
import { isRecord } from "../server/validation.js";
import { withTransactionSavepoint } from "./transaction.js";
import { generateToken } from "../auth/jwt.js";
import { withdrawOwnerAgentAuthority } from "./agentAuthority.js";
import { withdrawWalletSpendingAuthority } from "../stages/authorizationStage.js";

const OPERATIONS = ["agent_credential", "agent_mandate", "agent_approval", "passkey_enroll", "passkey_revoke", "recovery_codes", "shared_budget", "provider_payment"] as const;
function assertPasskeyPublicKey(bytes: Uint8Array): void {
  const decoded: unknown = decodeCredentialPublicKey(new Uint8Array(bytes));
  if (!(decoded instanceof Map)) throw new Error("invalid_passkey_public_key");
  const key: Map<number, unknown> = decoded, algorithm = key.get(3);
  const field = (name: -1 | -2 | -3) => {
    const value = key.get(name);
    if (!(value instanceof Uint8Array) || !value.length) throw new Error("invalid_passkey_public_key");
    return Buffer.from(value);
  };
  if (algorithm === -8 && key.get(1) === 1 && key.get(-1) === 6) assertEd25519PublicKey(field(-2));
  else if (algorithm === -7 && key.get(1) === 2 && key.get(-1) === 1) {
    const x = field(-2), y = field(-3);
    if (x.length !== 32 || y.length !== 32) throw new Error("invalid_passkey_public_key");
    createPublicKey({ key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
  } else if (algorithm === -257 && key.get(1) === 3) {
    const n = field(-1), e = field(-2);
    if (n.length < 256 || n.length > 512 || e.length > 4) throw new Error("invalid_passkey_public_key");
    const details = createPublicKey({ key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") }, format: "jwk" }).asymmetricKeyDetails;
    if (!details?.modulusLength || details.modulusLength < 2048 || !details.publicExponent || details.publicExponent < 65537n || details.publicExponent % 2n === 0n)
      throw new Error("invalid_passkey_public_key");
  } else throw new Error("invalid_passkey_public_key");
}
export type OwnerOperation = typeof OPERATIONS[number];
export interface OwnerPasskeyConfig { readonly rpId: string; readonly origin: string; }
export const ENROLLMENT_FINGERPRINT = createHash("sha256").update('["rail:owner-operation:v1","passkey_enroll"]').digest("hex");
export const RECOVERY_CODES_FINGERPRINT = createHash("sha256").update('["rail:owner-operation:v1","recovery_codes"]').digest("hex");
export function revokePasskeyFingerprint(credentialId: string): string {
  if (typeof credentialId !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(credentialId)) invalid();
  return hash(JSON.stringify(["rail:owner-operation:v1", "passkey_revoke", credentialId]));
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function invalid(): never { throw new RequestError(422, "invalid_passkey_request", "invalid passkey request"); }

export function loadOwnerPasskeyConfig(rpId?: string, origin?: string): OwnerPasskeyConfig | undefined {
  if (!rpId && !origin) return undefined;
  try {
    if (!rpId || !origin || rpId.length > 253 || origin.length > 2048) throw new Error();
    const url = new URL(origin);
    if (url.origin !== origin || url.hostname !== rpId || url.username || url.password ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && rpId === "localhost" && process.env.NODE_ENV !== "production"))) throw new Error();
    if ((rpId === "localhost" && process.env.NODE_ENV === "production") ||
        (rpId !== "localhost" && (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(rpId)))) throw new Error();
    return Object.freeze({ rpId, origin });
  } catch { throw new Error("INVALID_WEBAUTHN_CONFIGURATION"); }
}

/** Owns owner ceremonies/recovery, not financial approval policy. */
export class OwnerPasskeyStore {
  constructor(private readonly pool: Pool, private readonly config: OwnerPasskeyConfig) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='15s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { try { await client.query("ROLLBACK"); } catch { discard = true; } throw error; }
    finally { client.release(discard); client.removeListener("error", onError); }
  }

  private async owner(client: PoolClient, principal: OwnerPrincipal) {
    if (principal.method !== "owner_jwt" || typeof principal.userId !== "string" || !Number.isSafeInteger(principal.authVersion) ||
        typeof principal.sessionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(principal.sessionFingerprint))
      throw new RequestError(401, "owner_authentication_required", "current owner session required");
    // Serializes counter, enrollment and session changes for the same owner.
    const result = await client.query("SELECT * FROM users WHERE user_id=$1 AND wallet_id=$2 AND auth_version=$3 FOR UPDATE",
      [principal.userId, principal.walletId, principal.authVersion]);
    if (!result.rowCount) throw new RequestError(401, "invalid_credentials", "owner session is stale");
    return result.rows[0];
  }

  private async challenge(client: PoolClient, principal: OwnerPrincipal, kind: string, challenge: string,
    operation: OwnerOperation, fingerprint: string, bootstrap = false, authorizationChallengeId?: string, recoveryId?: string) {
    await client.query(`DELETE FROM rail_owner_challenges WHERE user_id=$1 AND expires_at<=clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM rail_owner_step_up_grants grant_record WHERE grant_record.challenge_id=rail_owner_challenges.challenge_id)
      AND NOT EXISTS (SELECT 1 FROM rail_owner_passkeys key WHERE key.enrollment_challenge_id=rail_owner_challenges.challenge_id)`, [principal.userId]);
    const count = await client.query("SELECT count(*) FROM rail_owner_challenges WHERE user_id=$1 AND used_at IS NULL AND expires_at>clock_timestamp()", [principal.userId]);
    if (Number(count.rows[0].count) >= 5) throw new RequestError(429, "passkey_challenge_capacity", "too many outstanding challenges");
    const id = randomUUID();
    const row = await client.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      INSERT INTO rail_owner_challenges(challenge_id,user_id,auth_version,session_fingerprint,
      kind,challenge,operation,operation_fingerprint,bootstrap,rp_id,origin,created_at,expires_at,authorization_challenge_id,recovery_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now,now+interval '5 minutes',$12::uuid,$13::uuid FROM instant RETURNING expires_at`,
      [id, principal.userId, principal.authVersion, principal.sessionFingerprint, kind, challenge, operation, fingerprint, bootstrap, this.config.rpId, this.config.origin, authorizationChallengeId ?? null, recoveryId ?? null]);
    return { challengeId: id, expiresAt: new Date(row.rows[0].expires_at).toISOString() };
  }

  async list(principal: OwnerPrincipal) {
    return this.transaction(async client => {
      await this.owner(client, principal);
      const result = await client.query("SELECT credential_id,created_at,revoked_at,device_type,backed_up FROM rail_owner_passkeys WHERE user_id=$1 ORDER BY created_at LIMIT 100", [principal.userId]);
      return result.rows.map(row => ({ credentialId: row.credential_id, createdAt: new Date(row.created_at).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null, deviceType: row.device_type, backedUp: row.backed_up }));
    });
  }

  private async audit(client: PoolClient, principal: OwnerPrincipal, type: string, fields: Record<string, unknown>) {
    await client.query("INSERT INTO outbox(type,payload) VALUES($1,$2::jsonb)", [type, JSON.stringify({ walletId: principal.walletId, ...fields })]);
  }

  private recoveryCodeHash(userId: string, code: string): string {
    return hash(JSON.stringify(["rail:owner-recovery-code:v1", userId, code]));
  }

  private async issueRecoveryCodes(client: PoolClient, userId: string): Promise<string[]> {
    const count = await client.query("SELECT count(*) FROM rail_owner_recovery_codes WHERE user_id=$1", [userId]);
    if (Number(count.rows[0].count) >= 10000) throw new RequestError(409, "recovery_code_capacity", "retained recovery-code capacity reached");
    await client.query("UPDATE rail_owner_recovery_codes SET revoked_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL", [userId]);
    const generationId = randomUUID(), codes = Array.from({ length: 10 }, () => `rail_recovery_${randomBytes(32).toString("base64url")}`);
    for (const code of codes) await client.query("INSERT INTO rail_owner_recovery_codes(code_hash,user_id,generation_id) VALUES($1,$2,$3)", [this.recoveryCodeHash(userId, code), userId, generationId]);
    return codes;
  }

  async rotateRecoveryCodes(principal: OwnerPrincipal, value: unknown) {
    if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "grantToken")) invalid();
    const grantToken = value.grantToken;
    return this.transaction(async client => {
      const owner = await this.owner(client, principal);
      if (owner.owner_recovery_pending) throw new RequestError(403, "recovery_enrollment_required", "complete recovery enrollment first");
      await this.consumeGrant(client, principal, grantToken, "recovery_codes", RECOVERY_CODES_FINGERPRINT);
      const recoveryCodes = await this.issueRecoveryCodes(client, principal.userId!);
      await this.audit(client, principal, "owner.recovery_codes_rotated", { count: recoveryCodes.length });
      return { recoveryCodes };
    });
  }

  async revokePasskey(principal: OwnerPrincipal, value: unknown) {
    if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "grantToken") || !Object.hasOwn(value, "credentialId") || typeof value.credentialId !== "string") invalid();
    const credentialId = value.credentialId, grantToken = value.grantToken, fingerprint = revokePasskeyFingerprint(credentialId);
    return this.transaction(async client => {
      await this.owner(client, principal);
      await this.consumeGrant(client, principal, grantToken, "passkey_revoke", fingerprint);
      const target = await client.query("SELECT revoked_at FROM rail_owner_passkeys WHERE credential_id=$1 AND user_id=$2 FOR UPDATE", [credentialId, principal.userId]);
      if (!target.rowCount) throw new RequestError(404, "passkey_not_found", "passkey not found");
      if (target.rows[0].revoked_at) return { credentialId, revoked: true };
      const count = await client.query("SELECT count(*) FROM rail_owner_passkeys WHERE user_id=$1 AND revoked_at IS NULL", [principal.userId]);
      if (Number(count.rows[0].count) <= 1) throw new RequestError(409, "last_passkey", "enroll a replacement before removing the last passkey");
      await client.query("UPDATE rail_owner_passkeys SET revoked_at=clock_timestamp() WHERE credential_id=$1", [credentialId]);
      await this.audit(client, principal, "owner.passkey_revoked", { credentialId });
      return { credentialId, revoked: true };
    });
  }

  async recover(principal: OwnerPrincipal, value: unknown) {
    if (!isRecord(value) || Object.keys(value).length !== 3 || !["password", "newPassword", "recoveryCode"].every(key => Object.hasOwn(value, key)) || typeof value.password !== "string" ||
        value.password.length < 8 || Buffer.byteLength(value.password) > 72 || typeof value.newPassword !== "string" ||
        value.newPassword.length < 12 || Buffer.byteLength(value.newPassword) > 72 || value.newPassword === value.password ||
        typeof value.recoveryCode !== "string" || !/^rail_recovery_[A-Za-z0-9_-]{43}$/.test(value.recoveryCode)) invalid();
    const password = value.password, newPassword = value.newPassword, recoveryCode = value.recoveryCode;
    return this.transaction(async client => {
      const owner = await this.owner(client, principal);
      if (!await compare(password, owner.password_hash)) throw new RequestError(401, "recovery_verification_failed", "recovery verification failed");
      if (owner.auth_version >= 2147483647) throw new RequestError(409, "owner_version_capacity", "owner session version limit reached");
      const code = await client.query(`UPDATE rail_owner_recovery_codes SET consumed_at=clock_timestamp()
        WHERE code_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING code_hash`, [this.recoveryCodeHash(principal.userId!, recoveryCode), principal.userId]);
      if (!code.rowCount) throw new RequestError(401, "recovery_verification_failed", "recovery verification failed");
      const revokedAgents = await withdrawOwnerAgentAuthority(client, principal.walletId);
      const withdrawnWalletAuthority = await withdrawWalletSpendingAuthority(client, principal.walletId);
      await client.query("UPDATE rail_owner_passkeys SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL", [principal.userId]);
      const newVersion = Number(owner.auth_version) + 1;
      await client.query("UPDATE users SET password_hash=$2,auth_version=$3,owner_recovery_pending=true WHERE user_id=$1", [principal.userId, await hashPassword(newPassword, 10), newVersion]);
      // Keep unused codes usable while enrollment is pending, so response loss is recoverable.
      await client.query("UPDATE rail_owner_recoveries SET superseded_at=clock_timestamp() WHERE user_id=$1 AND completed_at IS NULL AND superseded_at IS NULL", [principal.userId]);
      const token = generateToken(principal.userId!, newVersion), recoveryToken = `rail_reenroll_${randomBytes(32).toString("base64url")}`;
      const recovery = await client.query(`WITH instant AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_owner_recoveries(recovery_id,user_id,auth_version,token_hash,session_fingerprint,rp_id,origin,created_at,expires_at,consumed_code_hash)
        SELECT $1,$2,$3,$4,$5,$6,$7,now,now+interval '10 minutes',$8 FROM instant RETURNING expires_at`,
        [randomUUID(), principal.userId, newVersion, hash(recoveryToken), hash(token), this.config.rpId, this.config.origin, code.rows[0].code_hash]);
      await this.audit(client, principal, "owner.recovery_started", { sessionsRevoked: "all", agentAuthorityRevoked: true, revokedAgents, ...withdrawnWalletAuthority });
      return { token, recoveryToken, expiresAt: new Date(recovery.rows[0].expires_at).toISOString(),
        recoveryPending: true, agentAuthorityRevoked: true, sessionsRevoked: "all" };
    });
  }

  async registrationOptions(principal: OwnerPrincipal, value: unknown) {
    if (!isRecord(value) || Object.keys(value).some(key => !["password", "grantToken", "recoveryToken"].includes(key))) invalid();
    const password = value.password, grantToken = value.grantToken, recoveryToken = value.recoveryToken;
    return this.transaction(async client => {
      const owner = await this.owner(client, principal);
      const keys = await client.query("SELECT credential_id,revoked_at FROM rail_owner_passkeys WHERE user_id=$1", [principal.userId]);
      if (keys.rowCount! >= 100 || keys.rows.filter(key => !key.revoked_at).length >= 10) throw new RequestError(409, "passkey_capacity", "passkey capacity reached");
      const bootstrap = keys.rowCount === 0;
      let authorizationChallengeId: string | undefined, recoveryId: string | undefined;
      if (recoveryToken !== undefined) {
        if (typeof recoveryToken !== "string" || !/^rail_reenroll_[A-Za-z0-9_-]{43}$/.test(recoveryToken) || !owner.owner_recovery_pending)
          throw new RequestError(403, "recovery_enrollment_required", "valid scoped recovery authorization required");
        const recovery = await client.query(`SELECT recovery_id FROM rail_owner_recoveries WHERE token_hash=$1 AND user_id=$2
          AND auth_version=$3 AND session_fingerprint=$4 AND rp_id=$5 AND origin=$6 AND completed_at IS NULL
          AND superseded_at IS NULL AND consumed_code_hash IS NOT NULL AND expires_at>clock_timestamp() FOR UPDATE`,
          [hash(recoveryToken), principal.userId, principal.authVersion, principal.sessionFingerprint, this.config.rpId, this.config.origin]);
        if (!recovery.rowCount) throw new RequestError(403, "recovery_enrollment_required", "valid scoped recovery authorization required");
        recoveryId = String(recovery.rows[0].recovery_id);
      } else if (owner.owner_recovery_pending) {
        throw new RequestError(403, "recovery_enrollment_required", "scoped recovery authorization required");
      } else if (bootstrap) {
        if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password) > 72 || !await compare(password, owner.password_hash))
          throw new RequestError(401, "password_reauthentication_failed", "password reauthentication failed");
      } else authorizationChallengeId = (await this.consumeGrant(client, principal, grantToken, "passkey_enroll", ENROLLMENT_FINGERPRINT)).challengeId;
      const options = await generateRegistrationOptions({ rpName: "Rail", rpID: this.config.rpId, userName: principal.userId!,
        userID: createHash("sha256").update(`rail:passkey-user:v1:${principal.userId}`).digest(), timeout: 300000,
        attestationType: "none", supportedAlgorithmIDs: [-7, -8, -257],
        excludeCredentials: keys.rows.filter(row => !row.revoked_at).map(row => ({ id: row.credential_id })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" } });
      return { ...await this.challenge(client, principal, "registration", options.challenge, "passkey_enroll", ENROLLMENT_FINGERPRINT, bootstrap, authorizationChallengeId, recoveryId), options };
    });
  }

  private async claim(client: PoolClient, principal: OwnerPrincipal, challengeId: unknown, kind: string) {
    if (typeof challengeId !== "string" || !/^[a-f0-9-]{36}$/.test(challengeId)) invalid();
    const result = await client.query(`WITH instant AS (SELECT clock_timestamp() AS now)
      UPDATE rail_owner_challenges SET used_at=instant.now FROM instant
      WHERE challenge_id=$1 AND user_id=$2 AND auth_version=$3 AND session_fingerprint=$4 AND kind=$5
        AND rp_id=$6 AND origin=$7 AND used_at IS NULL AND expires_at>instant.now RETURNING rail_owner_challenges.*`,
      [challengeId, principal.userId, principal.authVersion, principal.sessionFingerprint, kind, this.config.rpId, this.config.origin]);
    if (!result.rowCount) throw new RequestError(409, "passkey_challenge_unavailable", "challenge is expired, used or belongs to another session");
    return result.rows[0];
  }

  private response(value: unknown): { challengeId: unknown; response: Record<string, unknown> } {
    if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "challengeId") || !isRecord(value.response) ||
        Buffer.byteLength(JSON.stringify(value.response)) > 65536) invalid();
    return { challengeId: value.challengeId, response: structuredClone(value.response) };
  }

  private sameOrigin(response: Record<string, unknown>): void {
    const encoded = (response.response as Record<string, unknown> | undefined)?.clientDataJSON;
    if (typeof encoded !== "string" || encoded.length > 8192 || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) throw new Error();
    const data: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isRecord(data) || (data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) throw new Error();
  }

  async register(principal: OwnerPrincipal, value: unknown) {
    const input = this.response(value);
    const result = await this.transaction(async client => {
      const owner = await this.owner(client, principal);
      const challenge = await this.claim(client, principal, input.challengeId, "registration");
      const keys = await client.query("SELECT credential_id,revoked_at FROM rail_owner_passkeys WHERE user_id=$1", [principal.userId]);
      if (keys.rowCount! >= 100 || keys.rows.filter(key => !key.revoked_at).length >= 10 || (challenge.bootstrap && keys.rowCount! > 0 && !challenge.recovery_id))
        return new RequestError(409, "passkey_enrollment_changed", "enrollment state changed; obtain fresh authorization");
      if (challenge.recovery_id) {
        const recovery = await client.query(`SELECT 1 FROM rail_owner_recoveries WHERE recovery_id=$1 AND user_id=$2 AND auth_version=$3
          AND session_fingerprint=$4 AND completed_at IS NULL AND superseded_at IS NULL AND consumed_code_hash IS NOT NULL AND expires_at>clock_timestamp()`,
          [challenge.recovery_id, principal.userId, principal.authVersion, principal.sessionFingerprint]);
        if (!owner.owner_recovery_pending || !recovery.rowCount) return new RequestError(403, "recovery_enrollment_required", "recovery authorization is no longer active");
      } else if (owner.owner_recovery_pending) return new RequestError(403, "recovery_enrollment_required", "scoped recovery authorization required");
      else if (!challenge.bootstrap) {
        const authorized = await client.query(`SELECT 1 FROM rail_owner_step_up_grants grant_record JOIN rail_owner_passkeys key ON key.credential_id=grant_record.credential_id
          WHERE grant_record.challenge_id=$1 AND grant_record.user_id=$2 AND grant_record.auth_version=$3 AND grant_record.session_fingerprint=$4
            AND grant_record.operation='passkey_enroll' AND grant_record.operation_fingerprint=$5 AND grant_record.consumed_at IS NOT NULL AND key.revoked_at IS NULL`,
          [challenge.authorization_challenge_id, principal.userId, principal.authVersion, principal.sessionFingerprint, ENROLLMENT_FINGERPRINT]);
        if (!authorized.rowCount) return new RequestError(403, "owner_step_up_required", "enrollment authorization was withdrawn");
      }
      let verification;
      try {
        this.sameOrigin(input.response);
        verification = await verifyRegistrationResponse({ response: input.response as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpId,
          requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -8, -257] });
        if (verification.verified) assertPasskeyPublicKey(verification.registrationInfo.credential.publicKey);
      } catch { return new RequestError(401, "passkey_verification_failed", "passkey verification failed"); }
      if (!verification.verified || !verification.registrationInfo.userVerified) return new RequestError(401, "passkey_verification_failed", "passkey verification failed");
      if (!(await client.query("SELECT 1 FROM rail_owner_challenges WHERE challenge_id=$1 AND expires_at>clock_timestamp()", [challenge.challenge_id])).rowCount)
        return new RequestError(409, "passkey_challenge_unavailable", "challenge expired during verification");
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
      try {
        return await withTransactionSavepoint(client, async () => {
          const inserted = await client.query(`INSERT INTO rail_owner_passkeys(credential_id,user_id,public_key,sign_count,device_type,backed_up,enrollment_challenge_id,recovery_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING credential_id`,
            [credential.id, principal.userId, Buffer.from(credential.publicKey), credential.counter, credentialDeviceType, credentialBackedUp, challenge.challenge_id, challenge.recovery_id]);
          if (!inserted.rowCount) throw new RequestError(409, "passkey_already_registered", "passkey is already registered");
          if (challenge.recovery_id) {
            const completed = await client.query(`WITH instant AS (SELECT clock_timestamp() AS now)
              UPDATE rail_owner_recoveries SET completed_at=instant.now FROM instant
              WHERE recovery_id=$1 AND completed_at IS NULL AND superseded_at IS NULL AND expires_at>instant.now RETURNING recovery_id`, [challenge.recovery_id]);
            if (!completed.rowCount) throw new RequestError(403, "recovery_enrollment_required", "recovery authorization expired");
            await client.query("UPDATE users SET owner_recovery_pending=false WHERE user_id=$1", [principal.userId]);
          }
          const recoveryCodes = challenge.bootstrap || challenge.recovery_id ? await this.issueRecoveryCodes(client, principal.userId!) : undefined;
          await this.audit(client, principal, "owner.passkey_enrolled", { credentialId: credential.id, recovery: Boolean(challenge.recovery_id) });
          return { credentialId: credential.id, userVerified: true, ...(recoveryCodes ? { recoveryCodes } : {}) };
        });
      } catch (error) {
        if (error instanceof RequestError) return error;
        throw error;
      }
    });
    if (result instanceof RequestError) throw result;
    return result;
  }

  async authenticationOptions(principal: OwnerPrincipal, value: unknown) {
    if (!isRecord(value) || Object.keys(value).length !== 2 || !OPERATIONS.includes(value.operation as OwnerOperation) ||
        typeof value.operationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.operationFingerprint)) invalid();
    const operation = value.operation as OwnerOperation, fingerprint = value.operationFingerprint;
    if (operation === "passkey_enroll" && fingerprint !== ENROLLMENT_FINGERPRINT) invalid();
    return this.transaction(async client => {
      const owner = await this.owner(client, principal);
      if (owner.owner_recovery_pending) throw new RequestError(403, "recovery_enrollment_required", "complete recovery enrollment first");
      const keys = await client.query("SELECT credential_id FROM rail_owner_passkeys WHERE user_id=$1 AND revoked_at IS NULL", [principal.userId]);
      if (!keys.rowCount) throw new RequestError(409, "passkey_enrollment_required", "enroll a passkey first");
      const options = await generateAuthenticationOptions({ rpID: this.config.rpId, timeout: 300000, userVerification: "required",
        allowCredentials: keys.rows.map(row => ({ id: row.credential_id })) });
      return { ...await this.challenge(client, principal, "authentication", options.challenge, operation, fingerprint), options };
    });
  }

  async authenticate(principal: OwnerPrincipal, value: unknown) {
    const input = this.response(value);
    const result = await this.transaction(async client => {
      const owner = await this.owner(client, principal);
      if (owner.owner_recovery_pending) throw new RequestError(403, "recovery_enrollment_required", "complete recovery enrollment first");
      const challenge = await this.claim(client, principal, input.challengeId, "authentication");
      const found = typeof input.response.id === "string" ? await client.query("SELECT * FROM rail_owner_passkeys WHERE credential_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE", [input.response.id, principal.userId]) : undefined;
      const key = found?.rows[0];
      if (!key) return new RequestError(401, "passkey_verification_failed", "passkey verification failed");
      let verification;
      try {
        assertPasskeyPublicKey(new Uint8Array(key.public_key));
        this.sameOrigin(input.response);
        const userHandle = (input.response.response as Record<string, unknown> | undefined)?.userHandle;
        const expectedHandle = createHash("sha256").update(`rail:passkey-user:v1:${principal.userId}`).digest("base64url");
        if (userHandle !== undefined && userHandle !== null && userHandle !== expectedHandle) throw new Error();
        verification = await verifyAuthenticationResponse({ response: input.response as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpId, requireUserVerification: true,
          credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: Number(key.sign_count) } });
      } catch { return new RequestError(401, "passkey_verification_failed", "passkey verification failed"); }
      if (!verification.verified || !verification.authenticationInfo.userVerified || verification.authenticationInfo.credentialDeviceType !== key.device_type)
        return new RequestError(401, "passkey_verification_failed", "passkey verification failed");
      if (!(await client.query("SELECT 1 FROM rail_owner_challenges WHERE challenge_id=$1 AND expires_at>clock_timestamp()", [challenge.challenge_id])).rowCount)
        return new RequestError(409, "passkey_challenge_unavailable", "challenge expired during verification");
      await client.query("UPDATE rail_owner_passkeys SET sign_count=$2,backed_up=$3 WHERE credential_id=$1", [key.credential_id, verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp]);
      const token = `rail_step_up_${randomBytes(32).toString("base64url")}`;
      const grant = await client.query(`WITH instant AS (SELECT clock_timestamp() AS now)
        INSERT INTO rail_owner_step_up_grants(token_hash,challenge_id,credential_id,user_id,auth_version,
        session_fingerprint,operation,operation_fingerprint,created_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,now,now+interval '2 minutes' FROM instant RETURNING expires_at`,
        [hash(token), challenge.challenge_id, key.credential_id, principal.userId, principal.authVersion, principal.sessionFingerprint, challenge.operation, challenge.operation_fingerprint]);
      return { grantToken: token, operation: challenge.operation, operationFingerprint: challenge.operation_fingerprint,
        expiresAt: new Date(grant.rows[0].expires_at).toISOString(), userVerified: true };
    });
    // Verification failure consumes the claimed challenge in a committed transaction.
    if (result instanceof RequestError) throw result;
    return result;
  }

  /** Must be called inside the protected operation's transaction, never as a preflight. */
  async consumeGrant(client: PoolClient, principal: OwnerPrincipal, token: unknown, operation: OwnerOperation, fingerprint: string) {
    return withTransactionSavepoint(client, async () => {
      const owner = await this.owner(client, principal);
      if (owner.owner_recovery_pending) throw new RequestError(403, "recovery_enrollment_required", "complete recovery enrollment first");
      if (typeof token !== "string" || !/^rail_step_up_[A-Za-z0-9_-]{43}$/.test(token)) throw new RequestError(403, "owner_step_up_required", "exact-operation owner step-up required");
      const result = await client.query(`WITH instant AS (SELECT clock_timestamp() AS now)
        UPDATE rail_owner_step_up_grants grant_record SET consumed_at=instant.now FROM instant
        WHERE token_hash=$1 AND user_id=$2 AND auth_version=$3 AND session_fingerprint=$4 AND operation=$5 AND operation_fingerprint=$6
          AND consumed_at IS NULL AND expires_at>instant.now AND EXISTS
          (SELECT 1 FROM rail_owner_passkeys key WHERE key.credential_id=grant_record.credential_id AND key.user_id=grant_record.user_id AND key.revoked_at IS NULL)
        RETURNING credential_id,challenge_id`, [hash(token), principal.userId, principal.authVersion, principal.sessionFingerprint, operation, fingerprint]);
      if (!result.rowCount) throw new RequestError(403, "owner_step_up_required", "exact-operation owner step-up required");
      const key = await client.query("SELECT public_key FROM rail_owner_passkeys WHERE credential_id=$1", [result.rows[0].credential_id]);
      try { assertPasskeyPublicKey(new Uint8Array(key.rows[0].public_key)); }
      catch { throw new RequestError(403, "owner_step_up_required", "owner passkey is not a safe supported key"); }
      return { method: "passkey" as const, credentialId: String(result.rows[0].credential_id), challengeId: String(result.rows[0].challenge_id), operation, operationFingerprint: fingerprint };
    });
  }
}
