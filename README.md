# Rail

![Rail: Agent payments. Owner authority.](docs/assets/rail-banner-v3.png)

[![Rail CI](https://github.com/InsaneCoder789/Rail/actions/workflows/ci.yml/badge.svg)](https://github.com/InsaneCoder789/Rail/actions/workflows/ci.yml)

**A payment-governance backend for AI agents and people.**

Rail separates requesting a payment from having permission to execute it. People
authorize their own transfers; agents act within owner-defined permissions. Both
paths use the same accounting, replay protection and audit foundations.

## Human And Agent Payments

**For people:** an authenticated user requests an exact payment authorization,
then executes the matching transfer. Retry protection prevents the same request
from moving money twice. The offline-aware path adds pre-issued, device-bound
spending tokens and reconnect synchronization. It still requires a valid stored
payment authorization; an offline attempt is not confirmed bank or UPI settlement.

**For agents:** a scoped credential and signed proof identify the requester. Rail
checks the owner's mandate, permitted recipient, currency and shared allowance,
with exact passkey approval where required. Internal wallet transfers use the
transaction engine; provider proposals require exact owner approval and a separate
signed execution request. That provider path currently runs against a local
simulator, not a real bank or payment provider.

## Our Approach

- **Authority stays with the owner.** Scoped credentials, merchant restrictions,
  shared budgets and passkey approvals are enforced outside the AI model.
- **Approval binds the actual payment.** Frozen terms and request fingerprints prevent
  an approved amount, recipient or funding reference from being silently substituted.
- **Failures must not invent financial outcomes.** Internal transfers commit atomically;
  uncertain simulated provider submissions retain their holds and are reconciled
  against the original operation rather than blindly submitted again.

Rail builds on existing payment infrastructure; it does not claim to invent agent
payments or replace banks, UPI or card networks.

```mermaid
flowchart LR
    Owner[Owner permissions and approvals] --> Checks[Agent identity, terms and allowance checks]
    Agent[Signed agent request] --> Checks
    Human[Human or offline-token request] --> HumanChecks[Human and offline authorization checks]
    HumanChecks --> Internal[Atomic internal wallet transfer]
    Checks --> Internal[Atomic internal wallet transfer]
    Checks --> Approved[Owner-approved provider proposal]
    Approved --> Queue[Durable execution queue]
    Queue --> Simulator[Local provider simulator]
    Simulator --> Outcome[Reconcile outcome and allowance]
```

## What Works Today

| Area | Current Scope |
| --- | --- |
| Internal execution | PostgreSQL transactions coordinate wallet balances, ledger entries, replay results and protected evidence |
| Provider execution | Opt-in local simulator with durable jobs, lease-fenced outcomes and crash/reply-loss recovery |
| Still ahead | Real provider sandbox, authenticated callbacks and protected external outcome receipts |

**An internal ledger entry or simulated success is not bank, card or UPI settlement.**
ML remains advisory/shadow evaluation; audit commitments do not establish on-chain
settlement. Unknown simulated outcomes may remain held pending investigation.

## Local Setup

Use Node.js 22 or 24, npm, and a disposable PostgreSQL 16+ development database.
Do not point demos or tests at live funds.

```sh
npm ci
docker compose up -d postgres
export DATABASE_URL=postgresql://rail:rail_dev_password@localhost:5432/rail
export RAIL_SIGNING_SECRET="$(openssl rand -hex 32)"
npm run migrate
npm test
```

Compose credentials are development defaults. Database tests need `DATABASE_URL`;
skipped integration tests are not acceptance evidence. `npm test` builds the code.
For server secrets, key rings, origins and passkeys, follow the
[deployment guide](docs/DEPLOYMENT.md). `.env_example` contains placeholders.

## Try The Flow

Run a self-cleaning internal-wallet example in an isolated temporary schema:

```sh
RAIL_DEMO_MODE=true npm run demo
```

The [three-agent walkthrough](docs/AGENT_SIMULATORS.md) demonstrates shared-budget
contention and replay. The [provider lifecycle guide](docs/PROVIDER_PAYMENTS.md)
explains simulator queueing, crash recovery and its deliberate safety limits.
The opt-in [owner console](docs/OWNER_CONSOLE.md) uses real APIs and passkey
ceremonies at `/demo/owner` outside production.

## Verification And Documentation

Node 22/24 CI jobs publish full-suite results, duration and informational coverage.
TAP, JUnit, LCOV and JSON artifacts are retained for 14 days. Coverage describes
observed compiled modules, not production readiness or real-provider acceptance.

- [CI workflow and published runs](https://github.com/InsaneCoder789/Rail/actions/workflows/ci.yml)
- [Detailed technical overview](docs/README.md)
- [Living project report](docs/PROJECT_STATUS_REPORT.md)
- [Agent proof-of-possession contract](docs/AGENT_PROOF_OF_POSSESSION.md)
- [Shared budget controls](docs/SHARED_BUDGETS.md)
- [Security review and remaining risks](docs/SECURITY_REVIEW.md)

Rail is a student-built engineering project, not a licensed settlement service
or a production security certification.

## License

[GNU AGPL-3.0-only](LICENSE). Collaboration and use are subject to that license;
the license covers the code, not exclusive ownership of a payment-system idea.
