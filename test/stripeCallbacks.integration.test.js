import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Stripe from "stripe";
import { runMigrations } from "../dist/persistence/migrate.js";
import { StripeCallbackInbox, loadStripeCallbackConfiguration } from "../dist/persistence/stripeCallbacks.js";
import { handleStripeRoutes } from "../dist/server/routes/stripeRoutes.js";
import { PostgresRateLimiter } from "../dist/persistence/postgresRateLimiter.js";

const databaseUrl = process.env.DATABASE_URL, options = { skip: !databaseUrl };
const configuration = { accountId: "acct_fixture", webhookSecret: `whsec_${"b".repeat(32)}` };
const body = (event = "evt_fixture", intent = "pi_fixture", changes = {}) => Buffer.from(JSON.stringify({ id: event, type: "payment_intent.succeeded",
  livemode: false, data: { object: { id: intent, object: "payment_intent", client_secret: "never_persist_this", amount: 99999 } }, ...changes }));
const signature = raw => Stripe.webhooks.generateTestHeaderString({ payload: raw.toString(), secret: configuration.webhookSecret });

async function fixture(work, capacity = 10000) {
  const schema = `ci_stripe_callback_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await runMigrations(pool);
    await work({ pool, inbox: new StripeCallbackInbox(pool, configuration, capacity) });
    assert.equal((await pool.query("SELECT count(*) FROM rail_provider_payments")).rows[0].count, "0");
    assert.equal((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count, "0");
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}

test("Stripe callback configuration is opt-in and requires non-production demo context and endpoint identity", () => {
  assert.equal(loadStripeCallbackConfiguration({}), undefined);
  assert.equal(loadStripeCallbackConfiguration({ RAIL_STRIPE_TEST_WEBHOOKS: "false" }), undefined);
  const env = { NODE_ENV: "test", RAIL_DEMO_MODE: "true", RAIL_STRIPE_TEST_WEBHOOKS: "true",
    RAIL_STRIPE_ACCOUNT_ID: configuration.accountId, RAIL_STRIPE_WEBHOOK_SECRET: configuration.webhookSecret };
  assert.deepEqual(loadStripeCallbackConfiguration(env), configuration);
  for (const change of [{ NODE_ENV: "production" }, { RAIL_DEMO_MODE: "false" }, { RAIL_STRIPE_TEST_WEBHOOKS: "yes" },
    { RAIL_STRIPE_ACCOUNT_ID: "wrong" }, { RAIL_STRIPE_WEBHOOK_SECRET: "missing" }])
    assert.throws(() => loadStripeCallbackConfiguration({ ...env, ...change }), { message: "INVALID_STRIPE_TEST_CALLBACK_CONFIGURATION" });
});

test("Stripe authenticated callback admission deduplicates parallel deliveries without retaining raw secrets", options, async () => {
  await fixture(async ({ pool, inbox }) => {
    const raw = body(), sig = signature(raw);
    const results = await Promise.all(Array.from({ length: 8 }, () => inbox.accept(raw, sig)));
    assert.equal(results.filter(value => !value.duplicate).length, 1);
    const rows = (await pool.query("SELECT * FROM rail_stripe_callback_inbox")).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].processed_at, null);
    assert.equal(rows[0].payment_intent_id, "pi_fixture");
    assert.ok(!JSON.stringify(rows).includes("never_persist_this"));
    const formatted = Buffer.from(`${raw.toString()}\n`);
    assert.equal((await inbox.accept(formatted, signature(formatted))).duplicate, true);
    assert.equal((await pool.query("SELECT body_hash FROM rail_stripe_callback_inbox")).rows[0].body_hash, rows[0].body_hash);
    await runMigrations(pool);
    assert.equal((await inbox.accept(raw, sig)).duplicate, true);
    await assert.rejects(pool.query("UPDATE rail_stripe_callback_inbox SET payment_intent_id='pi_changed'"), /stripe_callback_binding_is_immutable/);
    await assert.rejects(pool.query("DELETE FROM rail_stripe_callback_inbox"), /stripe_callback_is_durable/);
  });
});

test("Stripe callback conflicts, invalid signatures and ignored event types do not mutate financial state", options, async () => {
  await fixture(async ({ pool, inbox }) => {
    const raw = body(); await inbox.accept(raw, signature(raw));
    const conflicting = body("evt_fixture", "pi_other");
    await assert.rejects(inbox.accept(conflicting, signature(conflicting)), { code: "stripe_event_conflict" });
    await assert.rejects(inbox.accept(Buffer.concat([raw, Buffer.from(" ")]), signature(raw)), { code: "invalid_stripe_webhook" });
    const unrelated = body("evt_unrelated", "pi_unrelated", { type: "customer.created" });
    assert.equal((await inbox.accept(unrelated, signature(unrelated))).ignored, true);
    assert.equal((await pool.query("SELECT count(*) FROM rail_stripe_callback_inbox")).rows[0].count, "1");
  });
});

test("Stripe pending inbox capacity is race-safe and still acknowledges duplicates when full", options, async () => {
  await fixture(async ({ pool, inbox }) => {
    const first = body("evt_first"), second = body("evt_second");
    const results = await Promise.allSettled([inbox.accept(first, signature(first)), inbox.accept(second, signature(second))]);
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(results.find(value => value.status === "rejected").reason.code, "stripe_inbox_full");
    const row = (await pool.query("SELECT event_id FROM rail_stripe_callback_inbox")).rows[0];
    const duplicate = body(row.event_id); assert.equal((await inbox.accept(duplicate, signature(duplicate))).duplicate, true);
  }, 1);
});

test("Stripe callback insert failure rolls back admission and the signed event can retry", options, async () => {
  await fixture(async ({ pool, inbox }) => {
    await pool.query(`CREATE FUNCTION fail_callback() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'inbox_fault'; END $$;
      CREATE TRIGGER fail_callback BEFORE INSERT ON rail_stripe_callback_inbox FOR EACH ROW EXECUTE FUNCTION fail_callback()`);
    const raw = body(); await assert.rejects(inbox.accept(raw, signature(raw)), /inbox_fault/);
    assert.equal((await pool.query("SELECT count(*) FROM rail_stripe_callback_inbox")).rows[0].count, "0");
    await pool.query("DROP TRIGGER fail_callback ON rail_stripe_callback_inbox");
    assert.equal((await inbox.accept(raw, signature(raw))).duplicate, false);
  });
});

test("Stripe HTTP callback route verifies raw bytes, requires JSON and never substitutes owner or agent credentials", options, async () => {
  await fixture(async ({ pool, inbox }) => {
    const context = { stripeCallbacks: inbox, rateLimiter: new PostgresRateLimiter(pool),
      config: { maxRequestBodyBytes: 4096, requestBodyTimeoutMs: 1000, trustProxyHeaders: false } };
    const server = http.createServer(async (req, res) => {
      try {
        if (!await handleStripeRoutes(req, res, new URL(req.url, "http://localhost"), context)) { res.writeHead(404); res.end("{}"); }
      } catch (error) { res.writeHead(error.status ?? 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.code ?? "internal_error" })); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}/v2/providers/stripe/webhook`;
    try {
      const raw = body();
      const send = (sig, extra = {}, payload = raw, suffix = "") => fetch(endpoint + suffix, { method: "POST", headers: { "Content-Type": "application/json",
        ...(sig ? { "Stripe-Signature": sig } : {}), ...extra }, body: payload });
      assert.equal((await send(undefined, { Authorization: "Bearer forged_owner_token" })).status, 400);
      assert.equal((await send(signature(raw), { "Content-Type": "text/plain" })).status, 415);
      assert.equal((await send(signature(raw), {}, raw, "?token=not_accepted")).status, 400);
      const response = await send(signature(raw));
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { received: true, ignored: false, duplicate: false });
      assert.equal((await send(signature(raw), {}, Buffer.concat([raw, Buffer.from(" ")]))).status, 400);
      const oversized = Buffer.alloc(4097, "x"); assert.equal((await send(signature(oversized), {}, oversized)).status, 413);
      context.stripeCallbacks = undefined;
      assert.equal((await send(signature(raw))).status, 404);
      assert.equal((await pool.query("SELECT count(*) FROM rail_stripe_callback_inbox")).rows[0].count, "1");
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});
