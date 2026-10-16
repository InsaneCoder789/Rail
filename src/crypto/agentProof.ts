import { createHash, createPublicKey, verify } from "node:crypto";
import { RequestError } from "../server/http.js";
import { isRecord } from "../server/validation.js";
import { assertEd25519PublicKey } from "./transactionSigning.js";

const RANDOM_256 = /^[A-Za-z0-9_-]{43}$/;
const MAX_PROOF_BYTES = 8192;
const MAX_AGE_SECONDS = 30;

function denied(): never {
  throw new RequestError(401, "invalid_agent_proof", "invalid agent proof");
}

function decode(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || !value || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) denied();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > maxBytes || bytes.toString("base64url") !== value) denied();
  return bytes;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export interface AgentPublicKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

export function parseAgentPublicKey(value: unknown): AgentPublicKey {
  if (!exact(value, ["kty", "crv", "x"]) || value.kty !== "OKP" || value.crv !== "Ed25519") denied();
  const x = decode(value.x, 32);
  if (x.length !== 32) denied();
  try { assertEd25519PublicKey(x); } catch { denied(); }
  return Object.freeze({ kty: "OKP", crv: "Ed25519", x: x.toString("base64url") });
}

// RFC 7638 uses lexicographic JWK member order, independent of incoming JSON order.
export function agentKeyThumbprint(value: unknown): string {
  const key = parseAgentPublicKey(value);
  return createHash("sha256").update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x })).digest("base64url");
}

export function agentBodyDigest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("base64url");
}

export interface AgentProofRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly accessToken: string;
  readonly body: Uint8Array;
  readonly nonce: string;
  readonly keyThumbprint: string;
  /** Supply database time when composing durable verification and replay admission. */
  readonly nowSeconds: number;
}

export interface VerifiedAgentProof {
  readonly keyThumbprint: string;
  readonly proofId: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly validUntil: number;
  readonly bodyDigest: string;
}

/** Unauthenticated lookup hint only; verifyAgentProof still checks the signed nonce. */
export function agentProofNonce(proof: unknown): string {
  try {
    if (typeof proof !== "string" || Buffer.byteLength(proof) > MAX_PROOF_BYTES) denied();
    const parts = proof.split(".");
    if (parts.length !== 3) denied();
    const claims: unknown = JSON.parse(decode(parts[1], 4096).toString("utf8"));
    if (!isRecord(claims) || typeof claims.nonce !== "string" || !RANDOM_256.test(claims.nonce) || decode(claims.nonce, 32).length !== 32) denied();
    return claims.nonce;
  } catch { denied(); }
}

/** Cryptographic verification only: the caller must atomically consume nonce/proof ID. */
export function verifyAgentProof(proof: unknown, request: AgentProofRequest): VerifiedAgentProof {
  try {
    if (typeof proof !== "string" || Buffer.byteLength(proof) > MAX_PROOF_BYTES) denied();
    const parts = proof.split(".");
    if (parts.length !== 3) denied();
    const header: unknown = JSON.parse(decode(parts[0], 2048).toString("utf8"));
    const claims: unknown = JSON.parse(decode(parts[1], 4096).toString("utf8"));
    const signature = decode(parts[2], 64);
    if (!exact(header, ["typ", "alg", "jwk"]) || header.typ !== "dpop+jwt" || header.alg !== "EdDSA" || signature.length !== 64) denied();
    const key = parseAgentPublicKey(header.jwk);
    const thumbprint = agentKeyThumbprint(key);
    if (!RANDOM_256.test(request.keyThumbprint) || thumbprint !== request.keyThumbprint) denied();
    if (!exact(claims, ["htm", "htu", "iat", "jti", "ath", "nonce", "rail_body_sha256"])) denied();
    if (request.method !== "GET" && request.method !== "POST") denied();
    const url = new URL(request.url);
    if (url.username || url.password || url.search || url.hash || url.href !== request.url ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost"))) denied();
    if (!/^rail_agent_[A-Za-z0-9_-]{43}$/.test(request.accessToken) || !RANDOM_256.test(request.nonce) ||
        !Number.isSafeInteger(request.nowSeconds) || request.nowSeconds < 0 || request.nowSeconds > Number.MAX_SAFE_INTEGER - MAX_AGE_SECONDS ||
        !(request.body instanceof Uint8Array)) denied();
    if (request.method === "GET" && request.body.byteLength !== 0) denied();
    const bodyDigest = agentBodyDigest(request.body);
    if (claims.htm !== request.method || claims.htu !== request.url || claims.nonce !== request.nonce ||
        typeof claims.jti !== "string" || !RANDOM_256.test(claims.jti) || decode(claims.jti, 32).length !== 32 ||
        typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat < 0 ||
        claims.iat > request.nowSeconds || request.nowSeconds - claims.iat > MAX_AGE_SECONDS ||
        claims.ath !== createHash("sha256").update(request.accessToken).digest("base64url") ||
        claims.rail_body_sha256 !== bodyDigest) denied();
    const publicKey = createPublicKey({ key: { ...key }, format: "jwk" });
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), publicKey, signature)) denied();
    return Object.freeze({ keyThumbprint: thumbprint, proofId: claims.jti, nonce: request.nonce,
      issuedAt: claims.iat, validUntil: claims.iat + MAX_AGE_SECONDS, bodyDigest });
  } catch {
    denied();
  }
}
