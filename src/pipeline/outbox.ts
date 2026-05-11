export interface OutboxEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
}

export type OutboxRelay = (event: OutboxEvent) => void | Promise<void>;

/**
 * Transactional outbox: producers append during the business transaction;
 * a relay publishes to Kafka later. This interface keeps the pipeline decoupled.
 */
export interface OutboxWriter {
  append(event: Omit<OutboxEvent, "occurredAt">): void;
  drain(): OutboxEvent[];
}

export class MemoryOutbox implements OutboxWriter {
  private readonly events: OutboxEvent[] = [];

  append(event: Omit<OutboxEvent, "occurredAt">): void {
    this.events.push({
      ...event,
      occurredAt: new Date().toISOString(),
    });
  }

  drain(): OutboxEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
