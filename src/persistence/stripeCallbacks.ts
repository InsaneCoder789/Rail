import type { Pool } from "pg";
import { verifyStripeTestWebhook } from "../rail/stripeProvider.js";
import { RequestError } from "../server/http.js";

interface Configuration { readonly accountId: string; readonly webhookSecret: string; }
const valid = (value: Configuration) => value && /^acct_[A-Za-z0-9]{3,120}$/.test(value.accountId) && /^whsec_[A-Za-z0-9]{16,256}$/.test(value.webhookSecret);

export function loadStripeCallbackConfiguration(env: NodeJS.ProcessEnv = process.env): Configuration | undefined {
  const flag = env.RAIL_STRIPE_TEST_WEBHOOKS;
  if (flag === undefined || flag === "false") return undefined;
  const value = { accountId: env.RAIL_STRIPE_ACCOUNT_ID ?? "", webhookSecret: env.RAIL_STRIPE_WEBHOOK_SECRET ?? "" };
  if (flag !== "true" || env.NODE_ENV === "production" || env.RAIL_DEMO_MODE !== "true" || !valid(value))
    throw new Error("INVALID_STRIPE_TEST_CALLBACK_CONFIGURATION");
  return Object.freeze(value);
}

/** Durable admission only. No provider API call or financial transition occurs here. */
export class StripeCallbackInbox {
  private readonly configuration: Configuration;
  constructor(private readonly pool: Pool, configuration: Configuration, private readonly maxPending = 10000) {
    if (!valid(configuration) || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 10000)
      throw new Error("INVALID_STRIPE_TEST_CALLBACK_CONFIGURATION");
    this.configuration = Object.freeze({ ...configuration });
  }

  async accept(rawBody: Buffer, signature: unknown) {
    let candidate;
    try { candidate = verifyStripeTestWebhook(rawBody, signature, this.configuration.webhookSecret); }
    catch { throw new RequestError(400, "invalid_stripe_webhook", "invalid Stripe webhook"); }
    if (!candidate) return { received: true, ignored: true, duplicate: false };
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`rail:stripe-inbox:${this.configuration.accountId}`]);
      const previous = (await client.query(`SELECT payment_intent_id FROM rail_stripe_callback_inbox
        WHERE stripe_account_id=$1 AND event_id=$2`, [this.configuration.accountId, candidate.eventId])).rows[0];
      if (previous && previous.payment_intent_id !== candidate.paymentIntentId)
        throw new RequestError(409, "stripe_event_conflict", "Stripe event correlation conflict");
      if (!previous) {
        const pending = await client.query(`SELECT count(*) AS count FROM rail_stripe_callback_inbox
          WHERE stripe_account_id=$1 AND processed_at IS NULL`, [this.configuration.accountId]);
        if (Number(pending.rows[0].count) >= this.maxPending)
          throw new RequestError(503, "stripe_inbox_full", "Stripe callback backlog requires attention");
        await client.query(`INSERT INTO rail_stripe_callback_inbox(stripe_account_id,event_id,payment_intent_id,body_hash)
          VALUES($1,$2,$3,$4)`, [this.configuration.accountId, candidate.eventId, candidate.paymentIntentId, candidate.bodyHash]);
      }
      await client.query("COMMIT");
      return { received: true, ignored: false, duplicate: Boolean(previous) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); client.removeListener("error", onError); }
  }
}
