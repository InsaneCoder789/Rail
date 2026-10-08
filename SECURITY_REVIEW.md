# Rail V2 Security Review

Review date: 8 October 2026. Baseline: `80e09e4`. Active development branch: `main`.

This is a source review and regression record, not a penetration-test certification. Runtime source, API entrypoint, persistence schema, workflow and tests were examined. Root documents and deliverables were inventoried; selected architecture documents were checked for drift. Archived ZIPs and rendered diagrams have not received a fresh visual review. No production deployment or provider sandbox was tested.

Severity measures potential impact. A finding does not imply every issue is reachable without authentication.

## Findings

| ID | Severity | Evidence and failure scenario | Status and next action |
|---|---|---|---|
| SEC-01 | Critical | `server/routes/authRoutes.ts` ignored wallet insertion conflicts, then attached a new user to that existing wallet. Knowing an unregistered wallet identifier could grant access. | Fixed: conflict and transaction rollback. Live PostgreSQL test verifies ownership and funds are unchanged. |
| SEC-02 | High | `persistence/postgresRateLimiter.ts`: row locking cannot lock an absent bucket; parallel first calls could overwrite the hit counter. | Fixed: create before locking. Twelve concurrent requests at quota three admit exactly three. |
| SEC-03 | High | Login/register quotas included caller-selected usernames. Rotating usernames created new quotas. | Fixed for IP-level bypass: one quota per IP and route across usernames. Account-level distributed protection remains open; shared NAT clients share this quota. |
| SEC-04 | Medium | Auth and execute routes cast JSON without object checks; null could trigger 500. | Fixed at authentication/execute boundaries; auth tests cover null, arrays, strings and numbers. |
| SEC-05 | Medium | Registration allowed inputs beyond bcrypt's 72-byte limit. Password suffixes could be ignored. | Fixed: eight-character minimum and 72 UTF-8 byte maximum. Existing longer passwords need an explicit reset plan. |
| SEC-06 | High | `paymentRoutes.ts` requires a stored idempotency result for used authorization. A crash after ledger commit but before result insertion blocks requests before ledger recovery. Expiry also precedes completed replay. | Open: persist full request fingerprint/result atomically with money; add response-loss HTTP tests. |
| SEC-07 | High | `pipeline/engine.ts`, `server/events.ts`: shared memory outbox is drained after money commits; failed executions can leave events for another request. Database event errors are swallowed. | Open: transactional events and durable worker leases, retries and dead-letter state. |
| SEC-08 | High | `transactionSigning.ts`, `engine.ts`: fingerprint omits authorization ID. Canonical payloads join unrestricted strings using a delimiter, allowing ambiguous encodings. | Open: versioned JSON/length-prefixed signing and fingerprint migration with compatibility tests. |
| SEC-09 | High | `paymentPipeline.ts`: claim checks auth ID/transaction ID; full wallet/amount binding is only checked in HTTP routes. Direct engine callers can bypass it. | Open: enforce complete authorization binding within the locked money transaction and recovery path. |
| SEC-10 | High | `postgresIdempotency.ts` holds a connection while the pipeline acquires another. Concurrent requests can exhaust the pool. Session advisory locks require session-affine connections. | Open: one client/transaction per payment, bounded ingress and explicit pooler compatibility; discard clients after unlock failure. |
| SEC-11 | High | Both offline-token stores lack safe positive amount validation for direct calls; rollback is not tied to a recorded reservation. Memory rollback can restore capacity repeatedly. | Open: store-level validation and spend records keyed by transaction ID, with rollback/replay tests. HTTP validation currently reduces exposure. |
| SEC-12 | High | `config.ts` implicitly trusts proxy headers in all serverless runtimes; proxy sanitation is not established by that flag. API key strength is not checked with JWT/signing secrets. | Open: explicit provider trust policy, key generation/rotation and production config tests. |
| SEC-13 | High | `authorizationStage.ts`: issuance cannot lock an absent transaction ID; concurrent matching requests can fail uniqueness instead of replaying. Serverless requests do not clean up expiry. | Open: serialize issuance and implement transactional expiry plus scheduled cleanup. |
| SEC-14 | Medium | Invalid JWTs and missing API-key/user rows become internal errors rather than 401. No revocation or account-level progressive delay. | Open: typed errors, explicit algorithm policy, revocation and account-level throttling. |
| SEC-15 | High | Risk depended on caller-selected transaction IDs; challenge events did not stop execution. | Placeholder removed. No enforced fraud policy is claimed. Optional trained ML emits shadow observations only. Rules/step-up and real-data validation remain open. |
| SEC-16 | High | `postgresWalletStore.ts` and authorization helpers use different balance conventions. Reconciliation does not validate opening balances plus movements; balancing is not enforced at commit. | Open: one transaction/accounting service, balance equations, deferred balancing constraints, reversals and jobs. |
| SEC-17 | Medium | Semaphore releases a slot before the waiter resumes; a new caller can take it too. Retry ignores already-aborted signals and retains listeners; timeout does not cancel work. | Open: slot handoff, queue bounds and cancellation around commit. |
| SEC-18 | Medium | Event reads filter a bounded global list after fetching, so busy wallets can hide another wallet's history. SSE history task can reject unhandled. | Open: wallet-filtered cursor SQL and handled durable delivery/SSE lifecycle. |
| SEC-19 | Medium | Oversized body handling destroys the socket before reliably returning 413. No body deadline; memory DLQ/idempotency grow indefinitely. | Open: deadlines, resource bounds and retention respecting the replay window. |
| SEC-20 | Medium | `crypto/hsm.ts` exposes mode names without implemented providers. Server HMAC cannot safely be shipped to client devices. | Open: device asymmetric signing, enrollment/revocation and working KMS adapter. Offline authorization currently still needs preissued server records. |
| SEC-21 | Low | README recommended URL credentials and adding an already present license; deployment text described PostgreSQL rate limits as process-local. | Corrected in V2 documentation; archived local manuals remain older snapshots. |

## Verification and release gates

The first V2 pass passes 26 tests, including four live PostgreSQL tests, with no skips in the configured local database. `npm audit --json` reported zero known installed-package advisories on 8 October 2026. That does not certify application security. V2 CI now includes branch pushes and a named security/ML/audit step; hosted execution requires a push.

Close transaction/recovery, authorization, outbox and ledger findings before real-money integrations. Enable ML decisions only after temporal validation on consented labeled data, calibration, monitored false positives and a deterministic fallback. Anchor audit batches only after commitments are persisted with ledger state and signing ownership, independent checkpoints, finality and chain reorganization handling are implemented.

An audit anchor proves publication of a commitment. It cannot prove authorization, complete inclusion of all payments, or external settlement. The current Merkle module is a cryptographic building block, not a deployed blockchain service.
