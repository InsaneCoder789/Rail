import http from "node:http";
import type { Pool } from "pg";
import { PipelineError } from "../pipeline/errors.js";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  readonly exposeMessage: boolean;

  constructor(status: number, code: string, message: string, hint?: string, exposeMessage = true) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.exposeMessage = exposeMessage;
  }
}

export class RateLimitError extends RequestError {
  readonly retryAfterSeconds: number;
  readonly limit: number;
  readonly remaining: number;

  constructor(message: string, retryAfterSeconds: number, limit: number, remaining: number) {
    super(429, "rate_limited", message, `retry after ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
    this.limit = limit;
    this.remaining = remaining;
  }
}

export function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export function resolveAllowedOrigin(
  req: http.IncomingMessage,
  allowedOrigins: readonly string[],
): string | undefined {
  const origin = normalizeHeaderValue(req.headers.origin);
  if (!origin) return undefined;
  if (allowedOrigins.includes(origin)) {
    return origin;
  }
  return undefined;
}

export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: readonly string[],
): void {
  const allowedOrigin = resolveAllowedOrigin(req, allowedOrigins);
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-RAIL-API-KEY, X-KYLR-API-KEY");
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

export function readJsonBody(req: http.IncomingMessage, maxBytes: number, timeoutMs = 10_000): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new Error("invalid_body_read_limits"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let finished = false;
    const cleanup = () => {
      clearTimeout(deadline);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      req.removeListener("close", onClose);
    };

    const rejectOnce = (err: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      chunks.length = 0;
      req.pause();
      reject(err);
    };

    const resolveOnce = (value: string): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };

    const onData = (c: Buffer | string) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejectOnce(
          new RequestError(
            413,
            "payload_too_large",
            `request body exceeded ${maxBytes} bytes`,
            "reduce payload size or increase RAIL_MAX_REQUEST_BODY_BYTES",
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => resolveOnce(Buffer.concat(chunks).toString("utf8"));
    const onError = (error: Error) => rejectOnce(error);
    const onAborted = () => rejectOnce(new RequestError(400, "request_aborted", "request body was interrupted"));
    const onClose = () => { if (!finished) onAborted(); };
    const deadline = setTimeout(() => rejectOnce(new RequestError(408, "body_timeout", "request body deadline exceeded")), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    req.once("close", onClose);
    if (req.aborted || req.destroyed) onAborted();
  });
}

export async function readAndParseJson(req: http.IncomingMessage, maxBytes: number, timeoutMs = 10_000): Promise<unknown> {
  const raw = await readJsonBody(req, maxBytes, timeoutMs);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new RequestError(400, "invalid_json", "request body is not valid JSON");
  }
}

export function requireJsonContentType(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requireContentType: boolean,
): boolean {
  if (!requireContentType) return true;
  const contentType = normalizeHeaderValue(req.headers["content-type"]);
  const normalized = contentType?.toLowerCase().split(";")[0].trim();
  if (normalized === "application/json") {
    return true;
  }
  json(res, 415, {
    error: "unsupported_media_type",
    hint: "set Content-Type: application/json",
  });
  return false;
}

export function getClientIp(req: http.IncomingMessage, trustProxyHeaders = false): string {
  if (trustProxyHeaders) {
    const realIp = normalizeHeaderValue(req.headers["x-real-ip"]);
    if (realIp) return realIp.trim();
    const forwarded = normalizeHeaderValue(req.headers["x-forwarded-for"]);
    if (forwarded) return forwarded.split(",")[0].trim();
  }
  const remote = req.socket.remoteAddress;
  return remote && remote.length > 0 ? remote : "unknown";
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, { timestamps: number[]; expiresAt: number }>();

  constructor(private readonly capacity = 10000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("invalid_rate_limit_capacity");
  }

  consume(key: string, limit: number, windowMs: number): { limit: number; remaining: number; retryAfterSeconds: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new Error("invalid_rate_limit_policy");
    }
    const now = Date.now();
    const earliest = now - windowMs;
    if (!this.hits.has(key) && this.hits.size >= this.capacity) {
      for (const [existingKey, bucket] of this.hits) {
        if (bucket.expiresAt <= now) this.hits.delete(existingKey);
      }
      if (this.hits.size >= this.capacity) return { limit, remaining: 0, retryAfterSeconds: 1 };
    }
    const current = (this.hits.get(key)?.timestamps ?? []).filter((ts) => ts > earliest);

    if (current.length >= limit) {
      const retryAfterMs = Math.max(1_000, windowMs - (now - current[0]));
      this.hits.set(key, { timestamps: current, expiresAt: current.at(-1)! + windowMs });
      return {
        limit,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    current.push(now);
    this.hits.set(key, { timestamps: current, expiresAt: now + windowMs });

    return {
      limit,
      remaining: Math.max(0, limit - current.length),
      retryAfterSeconds: 0,
    };
  }
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number):
    | { limit: number; remaining: number; retryAfterSeconds: number }
    | Promise<{ limit: number; remaining: number; retryAfterSeconds: number }>;
}

export async function applyRateLimit(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  rateLimiter: RateLimiter;
  scope: string;
  limit: number;
  windowMs: number;
  discriminator?: string;
  trustProxyHeaders?: boolean;
}): Promise<void> {
  const key = `${args.scope}:${getClientIp(args.req, args.trustProxyHeaders)}:${args.discriminator ?? "anon"}`;
  const decision = await args.rateLimiter.consume(key, args.limit, args.windowMs);

  args.res.setHeader("X-RateLimit-Limit", String(decision.limit));
  args.res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  if (decision.retryAfterSeconds > 0) {
    args.res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    throw new RateLimitError(
      `${args.scope} rate limit exceeded`,
      decision.retryAfterSeconds,
      decision.limit,
      decision.remaining,
    );
  }
}

export function toErrorResponse(
  err: unknown,
  exposeInternalErrors: boolean,
): { status: number; body: Record<string, unknown> } {
  if (err instanceof Error && "code" in err && err.code === "23514" && err.message === "accounting_baseline_required") {
    return { status: 503, body: { error: "accounting_review_required" } };
  }
  if (err instanceof PipelineError) {
    const conflicts = ["IDEMPOTENCY_KEY_REUSED", "PAYMENT_ALREADY_EXECUTED", "AUTH_NOT_EXECUTABLE", "COMMITTED_PAYMENT_MISMATCH",
      "unknown_or_expired_token", "token_expired", "wallet_mismatch", "device_mismatch", "currency_mismatch", "insufficient_token_headroom"];
    if (conflicts.includes(err.code)) return { status: 409, body: { error: err.code.toLowerCase() } };
    if (["offline_spend_mismatch", "AUTHORIZATION_TX_CONFLICT"].includes(err.code)) return { status: 409, body: { error: err.code.toLowerCase() } };
    if (["INVALID_TRANSACTION", "SELF_TRANSFER", "invalid_amount", "invalid_transaction"].includes(err.code)) return { status: 422, body: { error: err.code.toLowerCase() } };
    if (["MISSING_AUTH_ID", "SIGNATURE_INVALID"].includes(err.code)) return { status: 401, body: { error: err.code.toLowerCase() } };
    if (err.retryable || err.code === "OFFLINE_TOKEN_STORE_REQUIRED") return { status: 503, body: { error: "temporarily_unavailable" } };
  }
  if (err instanceof RequestError) {
    const body: Record<string, unknown> = { error: err.code };
    if (err.hint) body.hint = err.hint;
    if (exposeInternalErrors || err.exposeMessage) {
      body.message = err.message;
    }
    return { status: err.status, body };
  }
  if (exposeInternalErrors) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: "internal_error", message } };
  }
  return { status: 500, body: { error: "internal_error" } };
}
