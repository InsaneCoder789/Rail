import type { Pool } from "pg";
import type { AuthenticatedViewer, EventStore, ServerEvent, SseClient } from "./types.js";

function isEventVisibleToWallet(event: { type?: string; payload?: Record<string, unknown> }, walletId: string): boolean {
  if (event.type === "system.error") {
    return false;
  }

  const payload = event.payload ?? {};
  const senderWalletId = typeof payload.senderWalletId === "string" ? payload.senderWalletId : undefined;
  const receiverWalletId = typeof payload.receiverWalletId === "string" ? payload.receiverWalletId : undefined;
  const walletPayloadId = typeof payload.walletId === "string" ? payload.walletId : undefined;

  return senderWalletId === walletId || receiverWalletId === walletId || walletPayloadId === walletId;
}

function normalizeEvent(event: ServerEvent): ServerEvent {
  return {
    type: event.type ?? "unknown",
    payload: event.payload ?? {},
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };
}

export function createEventStore(getPool: () => Pool | null): EventStore {
  const outboxEvents: ServerEvent[] = [];
  const sseClients = new Set<SseClient>();

  const broadcastEvent = (event: ServerEvent): void => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of sseClients) {
      try {
        if (!isEventVisibleToWallet(event, client.viewer.walletId)) {
          continue;
        }
        client.res.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const insertOutboxEvent = async (event: ServerEvent): Promise<void> => {
    const finalEvent = normalizeEvent(event);
    const pool = getPool();

    if (!pool) {
      outboxEvents.unshift(finalEvent);
      if (outboxEvents.length > 20) outboxEvents.pop();

      broadcastEvent(finalEvent);
      return;
    }

    try {
      await pool.query(
        `INSERT INTO outbox (type, payload, occurred_at)
         VALUES ($1, $2::jsonb, $3::timestamptz)`,
        [finalEvent.type, JSON.stringify(finalEvent.payload), finalEvent.occurredAt],
      );
    } catch (e) {
      console.error("outbox_db_error", e);
    }

    broadcastEvent(finalEvent);
  };

  const listOutboxEvents = async (limit = 20): Promise<ServerEvent[]> => {
    const pool = getPool();
    if (!pool) {
      return outboxEvents;
    }

    const res = await pool.query(
      `SELECT type, payload, occurred_at
       FROM outbox
       ORDER BY occurred_at DESC
       LIMIT $1`,
      [limit],
    );

    return res.rows.map((r: { type: string; payload: Record<string, unknown>; occurred_at: string }) => ({
      type: r.type,
      payload: r.payload,
      occurredAt: r.occurred_at,
    }));
  };

  return {
    broadcastEvent,

    emitSystemError(err, stage, txId) {
      const normalized: ServerEvent = {
        type: "system.error",
        payload: {
          name: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : "Unknown error",
          stage: stage ?? null,
          txId: txId ?? null,
        },
        occurredAt: new Date().toISOString(),
      };

      broadcastEvent(normalized);
      void insertOutboxEvent(normalized);
    },

    insertOutboxEvent,

    async listVisibleEvents(viewer: AuthenticatedViewer, limit = 20) {
      const events = await listOutboxEvents(Math.max(limit * 5, 50));
      return events.filter((evt) => isEventVisibleToWallet(evt, viewer.walletId)).slice(0, limit);
    },

    addSseClient(client) {
      sseClients.add(client);
    },

    removeSseClient(client) {
      sseClients.delete(client);
    },
  };
}
