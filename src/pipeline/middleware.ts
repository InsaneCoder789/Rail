import type { PaymentContext } from "./context.js";
import type { Tracer } from "./tracing.js";
import type { Stage } from "./stage.js";

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
