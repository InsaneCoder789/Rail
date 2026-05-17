import http from "node:http";

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

export function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let finished = false;

    const rejectOnce = (err: unknown): void => {
      if (finished) return;
      finished = true;
      reject(err);
    };

    const resolveOnce = (value: string): void => {
      if (finished) return;
      finished = true;
      resolve(value);
    };

    req.on("data", (c) => {
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
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveOnce(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => rejectOnce(err));
  });
}

export async function readAndParseJson(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = await readJsonBody(req, maxBytes);
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

export function getClientIp(req: http.IncomingMessage): string {
  const forwarded = normalizeHeaderValue(req.headers["x-forwarded-for"]);
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const remote = req.socket.remoteAddress;
  return remote && remote.length > 0 ? remote : "unknown";
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  consume(key: string, limit: number, windowMs: number): { limit: number; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    const earliest = now - windowMs;
    const current = (this.hits.get(key) ?? []).filter((ts) => ts > earliest);

    if (current.length >= limit) {
      const retryAfterMs = Math.max(1_000, windowMs - (now - current[0]));
      this.hits.set(key, current);
      return {
        limit,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    current.push(now);
    this.hits.set(key, current);

    if (this.hits.size > 20_000) {
      for (const [existingKey, timestamps] of this.hits) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= earliest) {
          this.hits.delete(existingKey);
        }
      }
    }

    return {
      limit,
      remaining: Math.max(0, limit - current.length),
      retryAfterSeconds: 0,
    };
  }
}

export function applyRateLimit(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  rateLimiter: SlidingWindowRateLimiter;
  scope: string;
  limit: number;
  windowMs: number;
  discriminator?: string;
}): void {
  const key = `${args.scope}:${getClientIp(args.req)}:${args.discriminator ?? "anon"}`;
  const decision = args.rateLimiter.consume(key, args.limit, args.windowMs);

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
