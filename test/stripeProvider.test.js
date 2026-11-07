import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { StripeTestProvider, loadStripeTestConfiguration } from "../dist/rail/stripeProvider.js";
import { createProviderPayment, advanceProviderPayment, providerPaymentConsentFingerprint } from "../dist/domain/providerPayment.js";
import { createProviderOutcomeReceipt } from "../dist/domain/providerReceipt.js";

const secretKey = `sk_test_${"a".repeat(32)}`, webhookSecret = `whsec_${"b".repeat(32)}`;
const sdk = new Stripe(secretKey);
function fixture() {
  const now = Date.now(), binding = { version: 1, operationId: randomUUID(), ownerWalletId: "stripe_owner", agentId: randomUUID(),
    intentId: randomUUID(), mandateId: randomUUID(), sharedBudgetId: randomUUID(), provider: "stripe",
    providerAccountRef: "acct_fixture", merchantRef: "acct_fixture", instrumentRef: "pm_fixture", amountMinor: 500,
    currency: "USD", requestFingerprint: "a".repeat(64), authorizationExpiresAt: new Date(now + 60000).toISOString() };
  const reserved = createProviderPayment(binding, now);
  const payment = advanceProviderPayment(reserved, { type: "begin_submission", idempotencyWindowMs: 86400000 }, now);
  const config = { secretKey, accountId: "acct_fixture", instruments: [{ ownerWalletId: "stripe_owner", paymentMethodId: "pm_fixture", customerId: "cus_fixture" }] };
  const state = { intent: { id: "pi_fixture", object: "payment_intent", livemode: false, amount: 500, amount_received: 500,
    amount_capturable: 0, currency: "usd", customer: "cus_fixture", payment_method: "pm_fixture", payment_method_types: ["card"],
    capture_method: "automatic", confirmation_method: "automatic", on_behalf_of: null, transfer_data: null, application_fee_amount: null,
    metadata: { rail_operation_id: binding.operationId, rail_fingerprint: payment.fingerprint }, status: "succeeded" },
    method: { id: "pm_fixture", object: "payment_method", livemode: false, type: "card", customer: "cus_fixture" },
    accountId: "acct_fixture", error: null, hasMore: false, list: null };
  const calls = [];
  const client = { accounts: { retrieve: async arg => { calls.push(["account", arg]); return { id: state.accountId }; } },
    paymentMethods: { retrieve: async id => { calls.push(["method", id]); return state.method; } },
    paymentIntents: {
      create: async (...args) => { calls.push(["create", ...args]); if (state.error) throw state.error; return state.intent; },
      retrieve: async id => { calls.push(["retrieve", id]); return state.intent; },
      list: async params => { calls.push(["list", params]); return { data: state.list ?? [state.intent], has_more: state.hasMore }; }
    }, webhooks: sdk.webhooks };
  return { config, reserved, payment, state, calls, client, provider: new StripeTestProvider(config, client) };
}

test("Stripe configuration rejects live keys, ambiguous instrument ownership and invalid references", () => {
  const { config, client } = fixture();
  for (const changes of [{ secretKey: secretKey.replace("test", "live") }, { secretKey: "key" }, { accountId: "https://evil.example" },
    { instruments: [] }, { instruments: [...config.instruments, ...config.instruments] },
    { instruments: [{ ...config.instruments[0], customerId: "wrong" }] }])
    assert.throws(() => new StripeTestProvider({ ...config, ...changes }, client), { message: "INVALID_STRIPE_TEST_CONFIGURATION" });
});

test("Stripe execution configuration is independently opt-in and production fails closed", () => {
  const { config } = fixture();
  assert.equal(loadStripeTestConfiguration({}), undefined);
  const env = { RAIL_STRIPE_TEST_PAYMENTS: "true", NODE_ENV: "test", RAIL_DEMO_MODE: "true", RAIL_STRIPE_SECRET_KEY: secretKey,
    RAIL_STRIPE_ACCOUNT_ID: config.accountId, RAIL_STRIPE_INSTRUMENTS: JSON.stringify(config.instruments) };
  assert.deepEqual(loadStripeTestConfiguration(env), config);
  for (const changed of [{ NODE_ENV: "production" }, { RAIL_DEMO_MODE: "false" }, { RAIL_STRIPE_SECRET_KEY: "sk_live_not_allowed" },
    { RAIL_STRIPE_INSTRUMENTS: "malformed" }, { RAIL_STRIPE_TEST_PAYMENTS: "yes" }])
    assert.throws(() => loadStripeTestConfiguration({ ...env, ...changed }), { message: "INVALID_STRIPE_TEST_EXECUTION_CONFIGURATION" });
});

test("Stripe test terms reject unsupported currency exponents and oversized amounts before I/O", async () => {
  const { payment, provider, calls } = fixture();
  for (const changed of [{ currency: "JPY" }, { amountMinor: 100000000 }]) {
    const initial = createProviderPayment({ ...payment.binding, ...changed }, Date.now());
    const submitting = advanceProviderPayment(initial, { type: "begin_submission", idempotencyWindowMs: 86400000 }, Date.now());
    await assert.rejects(provider.submit(submitting), { message: "STRIPE_PAYMENT_BINDING_MISMATCH" });
  }
  assert.equal(calls.length, 0);
});

test("Stripe protected outcome contracts bind API provenance and reject changed observation hashes", () => {
  const { payment, provider, state } = fixture(), observed = provider.normalize(payment, state.intent);
  const final = advanceProviderPayment(payment, { type: "provider_observed", observation: observed }, Date.now());
  const consent = { merchantWalletId: "merchant_wallet", challengeId: randomUUID(),
    consentFingerprint: providerPaymentConsentFingerprint(payment.binding, "merchant_wallet") };
  const receipt = createProviderOutcomeReceipt({ ...final, revision: 3, provenance: observed.provenance }, consent);
  assert.equal(receipt.version, 2); assert.equal(receipt.assurance, "server_observed_stripe_test_api");
  assert.throws(() => createProviderOutcomeReceipt({ ...final, revision: 3 }, consent));
  assert.throws(() => advanceProviderPayment(payment, { type: "provider_observed", observation: { ...observed,
    provenance: { ...observed.provenance, observationHash: "a".repeat(64) } } }, Date.now()));
});

test("Stripe submission uses frozen exact terms, saved-card ownership and one stable idempotency key", async () => {
  const { config, payment, calls, provider } = fixture();
  config.instruments[0].customerId = "cus_changed_after_construction";
  const outcome = await provider.submit(payment);
  assert.equal(outcome.status, "succeeded"); assert.equal(outcome.final, true);
  assert.deepEqual(calls[0], ["account", null]);
  assert.deepEqual(calls[1], ["method", "pm_fixture"]);
  assert.deepEqual(calls[2], ["create", { amount: 500, currency: "usd", customer: "cus_fixture", payment_method: "pm_fixture",
    confirm: true, off_session: true, allowed_payment_method_types: ["card"], capture_method: "automatic", confirmation_method: "automatic",
    metadata: { rail_operation_id: payment.binding.operationId, rail_fingerprint: payment.fingerprint } }, { idempotencyKey: payment.idempotencyKey }]);
  assert.deepEqual(Object.keys(outcome).sort(), ["operationId", "fingerprint", "provider", "providerAccountRef", "providerRef", "amountMinor", "currency", "status", "final", "provenance"].sort());
});

test("Stripe submission rejects unadmitted, altered and foreign-account bindings before writes", async () => {
  const { payment, reserved, calls, provider } = fixture();
  for (const invalid of [reserved, { ...payment, status: "unknown" }, { ...payment, firstSubmissionAtMs: null },
    { ...payment, providerRef: "pi_already_created" }, { ...payment, fingerprint: "b".repeat(64) },
    { ...payment, binding: { ...payment.binding, providerAccountRef: "acct_other" } },
    { ...payment, binding: { ...payment.binding, instrumentRef: "pm_other" } }]) await assert.rejects(provider.submit(invalid));
  assert.equal(calls.length, 0);
});

test("real Stripe SDK serializes the pinned API contract through an isolated in-process HTTP transport", async () => {
  const { config, payment, state } = fixture(), requests = [];
  const client = new Stripe(secretKey, { apiVersion: "2026-10-28.endive", maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, init) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: init.method, headers: new Headers(init.headers), body: String(init.body ?? "") });
      const data = path === "/v1/account" ? { object: "account", id: "acct_fixture" }
        : path === "/v1/payment_methods/pm_fixture" ? state.method : path === "/v1/payment_intents" ? state.intent : null;
      assert.ok(data, "unexpected SDK request");
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fixture" } });
    }) });
  assert.equal((await new StripeTestProvider(config, client).submit(payment)).status, "succeeded");
  assert.deepEqual(requests.map(request => request.path), ["/v1/account", "/v1/payment_methods/pm_fixture", "/v1/payment_intents"]);
  const request = requests[2], params = new URLSearchParams(request.body);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("Stripe-Version"), "2026-10-28.endive");
  assert.equal(request.headers.get("Idempotency-Key"), payment.idempotencyKey);
  assert.equal(params.get("allowed_payment_method_types[0]"), "card");
  assert.equal(params.get("metadata[rail_operation_id]"), payment.binding.operationId);
  assert.equal(params.get("amount"), "500");
});

test("Stripe account and instrument preflight fail closed before charge submission", async () => {
  const f = fixture(); f.state.accountId = "acct_other";
  await assert.rejects(f.provider.submit(f.payment), { message: "STRIPE_ACCOUNT_UNAVAILABLE" });
  assert.equal(f.calls.filter(call => call[0] === "create").length, 0);
  for (const changes of [{ livemode: true }, { customer: "cus_other" }, { id: "pm_other" }, { type: "bank_account" }]) {
    const { state, payment, provider, calls } = fixture(); Object.assign(state.method, changes);
    await assert.rejects(provider.submit(payment), { message: "STRIPE_INSTRUMENT_UNAVAILABLE" });
    assert.equal(calls.filter(call => call[0] === "create").length, 0);
  }
});

test("Stripe recoverable states retain liability instead of being normalized to terminal failure", () => {
  for (const [status, expected, final] of [["processing", "processing", false], ["requires_action", "requires_owner_action", false],
    ["requires_payment_method", "requires_owner_action", false], ["requires_confirmation", "requires_owner_action", false], ["canceled", "cancelled", true]]) {
    const { state, provider, payment } = fixture(); Object.assign(state.intent, { status, amount_received: 0 });
    if (status === "requires_payment_method") state.intent.payment_method = null;
    const value = provider.normalize(payment, state.intent);
    assert.equal(value.status, expected); assert.equal(value.final, final);
  }
});

test("Stripe observations reject mode, amount, currency, customer, instrument, metadata and routing substitution", () => {
  const changes = [{ livemode: true }, { amount: 501 }, { currency: "inr" }, { customer: "cus_other" }, { payment_method: "pm_other" },
    { metadata: {} }, { metadata: { rail_operation_id: randomUUID(), rail_fingerprint: "a".repeat(64) } },
    { capture_method: "manual" }, { confirmation_method: "manual" }, { payment_method_types: ["card", "link"] },
    { on_behalf_of: "acct_other" }, { transfer_data: { destination: "acct_other" } }, { application_fee_amount: 10 },
    { amount_capturable: 500 }, { object: "charge" }, { id: "not_an_intent" }];
  for (const change of changes) {
    const { provider, payment, state } = fixture();
    assert.throws(() => provider.normalize(payment, { ...state.intent, ...change }), { message: "STRIPE_OBSERVATION_MISMATCH" });
  }
});

test("Stripe success requires the full received amount; paid cancellation cannot release the hold", () => {
  const { provider, payment, state } = fixture();
  assert.throws(() => provider.normalize(payment, { ...state.intent, amount_received: 499 }));
  assert.throws(() => provider.normalize(payment, { ...state.intent, status: "canceled", amount_received: 1 }));
  assert.throws(() => provider.normalize(payment, { ...state.intent, status: "requires_capture" }));
  assert.throws(() => provider.normalize({ ...payment, providerRef: "pi_other" }, state.intent));
});

test("confirmed cancellation after a recoverable method failure can resolve without a retained method", () => {
  const { provider, payment, state } = fixture();
  const result = provider.normalize(payment, { ...state.intent, status: "canceled", amount_received: 0, payment_method: null });
  assert.equal(result.status, "cancelled"); assert.equal(result.final, true);
});

test("Stripe network errors are redacted and do not trigger another create request", async () => {
  const { provider, payment, state, calls } = fixture();
  state.error = new Error(`private_client_secret ${secretKey}`);
  await assert.rejects(provider.submit(payment), { message: "STRIPE_SUBMISSION_UNCERTAIN" });
  assert.equal(calls.filter(call => call[0] === "create").length, 1);
});

test("Stripe lookup with a known reference retrieves current state without mutation or live authority", async () => {
  const { provider, payment, state, calls } = fixture();
  const result = await provider.lookup({ ...payment, status: "unknown", providerRef: state.intent.id });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls.map(call => call[0]), ["account", "retrieve"]);
});

test("Stripe callback correlation returns a private API snapshot validator, not raw secrets or mutation authority", async () => {
  const { provider, payment, state, calls } = fixture(); state.intent.client_secret = "never_return_this";
  const snapshot = await provider.callbackSnapshot("pi_fixture");
  assert.deepEqual(Object.keys(snapshot).sort(), ["operationId", "fingerprint", "observe"].sort());
  assert.ok(!JSON.stringify(snapshot).includes("never_return_this"));
  assert.equal(snapshot.observe(payment).status, "succeeded");
  state.intent.metadata = {}; assert.equal(await provider.callbackSnapshot("pi_fixture"), null);
  state.intent.livemode = true;
  await assert.rejects(provider.callbackSnapshot("pi_fixture"), { message: "STRIPE_CALLBACK_LOOKUP_UNAVAILABLE" });
  assert.equal(calls.filter(call => call[0] === "create").length, 0);
});

test("Stripe lost-reference lookup correlates one exact operation; absence remains unresolved", async () => {
  const { provider, payment, state, calls } = fixture();
  assert.equal((await provider.lookup({ ...payment, status: "unknown" })).status, "succeeded");
  assert.equal(calls.find(call => call[0] === "list")[1].customer, "cus_fixture");
  assert.equal(calls.find(call => call[0] === "list")[1].limit, 100);
  state.list = []; assert.equal(await provider.lookup(payment), null);
  assert.equal(calls.filter(call => call[0] === "create").length, 0);
});

test("Stripe incomplete, ambiguous or mismatched lookup cannot resolve or release liability", async () => {
  for (const kind of ["incomplete", "duplicate", "fingerprint"]) {
    const { provider, payment, state } = fixture();
    if (kind === "incomplete") state.hasMore = true;
    if (kind === "duplicate") state.list = [state.intent, { ...state.intent, id: "pi_second" }];
    if (kind === "fingerprint") state.intent.metadata.rail_fingerprint = "b".repeat(64);
    await assert.rejects(provider.lookup(payment), { message: "STRIPE_LOOKUP_UNAVAILABLE" });
  }
});

function eventBody(changes = {}) {
  return Buffer.from(JSON.stringify({ id: "evt_fixture", object: "event", type: "payment_intent.succeeded", livemode: false,
    data: { object: { id: "pi_fixture", object: "payment_intent", client_secret: "not_returned" } }, ...changes }));
}
const signature = (body, timestamp = Math.floor(Date.now() / 1000)) => sdk.webhooks.generateTestHeaderString({ payload: body.toString(), secret: webhookSecret, timestamp });

test("Stripe SDK authenticates exact webhook bytes and returns only a retrieval candidate", () => {
  const { provider } = fixture(), body = eventBody(), value = provider.verifyWebhook(body, signature(body), webhookSecret);
  assert.deepEqual(Object.keys(value).sort(), ["eventId", "paymentIntentId", "bodyHash"].sort());
  assert.equal(value.eventId, "evt_fixture"); assert.equal(value.paymentIntentId, "pi_fixture");
  assert.ok(!JSON.stringify(value).includes("not_returned"));
  const unrelated = eventBody({ type: "customer.created" });
  assert.equal(provider.verifyWebhook(unrelated, signature(unrelated), webhookSecret), null);
});

test("Stripe webhook verification rejects tampered bytes, stale signatures, live and foreign-account events", () => {
  const { provider } = fixture(), body = eventBody();
  assert.throws(() => provider.verifyWebhook(Buffer.concat([body, Buffer.from(" ")]), signature(body), webhookSecret), { message: "INVALID_STRIPE_WEBHOOK" });
  assert.throws(() => provider.verifyWebhook(body, signature(body, Math.floor(Date.now() / 1000) - 301), webhookSecret));
  assert.throws(() => provider.verifyWebhook(body, signature(body, Math.floor(Date.now() / 1000) + 301), webhookSecret));
  for (const changes of [{ livemode: true }, { account: "acct_other" }, { id: "invalid" }, { data: { object: { id: "ch_fixture", object: "charge" } } }]) {
    const invalid = eventBody(changes);
    assert.throws(() => provider.verifyWebhook(invalid, signature(invalid), webhookSecret), { message: "INVALID_STRIPE_WEBHOOK" });
  }
  for (const [raw, sig, secret] of [[Buffer.alloc(262145), "sig", webhookSecret], [body, ["sig"], webhookSecret],
    [body, signature(body), "bad"], [body, signature(body), `whsec_${"c".repeat(32)}`]])
    assert.throws(() => provider.verifyWebhook(raw, sig, secret), { message: "INVALID_STRIPE_WEBHOOK" });
});
