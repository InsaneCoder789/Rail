import test from "node:test";
import assert from "node:assert/strict";
import { isPaymentTransaction, isValidAmountMinor } from "../dist/server/validation.js";

test("rejects unsafe or invalid transaction amounts", () => {
  assert.equal(isValidAmountMinor(0), false);
  assert.equal(isValidAmountMinor(-1), false);
  assert.equal(isValidAmountMinor(Number.MAX_SAFE_INTEGER), false);
  assert.equal(isValidAmountMinor(2500), true);
});

test("requires device-bound token data for offline transactions", () => {
  const transaction = {
    txId: "tx_test_001",
    idempotencyKey: "idem_test_001",
    senderWalletId: "wallet_a",
    receiverWalletId: "wallet_b",
    amountMinor: 2500,
    currency: "INR",
    channel: "nfc",
    createdAt: new Date().toISOString(),
  };

  assert.equal(isPaymentTransaction(transaction), false);
  assert.equal(isPaymentTransaction({
    ...transaction,
    offlineTokenId: "otk_test_001",
    deviceId: "device_a",
  }), true);
});
