# Rail

**Rail** is an **offline-capable payment orchestration service**: it issues **spend tokens** while the client is online, validates **offline channel** payments (NFC / BLE / QR) against those tokens, runs an **idempotent execution pipeline** (risk, saga, ledger events, outbox), and accepts **batched sync** when devices reconnect. It is designed to sit **next to** bank / UPI / PSP systems—Rail does **not** replace NPCI or licensed settlement rails; it coordinates **authorization headroom**, **audit**, and **replay-safe** processing.


<img width="1774" height="887" alt="image" src="https://github.com/user-attachments/assets/c9401ae1-30cf-446b-99cf-873ec81a5cf1" />




**Repository:** [github.com/InsaneCoder789/Rail](https://github.com/InsaneCoder789/Rail)


---

## Why Rail exists

- **Offline-first UX:** Payers and payees can exchange payment intents without continuous internet; the device **queues** signed or token-bound payloads and **syncs** later.
- **No double-spend of headroom:** Server-issued **offline tokens** cap spend, expire, and bind to **wallet + device** (configurable).
- **Exactly-once semantics (logical):** **Idempotency keys** deduplicate retries; PostgreSQL mode uses **advisory locks** + durable rows.
- **Operational clarity:** Structured **outbox events** (e.g. `payments.ledger_posted`) feed Kafka/webhooks in a full deployment.

---

## Architecture (Real Time Analysis)

> This diagram shows the full Rail execution architecture — from API entry to pipeline orchestration, storage, and security layers. It is intentionally expanded for clarity.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 60, "rankSpacing": 80}} }%%
flowchart LR

subgraph group_runtime["Runtime & API"]
  node_src_index["Entry<br/>bootstrap<br/>[index.ts]"]
  node_src_server_serve["HTTP Server<br/>api server<br/>[serve.ts]"]
end

subgraph group_core["Core Flow"]
  node_domain_model["Payment Txn<br/>domain model<br/>[types.ts]"]
  node_domain_authz["Authorization<br/>domain model<br/>[authorization.ts]"]
  node_payment_pipeline["Payment Flow<br/>stage composition<br/>[paymentPipeline.ts]"]
  node_authorization_stage["Auth Stage<br/>pipeline stage"]
  node_sync_batch["Sync Batch<br/>replay flow<br/>[syncBatch.ts]"]
  node_offline_tokens[("Token Store<br/>offline headroom")]
end

subgraph group_platform["Pipeline & Storage"]
  node_pipeline_engine["Engine<br/>pipeline runtime<br/>[engine.ts]"]
  node_pipeline_middle["Middleware<br/>pipeline infra<br/>[middleware.ts]"]
  node_pipeline_saga["Saga<br/>workflow coordination<br/>[saga.ts]"]
  node_pipeline_outbox["Outbox<br/>event delivery<br/>[outbox.ts]"]
  node_pipeline_resilience["Resilience<br/>infra bundle<br/>[backpressure.ts]"]
  node_pipeline_idem["Idempotency<br/>dedupe<br/>[idempotency.ts]"]
  node_pipeline_errors["Errors<br/>error model<br/>[errors.ts]"]
  node_persist_pool[("Postgres Pool<br/>db access<br/>[postgresPool.ts]")]
  node_persist_stores[("Postgres Stores<br/>durable stores")]
  node_wallet_store[("Wallet Store<br/>store abstraction<br/>[walletStore.ts]")]
end

subgraph group_security["Security"]
  node_tx_signing{{"Tx Signing<br/>integrity crypto"}}
  node_authz_signing{{"Auth Signing<br/>integrity crypto"}}
  node_hsm_hooks{{"HSM Hooks<br/>kms integration<br/>[hsm.ts]"}}
  node_mutex["Mutex<br/>concurrency control<br/>[mutex.ts]"]
end

node_src_index -->|"starts"| node_src_server_serve
node_src_server_serve -->|"routes"| node_payment_pipeline
node_src_server_serve -->|"uses"| node_authorization_stage
node_src_server_serve -->|"accepts"| node_sync_batch
node_src_server_serve -->|"issues"| node_offline_tokens
node_src_server_serve -->|"configures"| node_persist_pool
node_payment_pipeline -->|"composes"| node_pipeline_engine
node_payment_pipeline -->|"uses"| node_pipeline_middle
node_payment_pipeline -->|"orchestrates"| node_pipeline_saga
node_payment_pipeline -->|"emits"| node_pipeline_outbox
node_payment_pipeline -->|"relies on"| node_pipeline_resilience
node_payment_pipeline -->|"dedupes"| node_pipeline_idem
node_payment_pipeline -->|"signals"| node_pipeline_errors
node_authorization_stage -->|"models"| node_domain_authz
node_authorization_stage -->|"verifies"| node_authz_signing
node_sync_batch -->|"serializes"| node_mutex
node_sync_batch -->|"reuses"| node_pipeline_idem
node_offline_tokens -->|"persists"| node_persist_stores
node_offline_tokens -->|"binds"| node_domain_model
node_persist_stores -->|"uses"| node_persist_pool
node_persist_stores -->|"implements"| node_wallet_store
node_persist_stores -->|"backs"| node_pipeline_idem
node_domain_model -->|"protected by"| node_tx_signing
node_domain_model -->|"integrates"| node_hsm_hooks
node_authz_signing -->|"integrates"| node_hsm_hooks
node_mutex -->|"coordinates"| node_pipeline_idem

classDef toneNeutral fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a
classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554
classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f
classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d
classDef toneRose fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337
class node_src_index,node_src_server_serve toneBlue
class node_domain_model,node_domain_authz,node_payment_pipeline,node_authorization_stage,node_sync_batch,node_offline_tokens toneAmber
class node_pipeline_engine,node_pipeline_middle,node_pipeline_saga,node_pipeline_outbox,node_pipeline_resilience,node_pipeline_idem,node_pipeline_errors,node_persist_pool,node_persist_stores,node_wallet_store toneMint
class node_tx_signing,node_authz_signing,node_hsm_hooks,node_mutex toneRose
```

---

## Runtime Pipeline & Observability 

> This diagram represents the live execution flow — including SSE streaming, pipeline stages, error propagation, and the frontend dashboard visualization.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 50, "rankSpacing": 70}} }%%
flowchart LR

subgraph backend["Backend Execution"]
  A["HTTP Request\n/payment/execute"]
  B["Pipeline Engine\n(validate → risk → wallet → ledger)"]
  C["Outbox Events\npipeline.stage / errors"]
  D["SSE Stream\n/v1/events/stream"]
end

subgraph frontend["Dashboard UI"]
  E["Event Listener\n(EventSource)"]
  F["State Engine\n(progressMap + sequence)"]
  G["Pipeline UI\n(animated nodes + flow)"]
  H["Logs Panel\n(rail logs)"]
  I["Fault Buffer\n(system errors)"]
end

subgraph dataflow["Event Types"]
  T1["pipeline.stage"]
  T2["pipeline.error"]
  T3["system.error"]
  T4["payments.ledger_posted"]
end

A --> B
B --> C
C --> D
D --> E

E --> F
F --> G
F --> H
F --> I

C --> T1
C --> T2
C --> T3
C --> T4

T1 --> F
T2 --> I
T3 --> I
T4 --> H

classDef backend fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
classDef frontend fill:#f0fdf4,stroke:#16a34a,color:#14532d
classDef dataflow fill:#fef3c7,stroke:#d97706,color:#78350f

class A,B,C,D backend
class E,F,G,H,I frontend
class T1,T2,T3,T4 dataflow
```

---

**Settlement** (money movement on bank/UPI rails) is **out of scope** for this repository; your PSP or bank integration consumes outbox/webhook events or mirrors the ledger in your core banking system.

---

## Features

| Area | Behavior |
|------|----------|
| **Offline tokens** | Capped, expiring, device-bound envelopes (`POST /v1/offline/tokens/issue`). |
| **Pipeline** | Validation, parallel risk + crypto hooks, **saga** with compensate on failure. |
| **Idempotency** | Memory (dev) or **PostgreSQL** with `pg_advisory_lock` per key. |
| **Sync API** | FIFO batch replay for queued offline transactions that carry stored `authorizationId` references. |
| **Integrity (optional)** | HMAC over a **canonical payload** (`paymentSignature`); production path documented for **HSM / KMS** (`src/crypto/hsm.ts`). |

---

## Requirements

- **Node.js** ≥ 20  
- **npm**  
- **PostgreSQL** ≥ 14 (optional; required for durable production mode)  
- **Docker** (optional, for local Postgres via `docker-compose.yml`)

---

## Quick start (development)

### 1. Clone and install

```bash
git clone https://github.com/InsaneCoder789/Rail.git
cd Rail
npm install
```

### 2. Run without Postgres (fastest)

Uses **in-memory** idempotency and offline tokens (single process only).

```bash
npm run serve
```

Health check:

```bash
curl -s http://127.0.0.1:8787/health
```

Example response:

```json
{
  "ok": true,
  "service": "rail",
  "persistence": "memory",
  "offline": {
    "tokenIssue": "POST /v1/offline/tokens/issue",
    "execute": "POST /v1/payments/execute",
    "sync": "POST /v1/sync/transactions"
  }
}
```

### 3. Run with PostgreSQL (recommended)

Start Postgres:

```bash
docker compose up -d
```

Connection string (default from `docker-compose.yml`):

```bash
export DATABASE_URL='postgres://rail:rail_dev_password@127.0.0.1:5432/rail'
npm run serve
```

On startup, Rail runs **migrations** (`src/persistence/migrate.ts`) and creates:

- **`rail_idempotency`** — completed/failed idempotent results + JSON payload.  
- **`rail_offline_tokens`** — issued tokens, remaining headroom, expiry.

`GET /health` will report `"persistence": "postgresql"`.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default `8787`). |
| `DATABASE_URL` | If set, enables **PostgreSQL** idempotency + offline token store. |
| `RAIL_API_KEY` | Shared secret for offline-token and sync routes. Those routes now fail closed when it is unset. |
| `KYLR_API_KEY` | **Legacy** alias read if `RAIL_API_KEY` is unset. |
| `JWT_SECRET` | Secret for login JWT issuance and verification. If unset, Rail falls back to `RAIL_SIGNING_SECRET` for backward compatibility, but a dedicated secret is recommended. |
| `RAIL_SIGNING_SECRET` | Secret for **HMAC-SHA256** verification of `paymentSignature`. |
| `RAIL_REQUIRE_TX_SIGNATURE` | If `true`, every `execute` / sync item **must** include valid `paymentSignature`. |
| `RAIL_PKCS11_MODULE_PATH` | Documented hook for PKCS#11 HSM (see `src/crypto/hsm.ts`). |
| `RAIL_KMS_KEY_ID` | Documented hook for cloud KMS signing. |
| `RAIL_RATE_LIMIT_LOGIN_MAX` | Max login attempts per IP+user in the login window. Default `5`. |
| `RAIL_RATE_LIMIT_AUTHORIZE_MAX` | Max authorization requests per IP+wallet per minute. Default `12`. |
| `RAIL_RATE_LIMIT_EXECUTE_MAX` | Max execute requests per IP+wallet per minute. Default `20`. |
| `RAIL_RATE_LIMIT_SYNC_MAX` | Max sync requests per IP+device per 10 minutes. Default `6`. |
| `RAIL_RATE_LIMIT_TOKEN_ISSUE_MAX` | Max offline-token issuance requests per IP+wallet+device per 10 minutes. Default `6`. |

**Production checklist:** TLS termination (reverse proxy), strong `RAIL_API_KEY`, managed Postgres, **no** cleartext credentials, rotate `RAIL_SIGNING_SECRET`, rate limiting, and fraud monitoring outside this repo.

---

## HTTP API

All `POST` routes accept optional authentication via **`X-RAIL-API-KEY`** when `RAIL_API_KEY` is set.

### `GET /health`

Liveness + offline route index + persistence mode.

### `POST /v1/offline/tokens/issue`

Issue spend headroom while **online**.

**Body (JSON):**

```json
{
  "walletId": "wallet_user_1",
  "deviceId": "device_pixel_9",
  "amountCapMinor": 50000,
  "currency": "INR",
  "ttlSeconds": 345600
}
```

**Response:** `token.tokenId`, `remainingMinor`, `expiresAtMs`, etc.

### `POST /v1/payments/execute`

Execute one payment through the pipeline.

**Body:** `PaymentTransaction` — required fields include `txId`, `idempotencyKey`, `authorizationId`, `senderWalletId`, `receiverWalletId`, `amountMinor`, `currency`, `channel` (`nfc` | `ble` | `qr` | `online`), `createdAt`.  
For offline channels, include `offlineTokenId` and `deviceId`.  
`authorizationId` must reference a stored server-issued authorization whose amount, sender, receiver, and currency match the transaction.
Optional `paymentSignature` (base64 HMAC) when `RAIL_REQUIRE_TX_SIGNATURE=true`.

### `POST /v1/sync/transactions`

Replay a **batch** of queued offline transactions (FIFO).

Rules:

- sync accepts offline transactions only
- every transaction must include `authorizationId`
- every transaction `deviceId` must match the outer sync `deviceId`
- each `authorizationId` must reference a stored server-issued authorization

**Body:**

```json
{
  "deviceId": "device_pixel_9",
  "transactions": [
    {
      "txId": "txn_offline_001",
      "idempotencyKey": "idem_offline_001",
      "authorizationId": "auth_123",
      "senderWalletId": "wallet_user_1",
      "receiverWalletId": "wallet_shop_1",
      "amountMinor": 2500,
      "currency": "INR",
      "channel": "qr",
      "offlineTokenId": "otk_123",
      "deviceId": "device_pixel_9",
      "createdAt": "2026-05-08T16:00:00.000Z"
    }
  ]
}
```

### `GET /v1/events`

Returns recent wallet-visible events for the authenticated caller.

- JWT callers only see events where their wallet appears as sender or receiver
- API-key callers are filtered to the wallet bound to that key
- `system.error` events are not exposed through the client event feed

### `GET /v1/events/stream`

Server-Sent Events stream for the authenticated caller.

- same wallet filtering rules as `GET /v1/events`
- frontend dashboards can authenticate with standard `Authorization: Bearer ...`
- browser `EventSource` clients may also use `?access_token=<jwt>` or `?api_key=<key>` when custom headers are unavailable

---

## Transaction signing (HMAC → HSM)

- **Canonical string** (`canonicalTransactionPayload` in `src/crypto/transactionSigning.ts`) concatenates stable fields with `|` separators.  
- **HMAC-SHA256**, base64-encoded, passed as **`paymentSignature`**.  
- **Development:** set `RAIL_SIGNING_SECRET` and optionally `RAIL_REQUIRE_TX_SIGNATURE=true`.  
- **Production:** replace the comparison step with **KMS sign/verify** or **PKCS#11** using the **same canonical bytes**—see `src/crypto/hsm.ts` and `resolveHsmMode()`.

**Important:** Never embed the server signing secret in mobile apps for **request** signing in production; use **device-bound keys attested** via your security architecture and verify server-side (this repo gives you the **hook** and **format**, not a full PKI).

---

## Android client (KYLR)

The KYLR app talks to Rail over HTTP. Configure **`local.properties`**:

```properties
rail.api.baseUrl=http://10.0.2.2:8787/
rail.api.key=your-secret
```

(`kylr.api.*` is still supported as a fallback.)  
The app sends **`X-RAIL-API-KEY`** (`RetrofitClient.kt`).

---

## Scripts

| Script | Command |
|--------|---------|
| Build | `npm run build` |
| Run API | `npm run serve` |
| Demo pipeline (flaky verifier) | `npm run demo` |

---

## Project layout (selected)

```
src/
  server/serve.ts          # HTTP entry; wires Postgres or memory stores
  persistence/             # Postgres pool, migrations, idempotency, offline tokens
  rail/                    # Offline token interface + memory impl, sync batch
  pipeline/                  # Engine, saga, idempotency interface, outbox, DLQ
  stages/paymentPipeline.ts  # Composed stages + offline saga steps
  crypto/                    # HMAC signing + HSM integration notes
```

---

## Pushing to GitHub

If this directory is already a git repo:

```bash
git remote add origin https://github.com/InsaneCoder789/Rail.git
git branch -M main
git push -u origin main
```

If the remote exists with unrelated history, resolve with a **force-with-lease** only if you intend to overwrite the empty GitHub repo (consult GitHub docs first).

---

## License

Specify your license in a `LICENSE` file (e.g. MIT, Apache-2.0) before publishing widely.

---

## Disclaimer

Rail is **infrastructure software**. It does **not** by itself satisfy NPCI, RBI, PCI-DSS, or bank certification. You are responsible for licensing, KYC/AML, settlement, reconciliation, and security audits for your jurisdiction and product.
