import type { PaymentContext } from "./context.js";
import type { Tracer } from "./tracing.js";
import type { RetryPolicy } from "./retry.js";
import { withRetry } from "./retry.js";
import type { Stage } from "./stage.js";
import { PipelineError } from "./errors.js";

export function withSpan(tracer: Tracer, name: string, stage: Stage): Stage {
  return async (ctx: PaymentContext) => {
    const span = tracer.startSpan(name, {
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      txId: ctx.txn.txId,
    });
    try {
      await stage(ctx);
      span.end("ok");
    } catch (err) {
      span.end("error", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

export function withTimeout(ms: number, stage: Stage): Stage {
  return async (ctx: PaymentContext) => {
    await Promise.race([
      stage(ctx),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new PipelineError(`stage exceeded ${ms}ms`, "TIMEOUT", true));
        }, ms);
      }),
    ]);
  };
}

export function withRetryStage(policy: RetryPolicy, stage: Stage): Stage {
  return async (ctx: PaymentContext) => {
    const controller = new AbortController();
    await withRetry(
      async () => {
        await stage(ctx);
        return undefined;
      },
      policy,
      controller.signal,
    );
  };
}
