// Outbox: push committed events to the server, retry until confirmed (#27).
// No events are lost: they stay in SQLite until the server echoes their eventId back.
// No duplicates: the server inserts by eventId (FR-3.2 idempotency), so retries are safe.
import type { EdgeEvent, PushEventsRequest } from '../../server/src/shared/contracts/edge.js';
import type { Db, LocalEvent } from './db.js';
import type { ServerClient } from './server-client.js';

const toEdgeEvent = (e: LocalEvent): EdgeEvent => ({
  eventId: e.eventId,
  gateId: e.gateId,
  employeeId: e.employeeId,
  method: e.method,
  outcome: e.outcome,
  occurredAt: e.occurredAt,
  jti: e.jti,
  stale: e.stale === 1,
});

/**
 * One outbox flush: fetch unpushed events, POST them to the server, mark confirmed ones.
 * Returns the number of events confirmed in this run (useful for tests).
 */
export const flushOutbox = async (
  db: Db,
  client: ServerClient,
  edgeId: string,
): Promise<number> => {
  const pending = db.unpushedEvents();
  if (pending.length === 0) return 0;

  const req: PushEventsRequest = {
    edgeId,
    events: pending.map(toEdgeEvent),
  };

  const result = await client.pushEvents(req);
  if (!result.ok) {
    console.warn(`[outbox] push failed (${result.status}): ${result.error}`);
    return 0;
  }

  const accepted = new Set(result.data.accepted);
  let confirmed = 0;
  for (const event of pending) {
    if (accepted.has(event.eventId)) {
      db.markPushed(event.eventId);
      confirmed++;
    }
  }
  if (confirmed > 0) {
    console.log(`[outbox] confirmed ${confirmed}/${pending.length} events`);
  }
  return confirmed;
};

/** How many events are waiting in the outbox (for the heartbeat). */
export const outboxSize = (db: Db): number => db.unpushedEvents().length;

/**
 * Starts the outbox flush loop. Returns a cleanup function.
 * On network failure the loop retries every `intervalMs` (simple fixed retry — #27).
 */
export const startOutboxLoop = (
  db: Db,
  client: ServerClient,
  edgeId: string,
  intervalMs: number,
): (() => void) => {
  const id = setInterval(() => {
    void flushOutbox(db, client, edgeId);
  }, intervalMs);
  return () => clearInterval(id);
};
