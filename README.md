# Rail

**Owner-controlled payment execution for AI agents and people.**

Rail lets an owner delegate limited payment authority without handing an agent
unrestricted access to money. Agents make requests; the backend checks their
identity, mandate, recipient, currency, shared allowance and any required exact
owner approval before executing an internal wallet transfer. People and the
existing offline-token flow use the same financial consistency foundations.

The important distinction: **a committed Rail wallet transfer is internal accounting
success, not confirmation of bank, card, UPI or payment-provider settlement.**
The external-provider lifecycle is being built; no real sandbox integration or
production deployment is claimed. ML remains advisory/shadow evaluation, and
audit commitments are not proof of on-chain settlement.

```mermaid
flowchart LR
    Owner[Owner: session and passkey controls] --> Policy[Mandates and shared budgets]
    Human[Human or offline-token request] --> API[Authenticated API]
    Agent[Agent: scoped token and signed proof] --> API
    Policy --> API
    API --> Checks[Binding, approval, risk and funds checks]
    Checks --> DB[(PostgreSQL transaction)]
    DB --> Ledger[Wallets and balanced ledger]
    DB --> Replay[Idempotent result and protected evidence]
    DB --> Events[Transactional outbox]
```

## Local Setup

Use Node.js 22 or 24, npm, and a disposable PostgreSQL 16+ development database.
Run commands from this repository's root. Do not point demos or tests at live funds.

```sh
npm ci
docker compose up -d postgres
export DATABASE_URL=postgresql://rail:rail_dev_password@localhost:5432/rail
export RAIL_SIGNING_SECRET="$(openssl rand -hex 32)"
npm run migrate
npm test
```

The Compose credentials are local development defaults only. If port 5432 is
already occupied, use a separate local database or adjust the Compose port and
connection URL together. Database integration tests need `DATABASE_URL`; skipped
database tests are not acceptance evidence. `npm test` builds the TypeScript code.

Starting the HTTP server needs additional independently generated evidence/risk
key rings, authentication secrets and allowed origins. Follow the
[configuration and migration guide](docs/DEPLOYMENT.md) rather than treating the
placeholder `.env_example` as working credentials. Agents additionally need
owner passkeys, an authority key ring and a canonical proof API origin.

## See The Failure-Safety Mechanism

For a self-cleaning internal-wallet example using an isolated temporary schema:

```sh
RAIL_DEMO_MODE=true npm run demo
```

This executes and replays one synthetic transfer, checks that the results match,
reconciles wallet totals, and removes only the schema it created. It is not a
live payment or a measured throughput benchmark.

The [three-agent walkthrough](docs/AGENT_SIMULATORS.md) covers shared-budget
contention, exact owner approval and retrying original payment identities.
Its HTTP/PostgreSQL acceptance case deliberately discards an execution reply
after commit, inspects the original intent and replays it without extra ledger
effects. Changed-payload retries must be rejected rather than interpreted as
the original purchase. The simulator's TTL mismatch has been corrected. On
16 October 2026, the direct local backend regression and all three Chromium
journeys passed; the dependency audit found no known vulnerabilities and the
disposable database was removed. The host used Node 20.19.6; the published CI
matrix targets Node 22/24. Do not interpret these local results or the CI link
as a claim that uncommitted changes have passed remotely.

The opt-in [owner console](docs/OWNER_CONSOLE.md) is served by this backend at
`/demo/owner` outside production. It uses real APIs and passkey ceremonies, not
fake balances. Native browser verification uses an isolated database and Chromium:

```sh
npx playwright install chromium
npm run test:browser
```

## Documentation And Evidence

- [CI workflow and published runs](https://github.com/InsaneCoder789/Rail/actions/workflows/ci.yml)
- [Detailed project README](docs/README.md)
- [Living project report and acceptance boundaries](docs/PROJECT_STATUS_REPORT.md)
- [Agent proof-of-possession contract](docs/AGENT_PROOF_OF_POSSESSION.md)
- [Shared budget controls](docs/SHARED_BUDGETS.md)
- [Provider lifecycle and unfinished integration](docs/PROVIDER_PAYMENTS.md)
- [Security review and remaining risks](docs/SECURITY_REVIEW.md)

Rail is a student-built payment-governance prototype, not a licensed settlement
rail or a production security certification. There are no claimed customer,
volume, uptime or ML-accuracy metrics without measured evidence.

## License

[GNU AGPL-3.0-only](LICENSE). Collaboration and use are subject to that license;
the license covers the code, not exclusive ownership of a payment-system idea.
