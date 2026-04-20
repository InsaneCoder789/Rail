import type { PaymentContext } from "./context.js";

export type Stage = (ctx: PaymentContext) => Promise<void>;

export async function runSequential(stages: Stage[], ctx: PaymentContext): Promise<void> {
  for (const stage of stages) {
    await stage(ctx);
  }
}
