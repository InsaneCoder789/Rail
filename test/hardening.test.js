import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { signAuthorization, verifyAuthorization } from "../dist/crypto/authorizationSigning.js";
import { signTransactionHmac, verifyTransactionHmac, canonicalTransactionPayload } from "../dist/crypto/transactionSigning.js";
import { OfflineTokenStore } from "../dist/rail/offlineTokenStore.js";
import { PipelineError } from "../dist/pipeline/errors.js";
import { withRetry } from "../dist/pipeline/retry.js";
import { applyCors, getClientIp, toErrorResponse } from "../dist/server/http.js";

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

test("canonical signing prevents delimiter collisions and binds authorization references", () => {
  const left = { ...transaction, txId: "tx_example|tail", idempotencyKey: "idem_example", authorizationId: "auth_one" };
  const right = { ...left, txId: "tx_example", idempotencyKey: "tail|idem_example" };
  assert.notEqual(canonicalTransactionPayload(left), canonicalTransactionPayload(right));
  const signature = signTransactionHmac(left, secret);
  assert.equal(verifyTransactionHmac(right, signature, secret), false);
  assert.equal(verifyTransactionHmac({ ...left, authorizationId: "auth_two" }, signature, secret), false);
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

test("offline store validates issuance caps, lifetimes and bindings", async () => {
  const store = new OfflineTokenStore();
  const input = { walletId: "wallet_sender", deviceId: "device_a", amountCapMinor: 5000 };
  for (const amountCapMinor of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(store.issue({ ...input, amountCapMinor }), /invalid_amount_cap/);
  }
  for (const ttlSeconds of [0, -1, 1.5, Infinity, 2592001]) {
    await assert.rejects(store.issue({ ...input, ttlSeconds }), /invalid_token_ttl/);
  }
  await assert.rejects(store.issue({ ...input, currency: "invalid" }), /invalid_currency/);
  await assert.rejects(store.issue({ ...input, deviceId: "device\nspoof" }), /invalid_token_binding/);
});

test("offline reservations are idempotent and refunds require a matching reserved spend", async () => {
  const store = new OfflineTokenStore();
  const token = await store.issue({ walletId: "wallet_sender", deviceId: "device_a", amountCapMinor: 5000 });
  const txn = { ...transaction, channel: "nfc", offlineTokenId: token.tokenId, deviceId: "device_a" };
  assert.deepEqual(await store.beginOfflineSpend({ ...txn, txId: undefined }), { ok: false, reason: "invalid_transaction" });
  for (const amountMinor of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(await store.beginOfflineSpend({ ...txn, amountMinor }), { ok: false, reason: "invalid_amount" });
  }
  await store.rollbackOfflineSpend(txn);
  await store.beginOfflineSpend(txn);
  await store.beginOfflineSpend(txn);
  assert.equal((await store.getToken(token.tokenId)).remainingMinor, 2500);
  assert.deepEqual(await store.beginOfflineSpend({ ...txn, amountMinor: 1 }), { ok: false, reason: "offline_spend_mismatch" });
  await assert.rejects(store.rollbackOfflineSpend({ ...txn, deviceId: "device_b" }), /offline_spend_mismatch/);
  await store.rollbackOfflineSpend(txn);
  await store.rollbackOfflineSpend(txn);
  assert.equal((await store.getToken(token.tokenId)).remainingMinor, 5000);
  await store.beginOfflineSpend(txn);
  await store.finalizeOfflineSpend(txn);
  await store.rollbackOfflineSpend(txn);
  await store.beginOfflineSpend(txn);
  assert.equal((await store.getToken(token.tokenId)).remainingMinor, 2500);
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

test("missing accounting baselines return a safe review-required response", () => {
  const error = Object.assign(new Error("accounting_baseline_required"), { code: "23514" });
  assert.deepEqual(toErrorResponse(error, false), { status: 503, body: { error: "accounting_review_required" } });
  assert.deepEqual(toErrorResponse(new Error("accounting_baseline_required"), false), { status: 500, body: { error: "internal_error" } });
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
