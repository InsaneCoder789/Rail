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

## Architecture (high level)

```
┌─────────────┐     online      ┌──────────────────────────────────────┐
│ Mobile / POS│ ───────────────►│ Rail HTTP API                         │
│ (Flutter /   │                 │  • POST /v1/offline/tokens/issue      │
│  Android)    │                 │  • POST /v1/payments/execute          │
└─────────────┘                 │  • POST /v1/sync/transactions        │
       │                          │                                       │
       │ offline QR/NFC/BLE       │  ┌─────────────────────────────────┐ │
       │ (token-bound payloads)   │  │ Pipeline: validate → parallel   │ │
       ▼                          │  │ checks → saga (offline reserve,   │ │
┌─────────────┐                   │  │ wallet, ledger) → outbox          │ │
│ Local queue │ ── sync when ────►│  └─────────────────────────────────┘ │
│ (encrypted) │     online        │              │                         │
└─────────────┘                   │              ▼                         │
                                  │     PostgreSQL (optional)             │
                                  │     • rail_idempotency                │
                                  │     • rail_offline_tokens             │
                                  └──────────────────────────────────────┘
```

**Settlement** (money movement on bank/UPI rails) is **out of scope** for this repository; your PSP or bank integration consumes outbox/webhook events or mirrors the ledger in your core banking system.

---

## Features

| Area | Behavior |
|------|----------|
| **Offline tokens** | Capped, expiring, device-bound envelopes (`POST /v1/offline/tokens/issue`). |
| **Pipeline** | Validation, parallel risk + crypto hooks, **saga** with compensate on failure. |
| **Idempotency** | Memory (dev) or **PostgreSQL** with `pg_advisory_lock` per key. |
| **Sync API** | FIFO batch replay for queued offline transactions. |
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
| `RAIL_API_KEY` | Shared secret; required header **`X-RAIL-API-KEY`** on mutating routes when set. |
| `KYLR_API_KEY` | **Legacy** alias read if `RAIL_API_KEY` is unset. |
| `RAIL_SIGNING_SECRET` | Secret for **HMAC-SHA256** verification of `paymentSignature`. |
| `RAIL_REQUIRE_TX_SIGNATURE` | If `true`, every `execute` / sync item **must** include valid `paymentSignature`. |
| `RAIL_PKCS11_MODULE_PATH` | Documented hook for PKCS#11 HSM (see `src/crypto/hsm.ts`). |
| `RAIL_KMS_KEY_ID` | Documented hook for cloud KMS signing. |

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

**Body:** `PaymentTransaction` — required fields include `txId`, `idempotencyKey`, `senderWalletId`, `receiverWalletId`, `amountMinor`, `currency`, `channel` (`nfc` | `ble` | `qr` | `online`), `createdAt`.  
For offline channels, include `offlineTokenId` (and recommended `deviceId`).  
Optional `paymentSignature` (base64 HMAC) when `RAIL_REQUIRE_TX_SIGNATURE=true`.

### `POST /v1/sync/transactions`

Replay a **batch** of queued offline transactions (FIFO).

**Body:**

```json
{
  "deviceId": "device_pixel_9",
  "transactions": [ { ...PaymentTransaction }, { ... } ]
}
```

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
