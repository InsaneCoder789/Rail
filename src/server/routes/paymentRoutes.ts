import http from "node:http";
import type { PaymentAuthorization } from "../../domain/authorization.js";
import type { PaymentTransaction } from "../../domain/types.js";
import { processSyncBatch } from "../../rail/syncBatch.js";
import { createAuthorization, getAuthorizationById } from "../../stages/authorizationStage.js";
import { RequestError, applyRateLimit, applyIdentityRateLimit, json, readAndParseJson, requireJsonContentType, toErrorResponse } from "../http.js";
import type { ServerContext, WalletAuthentication } from "../types.js";
import { readBehaviourObservation } from "../../risk/behaviourRisk.js";
import {
  isCurrency,
  isRecord,
  isIssueTokenRequest,
  isPaymentTransaction,
  isSafeText,
  isSyncBody,
  isValidAmountMinor,
  toPaymentTransaction,
} from "../validation.js";

function resolveAuthorizationReference(body: Record<string, unknown>): {
  authorizationId?: string;
  providedAuthorization?: PaymentAuthorization;
} {
  const explicitId = typeof body.authorizationId === "string" ? body.authorizationId : undefined;
  const rawAuthorization = body.authorization;
  const providedAuthorization =
    rawAuthorization && typeof rawAuthorization === "object"
      ? (rawAuthorization as PaymentAuthorization)
      : undefined;
  const embeddedId = providedAuthorization?.authId;

  if (explicitId && embeddedId && explicitId !== embeddedId) {
    throw new RequestError(
      422,
      "authorization_reference_mismatch",
      "authorizationId does not match authorization.authId",
    );
  }

  return {
    authorizationId: explicitId ?? embeddedId,
    providedAuthorization,
  };
}

function assertAuthorizationMatchesTransaction(auth: PaymentAuthorization, txn: PaymentTransaction): void {
  if (
    auth.txId !== txn.txId ||
    auth.amountMinor !== txn.amountMinor ||
    auth.currency !== txn.currency ||
    auth.senderWalletId !== txn.senderWalletId ||
    auth.receiverWalletId !== txn.receiverWalletId
  ) {
    throw new RequestError(401, "auth_txn_mismatch", "authorization does not match transaction");
  }
}

async function assertStoredAuthorizationUsable(
  auth: { status: string; expiresAt: string },
  txn: PaymentTransaction,
  context: ServerContext,
): Promise<void> {
  // Used authorizations reach the engine's fingerprint-bound replay check, even after expiry.
  if (auth.status === "used") return;
  if (Date.parse(auth.expiresAt) <= Date.now()) {
    throw new RequestError(409, "authorization_expired", "authorization has expired");
  }

  if (auth.status === "issued") {
    return;
  }

  throw new RequestError(409, "authorization_not_issued", `authorization status is ${auth.status}`);
}

async function prepareAuthorizedTransaction(
  txn: PaymentTransaction,
  context: ServerContext,
): Promise<void> {
  if (!txn.authorizationId) {
    throw new RequestError(401, "authorization_required", "missing authorization");
  }

  if (!context.pool) throw new RequestError(503, "database_required", "payment persistence unavailable");
  const storedAuthorization = await getAuthorizationById(txn.authorizationId, context.pool);
  if (!storedAuthorization) {
    throw new RequestError(404, "authorization_not_found", "authorization not found");
  }

  assertAuthorizationMatchesTransaction(storedAuthorization, txn);
  await assertStoredAuthorizationUsable(storedAuthorization, txn, context);
}

export async function handlePaymentRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<boolean> {
  const readScope = req.method === "GET" && /^\/v1\/payments\/[^/]+\/(risk|evidence)$/.exec(url.pathname)?.[1];
  const writeLimits: Readonly<Record<string, readonly [string, number, number]>> = {
    "/v1/payments/authorize": ["authorize", context.config.rateLimits.authorizeMax, context.config.rateLimits.authorizeWindowMs],
    "/v1/payments/execute": ["execute", context.config.rateLimits.executeMax, context.config.rateLimits.executeWindowMs],
    "/v1/offline/tokens/issue": ["offline_token_issue", context.config.rateLimits.tokenIssueMax, context.config.rateLimits.tokenIssueWindowMs],
    "/v1/sync/transactions": ["sync", context.config.rateLimits.syncMax, context.config.rateLimits.syncWindowMs],
  };
  const quota = readScope ? [`${readScope}_read`, 30, 60_000] as const
    : req.method === "POST" ? writeLimits[url.pathname] : undefined;
  let authenticatedWallet: string | undefined;
  let authentication: WalletAuthentication | undefined;
  if (quota) {
    const [scope, limit, windowMs] = quota;
    await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: `${scope}_source`,
      limit, windowMs, trustProxyHeaders: context.config.trustProxyHeaders });
    const privilegedScope = scope === "offline_token_issue" ? "offline_tokens:issue" : scope === "sync" ? "sync:write" : undefined;
    if (privilegedScope) {
      if (!context.authResolver.requireApiKey(req, res, privilegedScope)) return true;
    } else {
      if (context.authResolver.resolveFinancialPrincipal) {
        authentication = await context.authResolver.resolveFinancialPrincipal(req);
        authenticatedWallet = authentication.walletId;
      } else authenticatedWallet = await context.authResolver.resolveAuthenticatedWallet(req);
    }
    // This runtime has one configured privileged issuer, not a principal chosen by the request body.
    await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope,
      identity: authenticatedWallet ?? "configured_service", limit, windowMs });
  }
  const auditRoute = /^\/v1\/payments\/([^/]+)\/audit$/.exec(url.pathname);
  if (req.method === "GET" && auditRoute) {
    await applyRateLimit({ req, res, rateLimiter: context.rateLimiter, scope: "audit_read_source",
      limit: 30, windowMs: 60_000, trustProxyHeaders: context.config.trustProxyHeaders });
    const walletId = await context.authResolver.resolveAuthenticatedWallet(req);
    await applyIdentityRateLimit({ res, rateLimiter: context.rateLimiter, scope: "audit_read", identity: walletId,
      limit: 30, windowMs: 60_000 });
    let txId: string;
    try { txId = decodeURIComponent(auditRoute[1]); } catch { throw new RequestError(400, "invalid_transaction_id", "invalid transaction ID"); }
    if (!isSafeText(txId, 8, 128)) throw new RequestError(400, "invalid_transaction_id", "invalid transaction ID");
    const audit = await context.auditStore.status(txId, walletId);
    if (!audit) throw new RequestError(404, "payment_not_found", "payment not found");
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, { audit });
    return true;
  }
  const riskRoute = /^\/v1\/payments\/([^/]+)\/risk$/.exec(url.pathname);
  if (req.method === "GET" && riskRoute) {
    const walletId = authenticatedWallet!;
    let txId: string;
    try { txId = decodeURIComponent(riskRoute[1]); } catch { throw new RequestError(400, "invalid_transaction_id", "invalid transaction ID"); }
    if (!isSafeText(txId, 8, 128)) throw new RequestError(400, "invalid_transaction_id", "invalid transaction ID");
    const risk = await readBehaviourObservation(context.pool, txId, walletId, context.riskProtection);
    if (!risk) throw new RequestError(404, "payment_not_found", "payment not found");
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, { risk });
    return true;
  }
  const evidenceRoute = /^\/v1\/payments\/([^/]+)\/evidence$/.exec(url.pathname);
  if (req.method === "GET" && evidenceRoute) {
    const walletId = authenticatedWallet!;
    let txId: string;
    try { txId = decodeURIComponent(evidenceRoute[1]); } catch { throw new RequestError(400, "invalid_transaction_id", "invalid transaction ID"); }
    if (!isSafeText(txId, 8, 128)) throw new RequestError(400, "invalid_transaction_id", "invalid transaction ID");
    const evidence = await context.evidenceStore.status(context.pool, txId, walletId);
    if (!evidence) throw new RequestError(404, "payment_not_found", "payment not found");
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, { evidence });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/payments/authorize") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);

    if (!isRecord(parsed)) {
      throw new RequestError(422, "invalid_body", "expected object body");
    }

    const body = parsed;

    if (
      !isSafeText(body.txId, 8, 128) ||
      !isSafeText(body.senderWalletId, 3, 128) ||
      !isSafeText(body.receiverWalletId, 3, 128) ||
      !isValidAmountMinor(body.amountMinor) ||
      !isCurrency(body.currency)
    ) {
      throw new RequestError(
        422,
        "invalid_body",
        "invalid authorization request",
        "txId, senderWalletId, receiverWalletId, amountMinor, currency required",
      );
    }

    if (body.senderWalletId !== authenticatedWallet) {
      throw new RequestError(403, "identity_mismatch", "sender does not match auth");
    }

    if (!context.pool) throw new RequestError(503, "database_required", "payment persistence unavailable");
    const authorization = await createAuthorization({
      txId: body.txId as string,
      senderWalletId: body.senderWalletId as string,
      receiverWalletId: body.receiverWalletId as string,
      amountMinor: body.amountMinor as number,
      currency: body.currency as string,
    }, context.pool, authentication);

    json(res, 200, { authorization });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/offline/tokens/issue") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
    if (!isIssueTokenRequest(parsed)) {
      json(res, 422, {
        error: "invalid_body",
        hint: "walletId, deviceId, amountCapMinor required",
      });
      return true;
    }
    const row = await context.offlineTokenStore.issue({
      walletId: parsed.walletId,
      deviceId: parsed.deviceId,
      amountCapMinor: parsed.amountCapMinor,
      currency: parsed.currency,
      ttlSeconds: parsed.ttlSeconds,
    });

    json(res, 200, {
      token: {
        tokenId: row.tokenId,
        walletId: row.walletId,
        deviceId: row.deviceId,
        amountCapMinor: row.amountCapMinor,
        remainingMinor: row.remainingMinor,
        currency: row.currency,
        issuedAtMs: row.issuedAtMs,
        expiresAtMs: row.expiresAtMs,
      },
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/payments/execute") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);

    if (!isRecord(parsed)) throw new RequestError(422, "invalid_body", "expected object body");
    const body = parsed;
    const { authorizationId, providedAuthorization } = resolveAuthorizationReference(body);
    const { authorization: _authorization, ...txnRaw } = body;

    if (!isPaymentTransaction(txnRaw)) {
      json(res, 422, { error: "invalid_body", hint: "expected PaymentTransaction fields" });
      return true;
    }

    const txn = toPaymentTransaction({
      ...(txnRaw as PaymentTransaction),
      authorizationId,
    });

    if (txn.senderWalletId !== authenticatedWallet) {
      throw new RequestError(403, "identity_mismatch", "sender does not match auth");
    }

    await prepareAuthorizedTransaction(txn, context);
    if (providedAuthorization) {
      if (!context.pool) throw new RequestError(503, "database_required", "payment persistence unavailable");
      const storedAuthorization = await getAuthorizationById(txn.authorizationId!, context.pool);
      if (!storedAuthorization) {
        throw new RequestError(404, "authorization_not_found", "authorization not found");
      }
      assertAuthorizationMatchesTransaction(providedAuthorization, txn);
      if (providedAuthorization.signature !== storedAuthorization.signature) {
        throw new RequestError(
          401,
          "authorization_signature_mismatch",
          "authorization signature does not match stored authorization",
        );
      }
    }

    const result = await context.engine.execute(txn, authentication);
    json(res, 200, { result });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/sync/transactions") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes, context.config.requestBodyTimeoutMs);
    if (!isSyncBody(parsed, context.config.maxSyncBatchSize)) {
      json(res, 422, {
        error: "invalid_body",
        hint: `deviceId and transactions[] required (1-${context.config.maxSyncBatchSize} items)`,
      });
      return true;
    }
    const txns: PaymentTransaction[] = [];
    for (const item of parsed.transactions) {
      if (!isPaymentTransaction(item)) {
        json(res, 422, { error: "invalid_transaction_in_batch" });
        return true;
      }

      const txn = toPaymentTransaction(item);
      if (txn.channel === "online") {
        json(res, 422, {
          error: "online_transaction_not_allowed_in_sync",
          hint: "sync is only for queued offline transactions",
        });
        return true;
      }
      if (txn.deviceId !== parsed.deviceId) {
        json(res, 422, {
          error: "device_mismatch_in_batch",
          hint: "offline transactions must use same deviceId as sync request",
        });
        return true;
      }
      if (!txn.authorizationId) {
        json(res, 422, {
          error: "authorization_required_in_batch",
          hint: "each synced transaction must include authorizationId",
        });
        return true;
      }

      try {
        await prepareAuthorizedTransaction(txn, context);
      } catch (err) {
        const mapped = toErrorResponse(err, context.config.exposeInternalErrors);
        json(res, mapped.status, {
          ...mapped.body,
          txId: txn.txId,
        });
        return true;
      }

      txns.push(txn);
    }

    const results = await processSyncBatch(context.engine, txns);
    json(res, 200, { deviceId: parsed.deviceId, results });
    return true;
  }

  return false;
}
