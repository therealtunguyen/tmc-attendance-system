// Outbox: push committed events to the server, retry until confirmed (#27).
// No events are lost: they stay in SQLite until the server echoes their eventId back.
// No duplicates: the server inserts by eventId (FR-3.2 idempotency), so retries are safe.
import type { EdgeEvent, PushEventsRequest } from '../../server/src/shared/contracts/edge.js';
import { MAX_PUSH_ATTEMPTS, OUTBOX_BATCH_LIMIT, type Db, type LocalEvent } from './db.js';
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
 * Flush unpushed events in batches (<= MAX_EDGE_BATCH) until drained or a push fails.
 * Guarded against overlapping runs on the same db.
 * Returns the total number of events confirmed in this run (useful for tests).
 */
export const flushOutbox = async (
  db: Db,
  client: ServerClient,
  edgeId: string,
): Promise<number> => {
  if (inFlight.has(db)) return 0;
  inFlight.add(db);
  const maxAttempts = db.maxPushAttempts ?? MAX_PUSH_ATTEMPTS;
  try {
    let totalConfirmed = 0;
    while (true) {
      const pending = db.unpushedEvents();
      if (pending.length === 0) break;

      const req: PushEventsRequest = {
        edgeId,
        events: pending.map(toEdgeEvent),
      };

      const result = await client.pushEvents(req);
      if (!result.ok) {
        console.warn(`[outbox] push failed (${result.status}): ${result.error}`);
        // Count attempts on 4xx client errors (e.g. 400 Bad Request due to a poison row)
        // so the invalid event eventually parks and stops blocking the outbox (#96).
        if (result.status >= 400 && result.status < 500) {
          for (const event of pending) {
            const attempts = db.recordRejected(event.eventId);
            const suffix =
              attempts >= maxAttempts
                ? ` (reached max ${maxAttempts} attempts; parking)`
                : ` (attempt ${attempts}/${maxAttempts})`;
            console.warn(`[outbox] event ${event.eventId} rejected with ${result.status}${suffix}`);
          }
        }
        break;
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
            attempts >= maxAttempts
              ? ` (reached max ${maxAttempts} attempts; parking)`
              : ` (attempt ${attempts}/${maxAttempts})`;
          console.warn(`[outbox] event ${event.eventId} omitted from accepted${suffix}`);
        }
      }
      totalConfirmed += confirmed;
      if (confirmed > 0) {
        console.log(`[outbox] confirmed ${confirmed}/${pending.length} events`);
      }
      // Stop if this was a partial final batch or nothing was accepted (avoid spinning on rejects).
      if (pending.length < OUTBOX_BATCH_LIMIT || confirmed === 0) break;
    }
    return totalConfirmed;
  } finally {
    inFlight.delete(db);
  }
};

/** How many events are waiting in the outbox (for the heartbeat). */
export const outboxSize = (db: Db): number => db.outboxCount();

/** Maximum backoff delay between flush retries (#96). */
export const OUTBOX_MAX_BACKOFF_MS = 60_000;

/**
 * Starts the outbox flush loop with backoff on repeated failures (#96).
 * Flushes once immediately on startup. Under normal conditions (progress made or
 * outbox empty), flushes run every `intervalMs`. On repeated failures (e.g. 4xx/5xx or network
 * disconnects), the delay doubles up to `maxBackoffMs`.
 * Returns a cleanup function.
 */
export const startOutboxLoop = (
  db: Db,
  client: ServerClient,
  edgeId: string,
  intervalMs: number,
  maxBackoffMs = OUTBOX_MAX_BACKOFF_MS,
): (() => void) => {
  let stopped = false;
  let running = false;
  let currentDelay = intervalMs;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    let ok = false;
    try {
      const confirmed = await flushOutbox(db, client, edgeId);
      // Succeeded if events were confirmed or nothing is waiting in unpushedEvents
      ok = confirmed > 0 || db.unpushedEvents().length === 0;
    } catch (err) {
      console.warn(`[outbox] flush failed: ${String(err)}`);
    } finally {
      running = false;
    }
    if (stopped) return;

    let delay = intervalMs;
    if (ok) {
      currentDelay = intervalMs;
    } else {
      delay = Math.min(currentDelay, maxBackoffMs);
      currentDelay = Math.min(Math.max(currentDelay * 2, intervalMs * 2), maxBackoffMs);
      console.warn(`[outbox] repeated failure, retrying in ${delay / 1000} s`);
    }
    timer = setTimeout(() => void tick(), delay);
  };

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
