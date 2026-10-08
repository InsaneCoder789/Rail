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
| SEC-06 | High | Financial commit, replay result and expiry ordering previously diverged. | Fixed for the durable payment path: mutations, transaction fingerprint, execution record, events and replay result commit together. Backend-termination and expired-authorization HTTP replay tests pass. Unverifiable historical crash records require operator reconciliation rather than guessed recovery. |
| SEC-07 | High | Shared outbox, event durability and external delivery. | Payment events now use isolated buffers and durable insertion before financial commit; failed insertion rolls back the payment. Durable external delivery leases, retries and dead-letter state remain open. |
| SEC-08 | High | Fingerprints omitted authorization IDs and signing encodings were ambiguous. | Fixed: versioned JSON arrays and authorization-bound fingerprints; delimiter-collision tests pass. Verified legacy completed records migrate without rerunning money. Missing/ambiguous historical fingerprints fail closed; old client HMACs must be regenerated. |
| SEC-09 | High | Complete binding was formerly left to HTTP. | Fixed for execution and recovery: claims match all financial fields; recovery requires matching transaction fingerprint, used authorization and balanced ledger. Usage conflicts abort the transaction. |
| SEC-10 | High | Nested client acquisition and session advisory locks. | Fixed: single transaction/client per payment and transaction-scoped locks; lock/statement deadlines and failed-client disposal are tested. One-connection-pool concurrent replay and real backend termination pass. Provider-specific pooler deployment remains unverified. |
| SEC-11 | High | Both offline-token stores lack safe positive amount validation for direct calls; rollback is not tied to a recorded reservation. Memory rollback can restore capacity repeatedly. | Open: store-level validation and spend records keyed by transaction ID, with rollback/replay tests. HTTP validation currently reduces exposure. |
| SEC-12 | High | Implicit serverless proxy trust and unchecked service key length. | Fixed: proxy trust requires explicit configuration and production service keys require at least 32 non-whitespace characters. Config tests pass. Provider sanitation and operational key rotation still require deployment verification. |
| SEC-13 | High | Concurrent initial issuance and serverless expiry cleanup. | Issuance race fixed using a transaction-scoped lock; eight concurrent retries reserve once. Transactional expiry and managed cleanup remain open. |
| SEC-14 | Medium | Authentication errors, algorithm policy and credential lifecycle. | Invalid/expired JWTs and unknown credential owners now return 401; HS256 is enforced and claims validated. Session revocation and account-level progressive delay remain open. |
| SEC-15 | High | Risk depended on caller-selected transaction IDs; challenge events did not stop execution. | Placeholder removed. No enforced fraud policy is claimed. Optional trained ML emits shadow observations only. Rules/step-up and real-data validation remain open. |
| SEC-16 | High | `postgresWalletStore.ts` and authorization helpers use different balance conventions. Reconciliation does not validate opening balances plus movements; balancing is not enforced at commit. | Open: one transaction/accounting service, balance equations, deferred balancing constraints, reversals and jobs. |
| SEC-17 | Medium | Semaphore handoff, retry cancellation and stage timeout. | Semaphore slot handoff, idempotent release and bounded queue fixed; retry abort checks and listener cleanup tested. Timeout cancellation around commit remains open. |
| SEC-18 | Medium | Event reads filter a bounded global list after fetching, so busy wallets can hide another wallet's history. SSE history task can reject unhandled. | Open: wallet-filtered cursor SQL and handled durable delivery/SSE lifecycle. |
| SEC-19 | Medium | Oversized body handling destroys the socket before reliably returning 413. No body deadline; memory DLQ/idempotency grow indefinitely. | Open: deadlines, resource bounds and retention respecting the replay window. |
| SEC-20 | Medium | `crypto/hsm.ts` exposes mode names without implemented providers. Server HMAC cannot safely be shipped to client devices. | Open: device asymmetric signing, enrollment/revocation and working KMS adapter. Offline authorization currently still needs preissued server records. |
| SEC-21 | Low | README recommended URL credentials and adding an already present license; deployment text described PostgreSQL rate limits as process-local. | Corrected in V2 documentation; archived local manuals remain older snapshots. |

## Verification and release gates

The first V2 pass passes 26 tests, including four live PostgreSQL tests, with no skips in the configured local database. `npm audit --json` reported zero known installed-package advisories on 8 October 2026. That does not certify application security. V2 CI now includes branch pushes and a named security/ML/audit step; hosted execution requires a push.

Close transaction/recovery, authorization, outbox and ledger findings before real-money integrations. Enable ML decisions only after temporal validation on consented labeled data, calibration, monitored false positives and a deterministic fallback. Anchor audit batches only after commitments are persisted with ledger state and signing ownership, independent checkpoints, finality and chain reorganization handling are implemented.

An audit anchor proves publication of a commitment. It cannot prove authorization, complete inclusion of all payments, or external settlement. The current Merkle module is a cryptographic building block, not a deployed blockchain service.
