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

  push(item: Omit<DeadLetterItem, "at">): void {
    this.items.push({ ...item, at: new Date().toISOString() });
  }

  snapshot(): DeadLetterItem[] {
    return [...this.items];
  }
}
