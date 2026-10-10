# Rail V1 Acceptance Record

Review date: 10 October 2026.

## Decision

Engineering regressions pass for the isolated backend demonstration. Overall V1 sign-off is **pending owner confirmation of release scope**. This record does not approve real-money use, certify absence of vulnerabilities, or silently move unresolved accounting failures into V2.

The intended college/CV scope is an explainable payment-control backend using synthetic money, persisted authorizations, device-bound offline headroom and replay-safe reconnect synchronization. It is not a bank, externally settled wallet or standalone offline payment network.

## Verified Repository Behavior

| Area | Evidence |
| --- | --- |
| Authentication | Wallet ownership protection, IP/account quotas, bounded JWT claims, database-version logout-all and fresh login after revocation. |
| Payment execution | One PostgreSQL transaction coordinates authorization use, wallets, offline spend records, balanced ledger, execution, outbox and replay state. |
| Recovery | Matching retries return stored results; changed payloads fail. Injected failures and terminated database connections roll back effects. |
| Accounting | Immutable baselines/history, balance and reservation equations, bounded snapshot-consistent reconciliation. |
| Offline flow | Token/device binding, idempotent spend/finalization/rollback and authorization-first sync. Device IDs are identifiers, not hardware identity proofs. |
| Events | Committed, wallet-filtered REST history; advisory bounded SSE; leased outbox delivery retries and dead letters. |
| Resources | Body size/deadline enforcement, real HTTP 413/408 tests, bounded development replay/diagnostic stores. |
| Demonstration | Explicit non-production mode, isolated synthetic schema, matching replay, expected balances and clean reconciliation. |
| Regression suite | 86 local tests pass without skips; final revision must also pass the Node 22/24 PostgreSQL CI matrix. |

## Removed Redundancies

- Unused saga coordinator and its package export: database rollback replaces compensation for the current financial path.
- Unused stage timeout/retry wrappers: the timeout race could leave work running after reporting failure. Durable execution uses database deadlines, not a JavaScript race around commit.
- Duplicate pipeline-builder alias and redundant exception catch/rethrow.
- HTTP memory-store union and query-credential options that contradicted the supported runtime/security contract.
- Placeholder HSM module/export: one configuration guard rejects unsupported providers instead of advertising selectable implementations.

The tested memory stores, retry/semaphore utilities, atomic accounting guards and durable outbox are retained. Their different responsibilities are not redundancy. Existing shadow-model and Merkle tests remain experimental regressions, not approved financial controls or deployed blockchain functionality.

## Unresolved Release Gates

1. Confirm college/CV demonstration versus production/real-money release. These are different acceptance standards.
2. Preserve and review the historical development database. The last read-only scan found 161 potentially overlapping findings, including three missing opening balances. No historical balances were guessed, repaired or deleted. It must not be presented as a clean acceptance dataset.
3. Before deployment: verify least-privilege runtime credentials, provider proxy sanitation, pool capacity, worker/sweep scheduling, transport limits, backups and failure monitoring. Local/CI tests cannot establish those facts.
4. Before real-money expansion: implement and validate funding/refunds/reversals, fraud/step-up policy, device enrollment/signing/revocation and supported key-management providers. Define reconciliation, incident response and financial record-retention procedures.

## Reproduction

Use a disposable development PostgreSQL database with the documented secrets configured. Run `npm test`, then `RAIL_DEMO_MODE=true npm run demo`. The demonstration creates and removes only its own schema and requires schema-management permissions. Production runtime credentials should not have those permissions.

`npm run accounting:reconcile` is read-only by default and returns a failure exit code for accounting findings. A passing demonstration does not override a failed historical reconciliation scan.

The detailed finding ledger remains in [SECURITY_REVIEW.md](SECURITY_REVIEW.md); implementation history and file responsibilities remain in [PROJECT_STATUS_REPORT.md](PROJECT_STATUS_REPORT.md).
