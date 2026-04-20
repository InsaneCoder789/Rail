import type { PaymentContext } from "./context.js";
import { Semaphore } from "./backpressure.js";
import type { Stage } from "./stage.js";

/**
 * Runs independent stages concurrently with a hard concurrency cap (backpressure).
 */
export async function runParallelBounded(
  stages: Stage[],
  ctx: PaymentContext,
  limiter: Semaphore,
): Promise<void> {
  await Promise.all(
    stages.map((stage) =>
      limiter.runExclusive(async () => {
        await stage(ctx);
      }),
    ),
  );
}
