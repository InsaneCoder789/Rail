import type { PaymentContext } from "./context.js";

export interface SagaStep {
  readonly name: string;
  forward(ctx: PaymentContext): Promise<void>;
  compensate(ctx: PaymentContext): Promise<void>;
}

export class SagaCoordinator {
  constructor(private readonly steps: SagaStep[]) {}

  async run(ctx: PaymentContext): Promise<void> {
    const done: SagaStep[] = [];
    try {
      for (const step of this.steps) {
        await step.forward(ctx);
        done.push(step);
      }
    } catch (err) {
      for (const step of done.reverse()) {
        try {
          await step.compensate(ctx);
        } catch (compErr) {
          console.error(`compensate_failed:${step.name}`, compErr);
        }
      }
      throw err;
    }
  }
}
