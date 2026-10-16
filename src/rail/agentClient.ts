import { createHash, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { assertEd25519PublicKey } from "../crypto/transactionSigning.js";
import type { AgentAuthorityStore, AgentCheckout } from "../persistence/agentAuthority.js";

type AgentIntent = Awaited<ReturnType<AgentAuthorityStore["createIntent"]>>;
export interface AgentIntentRequest {
  readonly mandateId: string;
  readonly clientRequestId: string;
  readonly receiverWalletId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly ttlSeconds?: number;
  readonly checkout?: AgentCheckout;
  readonly merchantQuoteProof?: { readonly keyId: string; readonly signature: string };
}

export class AgentClientError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterSeconds?: number) {
    super(`Agent request failed (${status || "network"})`);
    this.name = "AgentClientError";
  }
}

const MAX_BODY_BYTES = 65536;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Node.js helper for an external agent process; it never receives owner/provider credentials. */
export class AgentClient {
  readonly #origin: string;
  readonly #token: string;
  readonly #privateKey: KeyObject;
  readonly #publicKey: JsonWebKey;
  readonly #timeoutMs: number;

  constructor(options: { readonly origin: string; readonly token: string; readonly privateKey: KeyObject;
    readonly timeoutMs?: number; readonly allowLocalHttp?: boolean }) {
    let origin: URL;
    try { origin = new URL(options.origin); } catch { throw new Error("INVALID_AGENT_CLIENT_ORIGIN"); }
    const timeout = options.timeoutMs ?? 10000;
    if (origin.origin !== options.origin || origin.username || origin.password ||
        (origin.protocol !== "https:" && !(options.allowLocalHttp === true && process.env.NODE_ENV !== "production" && origin.protocol === "http:" && origin.hostname === "localhost")))
      throw new Error("INVALID_AGENT_CLIENT_ORIGIN");
    if (!/^rail_agent_[A-Za-z0-9_-]{43}$/.test(options.token) || options.privateKey.type !== "private" || options.privateKey.asymmetricKeyType !== "ed25519" ||
        !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error("INVALID_AGENT_CLIENT_CONFIGURATION");
    const publicKey = createPublicKey(options.privateKey).export({ format: "jwk" });
    assertEd25519PublicKey(Buffer.from(publicKey.x!, "base64url"));
    this.#origin = options.origin; this.#token = options.token; this.#privateKey = options.privateKey;
    this.#publicKey = Object.freeze(publicKey); this.#timeoutMs = timeout;
  }

  private async exchange(method: "GET" | "POST", path: string, body: string | undefined, proof?: string) {
    let response: Response;
    try {
      response = await fetch(`${this.#origin}${path}`, { method, redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(this.#timeoutMs), headers: { Authorization: `DPoP ${this.#token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(proof ? { DPoP: proof } : {}) }, body });
    } catch { throw new AgentClientError(0, "agent_network_error"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let length = 0, data: unknown;
    try {
      if (reader) for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error(); }
        chunks.push(chunk.value);
      }
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw new AgentClientError(response.status, "invalid_agent_response"); }
    finally { reader?.releaseLock(); }
    if (!record(data)) throw new AgentClientError(response.status, "invalid_agent_response");
    if (!response.ok) {
      const code = typeof data.error === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(data.error) ? data.error : "agent_request_rejected";
      const seconds = Number(response.headers.get("retry-after"));
      throw new AgentClientError(response.status, code, response.headers.has("retry-after") && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : undefined);
    }
    return data;
  }

  private async request(method: "GET" | "POST", path: string, value?: unknown) {
    // Serialize before awaiting the nonce so caller mutation cannot alter the signed purchase.
    const body = value === undefined ? undefined : JSON.stringify(value);
    if (body !== undefined && Buffer.byteLength(body) > MAX_BODY_BYTES) throw new AgentClientError(0, "agent_request_too_large");
    const challenge = await this.exchange("POST", "/v2/agent/nonces", "{}");
    if (typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) ||
        Buffer.from(challenge.nonce, "base64url").toString("base64url") !== challenge.nonce)
      throw new AgentClientError(200, "invalid_agent_nonce_response");
    const header = { typ: "dpop+jwt", alg: "EdDSA", jwk: this.#publicKey };
    const claims = { htm: method, htu: `${this.#origin}${path}`, iat: Math.floor(Date.now() / 1000), jti: randomBytes(32).toString("base64url"),
      nonce: challenge.nonce, ath: digest(this.#token), rail_body_sha256: digest(body ?? "") };
    const input = [header, claims].map(item => Buffer.from(JSON.stringify(item)).toString("base64url")).join(".");
    const proof = `${input}.${sign(null, Buffer.from(input), this.#privateKey).toString("base64url")}`;
    return this.exchange(method, path, body, proof);
  }

  async identity() {
    const data = await this.request("GET", "/v2/agent/identity");
    if (!record(data.identity)) throw new AgentClientError(200, "invalid_agent_response");
    return data.identity;
  }

  async listIntents(): Promise<readonly AgentIntent[]> {
    const data = await this.request("GET", "/v2/agent/intents");
    if (!Array.isArray(data.intents)) throw new AgentClientError(200, "invalid_agent_response");
    return data.intents as AgentIntent[];
  }

  async proposeIntent(value: AgentIntentRequest): Promise<AgentIntent> {
    const data = await this.request("POST", "/v2/agent/intents", value);
    if (!record(data.intent)) throw new AgentClientError(200, "invalid_agent_response");
    return data.intent as unknown as AgentIntent;
  }

  async executeIntent(intentId: string, requestFingerprint: string) {
    if (!UUID.test(intentId) || !/^[a-f0-9]{64}$/.test(requestFingerprint)) throw new AgentClientError(0, "invalid_agent_execution_request");
    const data = await this.request("POST", `/v2/agent/intents/${intentId}/execute`, { requestFingerprint });
    if (!record(data.intent) || !record(data.result)) throw new AgentClientError(200, "invalid_agent_response");
    return data as unknown as Awaited<ReturnType<AgentAuthorityStore["executeIntent"]>>;
  }
}
