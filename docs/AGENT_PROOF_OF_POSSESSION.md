# Agent Proof Of Possession

## Implementation State

**2. Agent authentication: proof-of-possession credentials and key rotation: Completed** for backend implementation and local acceptance, 14 October 2026. Exact owner-approved key enrollment, Ed25519 DPoP verification, PostgreSQL nonce admission, signed HTTP routes, transactional dispatch and atomic owner-approved rotation now work together. The HTTP router has no bearer fallback, including when proof services are missing. Production/private-key custody and hosted interoperability remain Goal 12 gates, not completed claims.

A proof does not authorize a payment by itself: consent, policy and money invariants remain required. Library compatibility fixtures without required runtime controls are not a secure production integration or permission to run a second bearer writer alongside the deployed runtime. Dedicated real-signature tests and Chromium prove this boundary; older policy/ledger routing regressions explicitly mock the proof service to isolate their own behavior.

## Owner-Approved Rotation

Use `POST /v2/agents/<agentId>/credentials/<credentialId>/rotate` with the owner's current JWT and `{ scope, ttlSeconds, publicKey, grantToken }`. `scope` must match the old credential. `publicKey` must be fresh for this agent; private keys are never uploaded. Compute `credentialRotationFingerprint(agentId, credentialId, terms)` and obtain an `agent_credential` passkey grant for that digest. Rotation uses the existing owner-operation mechanism with a distinct v3 digest, not another login service or credential provider.

The same PostgreSQL transaction consumes the grant, locks current owner/agent/source state, revokes the source, inserts its replacement and records the audit event. A single native timestamp binds old revocation to new creation. SQL independently checks scope, predecessor/agent, fresh key, expiry and exact grant terms; the predecessor link is immutable and has at most one successor. Missing grants, changed key/TTL, scope escalation, revoked/expired sources and concurrent losers cannot create another replacement. Audit or final-commit failure restores the source and grant. Stored credential hashes cannot reconstruct returned tokens.

The replacement token is returned once. If its response is lost, use owner-only credential history to find `replacedByCredentialId`; rotate that active successor again with a fresh key and fresh exact passkey grant. Do not retry a consumed grant expecting token disclosure, reactivate the old key or store recoverable plaintext tokens. Retained credential capacity remains 100 per agent; if exhausted, issuance/rotation fails rather than deleting audit history. Long-term archival remains Goal 8.

Old nonces/admitted requests cannot spend after the old credential is revoked. Owner locks serialize withdrawal with dispatch. Pending intents/budgets are not discarded by rotation; the same-scope replacement can continue under current owner policy. Historical receipts keep the original credential/grant and remain verifiable. Fresh proof replay returns the original financial result without another ledger write; fresh executions bind the new credential and its v3 owner approval.

## Interview Explanation

The owner grants permission; the agent proves which key is making the request. Possessing a token alone is insufficient because each request also needs a private-key signature. The signature binds the exact destination, method and payment bytes. A short-lived nonce prevents reuse, while a server-held admission prevents swapping the verified request for another operation. The money transaction still checks policy and funds.

Rotation means "replace this key without changing what it is allowed to do." Owner passkey approval authorizes that replacement; an agent cannot approve its own replacement or expand its scope. Atomic revoke-and-create avoids a half-finished handover. These are ordinary authentication, authorization and database concepts, not AI magic or a blockchain guarantee.

Public-key validation matters as well as signature verification. The local Node verifier accepted a forged signature with the Ed25519 identity key. Rail rejects unsafe public points using the pinned [noble-ed25519 library](https://github.com/paulmillr/noble-ed25519), instead of writing its own curve mathematics. The shared guard also protects owner EdDSA and merchant keys. [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html) describes the signature/point format; this is not a claim of independent implementation certification. HMAC remains server-side evidence protection, not a shared secret shipped to agents.

## HTTP Protocol

Configure `RAIL_AGENT_API_ORIGIN` as the canonical public API origin, without trailing slash, path, credentials, query or fragment. HTTPS is required except non-production localhost HTTP. Invalid values fail startup; absent configuration returns `503 agent_proof_unavailable` for proof routes. The signed URL comes from this setting plus the exact request path, never Host/forwarded headers. Query-bearing and normalized/absolute targets are rejected.

1. Issue the credential through owner JWT plus exact passkey approval, including the agent's public JWK. The deployed runtime requires `publicKey` for both scopes. No private key is uploaded.
2. Request `POST /v2/agent/nonces` with `Authorization: DPoP <token>`, JSON `{}` and no proof yet. Only a current enrolled credential receives the challenge; nonce capacity and source/agent quotas apply.
3. Sign the DPoP JWT using the agent private key, with the returned nonce and exact method, configured-origin URL, token hash and raw-body digest.
4. Send `Authorization: DPoP <token>` and `DPoP: <signed JWT>` on `GET /v2/agent/identity`, `GET/POST /v2/agent/intents` or `POST /v2/agent/intents/<id>/execute`. POST requires bounded valid UTF-8 JSON; GET has no body. CORS explicitly permits the DPoP header.
5. Retry with a new nonce/proof while preserving the proposal request ID or exact executed intent/fingerprint. Replaying a used HTTP proof is rejected; a fresh authenticated retry can return the original completed financial result.

Source quotas allow 30 proof requests per minute, counting nonce requests and actions. Separate agent quotas allow 20 nonce requests and 20 actions per minute; outstanding nonce capacity is stricter than those ceilings. Each normal nonce-plus-action pair therefore consumes two source requests. A quota denial after verification consumes the proof; retry with fresh proof after the wait. Nonce token possession alone cannot execute money, though leaked tokens can consume challenge capacity until expiry; fair admission/availability testing remains Task 4.

## Enrollment And Durable Admission

Credential issuance accepts a public-only `publicKey: { kty: "OKP", crv: "Ed25519", x }`, mandatory in the deployed runtime. Both proposal and execution keys require an exact `agent_credential` passkey grant. The v2 owner-operation digest adds the RFC 7638 key thumbprint to agent, scope and TTL. Unbound historical credentials retain their v1 digest; no old grant or receipt is relabeled. SQL checks the exact public JWK/thumbprint, consumed grant and owner binding and prevents later removal/replacement of the key. Compatibility library writers cannot issue keyed credentials without configuring required owner control.

`AgentProofStore.issueNonce(token)` locks owner, agent and credential in the same order as withdrawal, checks recovery/revocation/expiry and generates a 256-bit nonce. Only its SHA-256 hash persists. Nonces last 60 seconds; each credential may hold five unused and 200 total unexpired records. Expired rows can be pruned on issuance; active/consumed records cannot be rewritten or deleted early. This short-lived anti-replay state is not the long-term financial audit trail.

`authenticate(token, proof, { method, url, body })` snapshots raw bytes, resolves an unauthenticated nonce lookup hint, rechecks live key/owner/agent state, locks the nonce, verifies the signature against database time and claims both nonce and unique credential/proof ID. Concurrent instances cannot accept the same proof twice. Bad signatures/payloads do not consume a nonce; deferred commit failure rolls back admission. A new nonce cannot reuse a retained proof ID. Returned admission metadata remains server-side, never a client-supplied authority claim.

The returned admission is a process-local opaque capability held in a WeakMap. Serializing/copying its visible identity fields loses that capability and cannot grant authority. Dispatch checks the signed method/path and parsed body against an entry snapshot, then claims `dispatched_at` once in the same transaction as intent/money work. A final live-state/freshness check precedes commit. Dispatch rollback restores its claim, not the separately committed HTTP proof; external retries need a new proof. Active admission history is immutable; cleanup after expiry is not long-term audit evidence.

Six cryptographic tests, seven enrollment/admission database cases and five configuration/HTTP/dispatch cases cover these boundaries. Chromium additionally exercises signed agent proposal, money execution and completed replay alongside native owner passkeys and recovery. These local results do not prove deployed interoperability or completed rotation.

## Proof Profile

The cryptographic format follows [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html): `typ: dpop+jwt`, asymmetric signature, public JWK, `htm`, `htu`, `iat`, `jti`, access-token hash `ath` and server nonce. Rail initially restricts this profile to Ed25519/EdDSA and exact public-only `OKP` JWKs. The [RFC 7638 thumbprint](https://www.rfc-editor.org/rfc/rfc7638.html) binds the enrolled key independently of incoming JSON member order. No agent private key is sent to the verifier or shared with Rail.

DPoP alone does not protect the request body. Rail therefore requires `rail_body_sha256`, the base64url SHA-256 digest of the exact received bytes, before JSON parsing or normalization. Whitespace changes require a new proof. This is an application extension, not a claim that arbitrary OAuth DPoP clients already interoperate with Rail. There is no RFC 9421 HTTP Message Signatures implementation in this increment.

The profile accepts only GET/POST, a canonical HTTPS URL, no query/fragment/user-info, and an empty body for GET. Localhost HTTP is available for local acceptance only; production-origin configuration must reject it at the runtime boundary. The verifier must receive the trusted configured origin, not a client-controlled Host or forwarded-origin header. It rejects future proofs and proofs older than 30 seconds. The caller supplies database time, the enrolled key thumbprint and server nonce; none may be accepted from unverified proof claims. JWT headers, payload fields and canonical base64url encodings are strictly bounded and allowlisted.

## Durable Integration Contract

Cryptographic validation must precede nonce claims. Valid proofs must atomically claim a server-issued, credential-bound nonce and a unique credential/proof ID using PostgreSQL, so two application instances cannot independently accept a replay. Failed signatures must not consume another client's valid nonce. Admission may commit before payment execution: retries must use a fresh proof but retain the same financial idempotency key. Money outcomes and signed HTTP proof IDs are different identities.

Before a fresh financial effect, recheck live credential/key/agent/owner state in the financial transaction. A proof verified at ingress must not survive a key rotation or recovery that commits before financial dispatch. Current completed replay returns the original result without moving money again. Rotation must require owner step-up over the exact new public key and old credential, preserve historical receipts, withdraw the old key atomically, and prevent a proposal-only key from expanding into execution authority. Missing proofs on enrolled credentials must fail, not fall back to bearer authentication.

TLS, private-key custody and owner consent remain essential. Possession of an agent signing key does not authorize a recipient, expand a budget, approve an intent or prove an agent's reasoning is safe. Neither signatures nor blockchain eliminate these separate authority boundaries.
