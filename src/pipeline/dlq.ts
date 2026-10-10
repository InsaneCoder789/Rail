export interface DeadLetterItem {
  readonly idempotencyKey: string;
  readonly txId: string;
  readonly error: string;
  readonly at: string;
}

export interface DeadLetterQueue {
  push(item: Omit<DeadLetterItem, "at">): void;
  snapshot(): DeadLetterItem[];
}

export class MemoryDeadLetterQueue implements DeadLetterQueue {
  private readonly items: DeadLetterItem[] = [];

  constructor(private readonly capacity = 1000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("invalid_dlq_capacity");
  }

  push(item: Omit<DeadLetterItem, "at">): void {
    this.items.push({ ...item, at: new Date().toISOString() });
    if (this.items.length > this.capacity) this.items.shift();
  }

  snapshot(): DeadLetterItem[] {
    return this.items.map(item => ({ ...item }));
  }
}
