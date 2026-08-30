import http from "node:http";
import type { PaymentAuthorization } from "../../domain/authorization.js";
import type { PaymentTransaction } from "../../domain/types.js";
import { processSyncBatch } from "../../rail/syncBatch.js";
import { createAuthorization, getAuthorizationById } from "../../stages/authorizationStage.js";
import { RequestError, applyRateLimit, json, readAndParseJson, requireJsonContentType, toErrorResponse } from "../http.js";
import type { ServerContext } from "../types.js";
import {
  isCurrency,
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
  if (Date.parse(auth.expiresAt) <= Date.now()) {
    throw new RequestError(409, "authorization_expired", "authorization has expired");
  }

  if (auth.status === "issued") {
    return;
  }

  if (auth.status === "used") {
    const completed = await context.idempotency.getCompleted(txn.idempotencyKey);
    if (completed) {
      return;
    }
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

  const storedAuthorization = await getAuthorizationById(txn.authorizationId);
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
  if (req.method === "POST" && url.pathname === "/v1/payments/authorize") {
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes);

    let authenticatedWallet: string;
    try {
      authenticatedWallet = await context.authResolver.resolveAuthenticatedWallet(req, url);
    } catch (err) {
      context.eventStore.emitSystemError(err, "auth.verify");
      throw err;
    }

    if (!parsed || typeof parsed !== "object") {
      throw new RequestError(422, "invalid_body", "expected object body");
    }

    const body = parsed as Record<string, unknown>;

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
    await applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "authorize",
      limit: context.config.rateLimits.authorizeMax,
      windowMs: context.config.rateLimits.authorizeWindowMs,
      discriminator: authenticatedWallet,
      trustProxyHeaders: context.config.trustProxyHeaders,
    });

    const authorization = await createAuthorization({
      txId: body.txId as string,
      senderWalletId: body.senderWalletId as string,
      receiverWalletId: body.receiverWalletId as string,
      amountMinor: body.amountMinor as number,
      currency: body.currency as string,
    });

    json(res, 200, { authorization });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/offline/tokens/issue") {
    if (!context.authResolver.requireApiKey(req, res, "offline_tokens:issue")) return true;
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes);
    if (!isIssueTokenRequest(parsed)) {
      json(res, 422, {
        error: "invalid_body",
        hint: "walletId, deviceId, amountCapMinor required",
      });
      return true;
    }

    await applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "offline_token_issue",
      limit: context.config.rateLimits.tokenIssueMax,
      windowMs: context.config.rateLimits.tokenIssueWindowMs,
      discriminator: `${parsed.walletId}:${parsed.deviceId}`,
      trustProxyHeaders: context.config.trustProxyHeaders,
    });

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

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes);

    let authenticatedWallet: string;
    try {
      authenticatedWallet = await context.authResolver.resolveAuthenticatedWallet(req, url);
    } catch (err) {
      context.eventStore.emitSystemError(err, "auth.verify");
      throw err;
    }

    const body = parsed as Record<string, unknown>;
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
    await applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "execute",
      limit: context.config.rateLimits.executeMax,
      windowMs: context.config.rateLimits.executeWindowMs,
      discriminator: authenticatedWallet,
      trustProxyHeaders: context.config.trustProxyHeaders,
    });

    await prepareAuthorizedTransaction(txn, context);
    if (providedAuthorization) {
      const storedAuthorization = await getAuthorizationById(txn.authorizationId!);
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

    const result = await context.engine.execute(txn);
    json(res, 200, { result });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/v1/sync/transactions") {
    if (!context.authResolver.requireApiKey(req, res, "sync:write")) return true;
    if (!requireJsonContentType(req, res, context.config.requireJsonContentType)) return true;

    const parsed = await readAndParseJson(req, context.config.maxRequestBodyBytes);
    if (!isSyncBody(parsed, context.config.maxSyncBatchSize)) {
      json(res, 422, {
        error: "invalid_body",
        hint: `deviceId and transactions[] required (1-${context.config.maxSyncBatchSize} items)`,
      });
      return true;
    }

    await applyRateLimit({
      req,
      res,
      rateLimiter: context.rateLimiter,
      scope: "sync",
      limit: context.config.rateLimits.syncMax,
      windowMs: context.config.rateLimits.syncWindowMs,
      discriminator: parsed.deviceId,
      trustProxyHeaders: context.config.trustProxyHeaders,
    });

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
