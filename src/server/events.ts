import type { Pool } from "pg";
import { RequestError } from "./http.js";
import type { EventStore, ServerEvent, SseClient } from "./types.js";

export function createEventStore(getPool: () => Pool | null): EventStore {
  const sseClients = new Set<SseClient>();
  const requirePool = (): Pool => {
    const pool = getPool();
    if (!pool) throw new RequestError(503, "event_store_unavailable", "durable event storage is required");
    return pool;
  };

  return {
    // Operational errors belong in server logs, not the customer delivery outbox.
    emitSystemError(err, stage, txId) {
      console.error("rail_system_error", {
        name: err instanceof Error ? err.name : "Error", stage: stage ?? null, txId: txId ?? null,
      });
    },

    async insertOutboxEvent(event) {
      // Never publish a notification when persistence failed. Financial events are
      // inserted by the payment transaction; streams read only committed rows.
      await requirePool().query(
        "INSERT INTO outbox (type, payload, occurred_at) VALUES ($1, $2::jsonb, $3::timestamptz)",
        [event.type, JSON.stringify(event.payload), event.occurredAt ?? new Date().toISOString()],
      );
    },

    async listVisibleEvents(viewer, limit = 20, before) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new RequestError(400, "invalid_event_limit", "event limit must be between 1 and 100");
      }
      if (before !== undefined && (!/^[1-9][0-9]{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)) {
        throw new RequestError(400, "invalid_event_cursor", "invalid event cursor");
      }
      const result = await requirePool().query(`
        SELECT id::text, type, payload, occurred_at FROM outbox
        WHERE type <> 'system.error'
          AND (payload->>'senderWalletId' = $1 OR payload->>'receiverWalletId' = $1 OR payload->>'walletId' = $1)
          AND ($3::bigint IS NULL OR id < $3::bigint)
        ORDER BY id DESC LIMIT $2`, [viewer.walletId, limit, before ?? null]);
      return result.rows.map((row): ServerEvent => ({
        id: row.id, type: row.type, payload: row.payload,
        occurredAt: new Date(row.occurred_at).toISOString(),
      }));
    },

    addSseClient(client) {
      if (sseClients.size >= 64 || [...sseClients].filter(current => current.viewer.walletId === client.viewer.walletId).length >= 2) {
        return false;
      }
      sseClients.add(client);
      return true;
    },

    removeSseClient(client) { sseClients.delete(client); },
  };
}
