import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { signAuthorization, verifyAuthorization } from "../dist/crypto/authorizationSigning.js";
import { signTransactionHmac, verifyTransactionHmac } from "../dist/crypto/transactionSigning.js";
import { OfflineTokenStore } from "../dist/rail/offlineTokenStore.js";
import { PipelineError } from "../dist/pipeline/errors.js";
import { withRetry } from "../dist/pipeline/retry.js";
import { applyCors, getClientIp } from "../dist/server/http.js";

dotenv.config();

const secret = "hardening_test_secret_012345678901234567890";
const transaction = {
  txId: "tx_harden_001",
  idempotencyKey: "idem_harden_001",
  senderWalletId: "wallet_sender",
  receiverWalletId: "wallet_receiver",
  amountMinor: 2500,
  currency: "INR",
  channel: "online",
  createdAt: new Date().toISOString(),
};

test("rejects tampered authorization signatures", () => {
  const unsigned = {
    authId: "auth_harden_001",
    txId: transaction.txId,
    senderWalletId: transaction.senderWalletId,
    receiverWalletId: transaction.receiverWalletId,
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    createdAt: transaction.createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const authorization = { ...unsigned, signature: signAuthorization(unsigned, secret) };
  assert.equal(verifyAuthorization(authorization, secret), true);
  assert.equal(verifyAuthorization({ ...authorization, amountMinor: 2501 }, secret), false);
});

test("rejects tampered transaction HMACs", () => {
  const signature = signTransactionHmac(transaction, secret);
  assert.equal(verifyTransactionHmac(transaction, signature, secret), true);
  assert.equal(verifyTransactionHmac({ ...transaction, amountMinor: 2501 }, signature, secret), false);
});

test("enforces offline token device binding and restores rolled-back headroom", async () => {
  const store = new OfflineTokenStore();
  const token = await store.issue({ walletId: "wallet_sender", deviceId: "device_a", amountCapMinor: 5000 });
  const offlineTransaction = {
    ...transaction,
    txId: "tx_harden_002",
    idempotencyKey: "idem_harden_002",
    amountMinor: 3000,
    channel: "nfc",
    offlineTokenId: token.tokenId,
    deviceId: "device_a",
  };
  assert.deepEqual(await store.beginOfflineSpend(offlineTransaction), { ok: true });
  assert.deepEqual(await store.beginOfflineSpend({ ...offlineTransaction, deviceId: "device_b" }), {
    ok: false,
    reason: "device_mismatch",
  });
  await store.rollbackOfflineSpend(offlineTransaction);
  assert.equal((await store.getToken(token.tokenId)).remainingMinor, 5000);
});

test("does not expose mutable offline token state", async () => {
  const store = new OfflineTokenStore();
  const token = await store.issue({ walletId: "wallet_sender", deviceId: "device_a", amountCapMinor: 5000 });
  token.remainingMinor = 0;
  token.walletId = "attacker_wallet";

  const stored = await store.getToken(token.tokenId);
  assert.equal(stored?.remainingMinor, 5000);
  assert.equal(stored?.walletId, "wallet_sender");

  stored.remainingMinor = 1;
  assert.equal((await store.getToken(token.tokenId)).remainingMinor, 5000);
});

test("uses trusted proxy headers only when explicitly enabled", () => {
  const request = { headers: { "x-forwarded-for": "203.0.113.10" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(getClientIp(request), "127.0.0.1");
  assert.equal(getClientIp(request, true), "203.0.113.10");
});

test("applies CORS only to configured origins", () => {
  const headers = new Map();
  const response = { setHeader(name, value) { headers.set(name, value); } };
  applyCors({ headers: { origin: "https://allowed.example" } }, response, ["https://allowed.example"]);
  assert.equal(headers.get("Access-Control-Allow-Origin"), "https://allowed.example");

  const blockedHeaders = new Map();
  applyCors({ headers: { origin: "https://blocked.example" } }, { setHeader(name, value) { blockedHeaders.set(name, value); } }, ["https://allowed.example"]);
  assert.equal(blockedHeaders.has("Access-Control-Allow-Origin"), false);
});

test("retries retryable failures and stops on terminal failures", async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new PipelineError("temporary", "TEMPORARY", true);
      return "accepted";
    },
    { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    new AbortController().signal,
  );
  assert.equal(result, "accepted");
  assert.equal(attempts, 3);

  await assert.rejects(
    withRetry(async () => { throw new PipelineError("terminal", "TERMINAL", false); }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }, new AbortController().signal),
    { code: "TERMINAL" },
  );
});
