import Stripe from "stripe";
import { createHash } from "node:crypto";
import { parseProviderPaymentBinding, providerPaymentFingerprint, type ProviderPayment, type ProviderObservation } from "../domain/providerPayment.js";

export interface StripeTestConfiguration {
  readonly secretKey: string;
  readonly accountId: string;
  readonly instruments: readonly { readonly ownerWalletId: string; readonly paymentMethodId: string; readonly customerId: string }[];
}
type Client = Pick<Stripe, "accounts" | "paymentMethods" | "paymentIntents">;
const id = (value: unknown, prefix: string): value is string => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9]{3,120}$`).test(value);
const objectId = (value: unknown) => typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? value.id : null;
const failure = (message: string): never => { throw new Error(message); };

/** One test merchant, configured saved cards only. No Connect, payouts, raw card data or live keys. */
export class StripeTestProvider {
  private readonly client: Client;
  private readonly accountId: string;
  private readonly instruments = new Map<string, { readonly ownerWalletId: string; readonly customerId: string }>();

  constructor(config: StripeTestConfiguration, client?: Client) {
    if (!config || !/^sk_test_[A-Za-z0-9]{16,256}$/.test(config.secretKey) || !id(config.accountId, "acct") ||
        !Array.isArray(config.instruments) || !config.instruments.length || config.instruments.length > 100)
      failure("INVALID_STRIPE_TEST_CONFIGURATION");
    this.accountId = config.accountId;
    for (const instrument of config.instruments) {
      if (!instrument || typeof instrument.ownerWalletId !== "string" || !/^[A-Za-z0-9_.:-]{3,128}$/.test(instrument.ownerWalletId) ||
          !id(instrument.paymentMethodId, "pm") || !id(instrument.customerId, "cus") || this.instruments.has(instrument.paymentMethodId))
        failure("INVALID_STRIPE_TEST_CONFIGURATION");
      this.instruments.set(instrument.paymentMethodId, Object.freeze({ ownerWalletId: instrument.ownerWalletId, customerId: instrument.customerId }));
    }
    this.client = client ?? new Stripe(config.secretKey, { apiVersion: "2026-10-28.endive", timeout: 5000, maxNetworkRetries: 0, telemetry: false });
  }

  private binding(payment: ProviderPayment) {
    const binding = parseProviderPaymentBinding(payment.binding), instrument = this.instruments.get(binding.instrumentRef);
    if (binding.provider !== "stripe" || binding.providerAccountRef !== this.accountId || binding.merchantRef !== this.accountId ||
        !instrument || instrument.ownerWalletId !== binding.ownerWalletId || payment.fingerprint !== providerPaymentFingerprint(binding) ||
        payment.idempotencyKey !== `rail_provider_v1_${binding.operationId}` || binding.amountMinor > 99999999)
      failure("STRIPE_PAYMENT_BINDING_MISMATCH");
    return { binding, instrument: instrument! };
  }

  private async requireAccount(): Promise<void> {
    try {
      const account = await this.client.accounts.retrieve(null);
      if (account.id !== this.accountId) failure("STRIPE_ACCOUNT_MISMATCH");
    } catch { failure("STRIPE_ACCOUNT_UNAVAILABLE"); }
  }

  /** Never trust a webhook snapshot or a caller's status; normalize authenticated retrieval. */
  normalize(payment: ProviderPayment, intent: Stripe.PaymentIntent): ProviderObservation {
    const { binding, instrument } = this.binding(payment);
    if (!intent || intent.object !== "payment_intent" || !id(intent.id, "pi") || intent.livemode !== false ||
        (payment.providerRef !== null && intent.id !== payment.providerRef) || intent.amount !== binding.amountMinor ||
        intent.currency !== binding.currency.toLowerCase() || objectId(intent.customer) !== instrument.customerId ||
        (objectId(intent.payment_method) !== binding.instrumentRef && !(["requires_payment_method", "canceled"].includes(intent.status) && intent.payment_method === null)) ||
        intent.metadata?.rail_operation_id !== binding.operationId || intent.metadata?.rail_fingerprint !== payment.fingerprint ||
        intent.capture_method !== "automatic" || intent.confirmation_method !== "automatic" ||
        !Array.isArray(intent.payment_method_types) || intent.payment_method_types.length !== 1 || intent.payment_method_types[0] !== "card" || intent.on_behalf_of !== null ||
        intent.transfer_data !== null || intent.application_fee_amount !== null || intent.amount_capturable !== 0)
      failure("STRIPE_OBSERVATION_MISMATCH");
    let status: ProviderObservation["status"];
    switch (intent.status) {
      case "succeeded":
        if (intent.amount_received !== binding.amountMinor) failure("STRIPE_OBSERVATION_MISMATCH");
        status = "succeeded"; break;
      case "canceled":
        if (intent.amount_received !== 0) failure("STRIPE_OBSERVATION_MISMATCH");
        status = "cancelled"; break;
      case "processing": status = "processing"; break;
      case "requires_action": case "requires_payment_method": case "requires_confirmation": status = "requires_owner_action"; break;
      default: return failure("UNSUPPORTED_STRIPE_PAYMENT_STATE");
    }
    return Object.freeze({ operationId: binding.operationId, fingerprint: payment.fingerprint, provider: "stripe",
      providerAccountRef: this.accountId, providerRef: intent.id, amountMinor: binding.amountMinor, currency: binding.currency,
      status, final: status === "succeeded" || status === "cancelled" });
  }

  /** Caller must have durably committed the submission boundary after checking authority. */
  async submit(payment: ProviderPayment): Promise<ProviderObservation> {
    const { binding, instrument } = this.binding(payment);
    if (payment.status !== "submitting" || payment.firstSubmissionAtMs === null || payment.providerRef !== null)
      failure("STRIPE_SUBMISSION_NOT_ADMITTED");
    await this.requireAccount();
    try {
      const method = await this.client.paymentMethods.retrieve(binding.instrumentRef);
      if (method.livemode !== false || method.id !== binding.instrumentRef || method.type !== "card" || objectId(method.customer) !== instrument.customerId)
        failure("STRIPE_INSTRUMENT_MISMATCH");
    } catch { return failure("STRIPE_INSTRUMENT_UNAVAILABLE"); }
    try {
      const intent = await this.client.paymentIntents.create({ amount: binding.amountMinor, currency: binding.currency.toLowerCase(),
        customer: instrument.customerId, payment_method: binding.instrumentRef, confirm: true, off_session: true,
        allowed_payment_method_types: ["card"], capture_method: "automatic", confirmation_method: "automatic",
        metadata: { rail_operation_id: binding.operationId, rail_fingerprint: payment.fingerprint } }, { idempotencyKey: payment.idempotencyKey });
      return this.normalize(payment, intent);
    } catch {
      // SDK errors can contain credentials, client secrets or an indeterminate PaymentIntent.
      // Preserve liability; lookup or a verified callback must establish the actual outcome.
      return failure("STRIPE_SUBMISSION_UNCERTAIN");
    }
  }

  /** Read-only recovery, including after revocation/expiry. Absence never proves failure. */
  async lookup(payment: ProviderPayment): Promise<ProviderObservation | null> {
    const { instrument } = this.binding(payment);
    await this.requireAccount();
    try {
      if (payment.providerRef !== null) {
        if (!id(payment.providerRef, "pi")) failure("STRIPE_OBSERVATION_MISMATCH");
        return this.normalize(payment, await this.client.paymentIntents.retrieve(payment.providerRef));
      }
      if (payment.firstSubmissionAtMs === null) failure("STRIPE_LOOKUP_BEFORE_SUBMISSION");
      const result = await this.client.paymentIntents.list({ customer: instrument.customerId, limit: 100,
        created: { gte: Math.max(0, Math.floor(payment.firstSubmissionAtMs! / 1000) - 300) } });
      if (result.has_more) failure("STRIPE_LOOKUP_INCOMPLETE");
      const matches = result.data.filter(value => value.metadata?.rail_operation_id === payment.binding.operationId);
      if (matches.length > 1) failure("STRIPE_OPERATION_AMBIGUOUS");
      return matches.length ? this.normalize(payment, matches[0]) : null;
    } catch { return failure("STRIPE_LOOKUP_UNAVAILABLE"); }
  }

  /** Signature verification only. The eventual handler must deduplicate and retrieve current state. */
  verifyWebhook(rawBody: Buffer, signature: unknown, webhookSecret: string) {
    return verifyStripeTestWebhook(rawBody, signature, webhookSecret);
  }
}

/** Callback admission needs only the endpoint secret, never an API key or charge permission. */
export function verifyStripeTestWebhook(rawBody: Buffer, signature: unknown, webhookSecret: string) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > 262144 || typeof signature !== "string" ||
      signature.length > 4096 || !/^whsec_[A-Za-z0-9]{16,256}$/.test(webhookSecret)) failure("INVALID_STRIPE_WEBHOOK");
  try {
    const timestamps = (signature as string).split(",").filter(part => part.startsWith("t="));
    if (timestamps.length !== 1 || !/^t=[0-9]{1,12}$/.test(timestamps[0]) ||
        Math.abs(Math.floor(Date.now() / 1000) - Number(timestamps[0].slice(2))) > 300) failure("INVALID_STRIPE_WEBHOOK");
    const event = Stripe.webhooks.constructEvent(rawBody, signature as string, webhookSecret, 300);
    if (!id(event.id, "evt") || event.livemode !== false || event.account !== undefined) failure("INVALID_STRIPE_WEBHOOK");
    if (!["payment_intent.succeeded", "payment_intent.processing", "payment_intent.payment_failed", "payment_intent.canceled", "payment_intent.requires_action"].includes(event.type)) return null;
    const intent = event.data.object as { object?: unknown; id?: unknown };
    if (intent.object !== "payment_intent" || !id(intent.id, "pi")) failure("INVALID_STRIPE_WEBHOOK");
    return Object.freeze({ eventId: event.id, paymentIntentId: intent.id, bodyHash: createHash("sha256").update(rawBody).digest("hex") });
  } catch { return failure("INVALID_STRIPE_WEBHOOK"); }
}
