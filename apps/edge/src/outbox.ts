// Outbox: push committed events to the server, retry until confirmed (#27).
// No events are lost: they stay in SQLite until the server echoes their eventId back.
// No duplicates: the server inserts by eventId (FR-3.2 idempotency), so retries are safe.
import type { EdgeEvent, PushEventsRequest } from '../../server/src/shared/contracts/edge.js';
import { MAX_PUSH_ATTEMPTS, type Db, type LocalEvent } from './db.js';
import type { ServerClient } from './server-client.js';

const inFlight = new WeakSet<Db>();

const toEdgeEvent = (e: LocalEvent): EdgeEvent => ({
  eventId: e.eventId,
  gateId: e.gateId,
  employeeId: e.employeeId,
  method: e.method,
  outcome: e.outcome,
  occurredAt: e.occurredAt,
  jti: e.jti,
  stale: e.stale === 1,
  ...(e.outcome === 'DENIED' && e.denyReason ? { denyReason: e.denyReason } : {}),
});

/**
 * One outbox flush: fetch unpushed events, POST them to the server, mark confirmed ones.
 * Guarded against overlapping runs on the same db.
 * Returns the number of events confirmed in this run (useful for tests).
 */
export const flushOutbox = async (
  db: Db,
  client: ServerClient,
  edgeId: string,
): Promise<number> => {
  if (inFlight.has(db)) return 0;
  inFlight.add(db);
  try {
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
      } else {
        const attempts = db.recordRejected(event.eventId);
        const suffix =
          attempts >= MAX_PUSH_ATTEMPTS
            ? ` (reached max ${MAX_PUSH_ATTEMPTS} attempts; parking)`
            : ` (attempt ${attempts}/${MAX_PUSH_ATTEMPTS})`;
        console.warn(`[outbox] event ${event.eventId} omitted from accepted${suffix}`);
      }
    }
    if (confirmed > 0) {
      console.log(`[outbox] confirmed ${confirmed}/${pending.length} events`);
    }
    return confirmed;
  } finally {
    inFlight.delete(db);
  }
};

/** How many events are waiting in the outbox (for the heartbeat). */
export const outboxSize = (db: Db): number => db.outboxCount();

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
