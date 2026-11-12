// SQLite schema and prepared statements for the edge agent (ADR-9, #23).
// Uses better-sqlite3 (synchronous) — the scan flow is sequential so async adds nothing.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { EdgeDenyReason } from '../../server/src/shared/contracts/edge.js';

export type Db = ReturnType<typeof openDb>;

/** Maximum times an event rejected/omitted by a 200 server response is retried before moving on. */
export const MAX_PUSH_ATTEMPTS = 5;

/** Events per outbox batch (must stay <= MAX_EDGE_BATCH in shared/contracts/edge.ts). */
export const OUTBOX_BATCH_LIMIT = 100;

/** One committed scan event (before or after TCS call). */
export interface LocalEvent {
  eventId: string;
  gateId: string;
  employeeId: string | null;
  method: 'QR' | 'MANUAL';
  outcome: 'PENDING' | 'GRANTED' | 'DENIED';
  occurredAt: string; // ISO 8601, edge clock
  jti: string | null;
  stale: 0 | 1; // SQLite boolean
  denyReason: EdgeDenyReason | null;
  pushedAt: string | null; // ISO 8601, null = not yet pushed
  pushAttempts: number;
}

export type NewLocalEvent = Omit<LocalEvent, 'pushedAt' | 'pushAttempts'>;

export interface DbOptions {
  /**
   * Minimum age (seconds) before a PENDING row may be pushed by the outbox.
   * Must exceed the TCS timeout so an in-flight scan is not pushed as PENDING
   * before setOutcome runs, while a scan interrupted by a crash still syncs.
   */
  pendingGraceS?: number;
  maxPushAttempts?: number;
}

const ensureColumn = (db: Database.Database, table: string, column: string, ddl: string) => {
  const cols = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
};

/**
 * Opens (or creates) the SQLite database, runs the schema migration, and returns
 * a bag of prepared statements. `dataDir` is the directory that holds the .db file;
 * it must already exist (created by main.ts at startup).
 */
export const openDb = (dataDir: string, options: DbOptions = {}) => {
  const pendingGraceS = options.pendingGraceS ?? 5;
  const maxPushAttempts = options.maxPushAttempts ?? MAX_PUSH_ATTEMPTS;
  const pendingModifier = `-${pendingGraceS} seconds`;

  const db = new Database(join(dataDir, 'edge.db'));

  // WAL mode: readers never block writers, so the outbox loop and scan handler coexist safely.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- One row per jti seen; pruned when older than the token TTL + tolerance (ADR-10).
    CREATE TABLE IF NOT EXISTS jti_seen (
      jti           TEXT    PRIMARY KEY,
      seen_at       INTEGER NOT NULL, -- Unix ms
      replay_logged INTEGER NOT NULL DEFAULT 0
    );

    -- Mirrors EdgeEvent; outcome starts PENDING for admissible tokens (ADR-9, #24).
    CREATE TABLE IF NOT EXISTS scan_event (
      event_id      TEXT    PRIMARY KEY,
      gate_id       TEXT    NOT NULL,
      employee_id   TEXT,
      method        TEXT    NOT NULL CHECK (method IN ('QR', 'MANUAL')),
      outcome       TEXT    NOT NULL CHECK (outcome IN ('PENDING', 'GRANTED', 'DENIED'))
                            DEFAULT 'PENDING',
      occurred_at   TEXT    NOT NULL,
      jti           TEXT,
      stale         INTEGER NOT NULL DEFAULT 0,
      deny_reason   TEXT,
      pushed_at     TEXT,              -- NULL = still in outbox
      push_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Safe incremental column additions for existing local edge.db files.
  ensureColumn(db, 'jti_seen', 'replay_logged', 'replay_logged INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'scan_event', 'deny_reason', 'deny_reason TEXT');
  ensureColumn(db, 'scan_event', 'push_attempts', 'push_attempts INTEGER NOT NULL DEFAULT 0');

  // ── kv helpers ──────────────────────────────────────────────────────────────
  const getKv = db.prepare<[string], { value: string }>('SELECT value FROM kv WHERE key = ?');
  const setKv = db.prepare<[string, string]>(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  // ── jti_seen ────────────────────────────────────────────────────────────────
  const pruneJti = db.prepare<[number]>('DELETE FROM jti_seen WHERE seen_at < ?');
  const insertJti = db.prepare<[string, number]>(
    'INSERT OR IGNORE INTO jti_seen (jti, seen_at) VALUES (?, ?)',
  );
  const markReplayLogged = db.prepare<[string]>(
    'UPDATE jti_seen SET replay_logged = 1 WHERE jti = ? AND replay_logged = 0',
  );

  // ── scan_event ──────────────────────────────────────────────────────────────
  const insertEvent = db.prepare<[NewLocalEvent]>(`
    INSERT INTO scan_event
      (event_id, gate_id, employee_id, method, outcome, occurred_at, jti, stale, deny_reason)
    VALUES
      (@eventId, @gateId, @employeeId, @method, @outcome, @occurredAt, @jti, @stale, @denyReason)
  `);

  const setOutcome = db.prepare<[{ eventId: string; outcome: 'GRANTED' | 'DENIED' }]>(
    'UPDATE scan_event SET outcome = @outcome WHERE event_id = @eventId AND pushed_at IS NULL',
  );

  const getEvent = db.prepare<[string], LocalEvent>(`
    SELECT event_id      AS eventId,
           gate_id       AS gateId,
           employee_id   AS employeeId,
           method,
           outcome,
           occurred_at   AS occurredAt,
           jti,
           stale,
           deny_reason   AS denyReason,
           pushed_at     AS pushedAt,
           push_attempts AS pushAttempts
    FROM   scan_event
    WHERE  event_id = ?
  `);

  // Exclude in-flight PENDING rows until pendingGraceS has elapsed (crash recovery),
  // and park rows that exceeded maxPushAttempts so stuck events cannot starve newer ones.
  const unpushedEvents = db.prepare<
    [{ maxAttempts: number; pendingModifier: string; batchLimit: number }],
    LocalEvent
  >(`
    SELECT event_id      AS eventId,
           gate_id       AS gateId,
           employee_id   AS employeeId,
           method,
           outcome,
           occurred_at   AS occurredAt,
           jti,
           stale,
           deny_reason   AS denyReason,
           pushed_at     AS pushedAt,
           push_attempts AS pushAttempts
    FROM   scan_event
    WHERE  pushed_at IS NULL
      AND  push_attempts < @maxAttempts
      AND  (outcome <> 'PENDING' OR occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', @pendingModifier))
    ORDER  BY push_attempts ASC, occurred_at ASC
    LIMIT  @batchLimit
  `);

  const countOutbox = db.prepare<[{ maxAttempts: number }], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM   scan_event
    WHERE  pushed_at IS NULL
      AND  push_attempts < @maxAttempts
  `);

  const markPushed = db.prepare<[{ pushedAt: string; eventId: string }]>(
    'UPDATE scan_event SET pushed_at = @pushedAt WHERE event_id = @eventId',
  );

  const incrementAttempts = db.prepare<[{ eventId: string }], { pushAttempts: number }>(
    'UPDATE scan_event SET push_attempts = push_attempts + 1 WHERE event_id = @eventId RETURNING push_attempts AS pushAttempts',
  );

  /**
   * Atomically commits a scan event and records the jti (if any), after pruning
   * stale jti entries.
   * When the jti was already seen within TTL: stores at most ONE REPLAYED denial
   * event for that jti, then returns `'REPLAYED'`.
   */
  const commitScan = db.transaction(
    (event: NewLocalEvent, jtiTtlMs: number): 'COMMITTED' | 'REPLAYED' => {
      const now = Date.now();
      if (event.jti) {
        pruneJti.run(now - jtiTtlMs);
        const { changes } = insertJti.run(event.jti, now);
        if (changes === 0) {
          // jti already seen → store only the first REPLAYED per jti as DENIED.
          const logged = markReplayLogged.run(event.jti);
          if (logged.changes > 0) {
            insertEvent.run({
              ...event,
              outcome: 'DENIED',
              denyReason: 'REPLAYED',
            });
          }
          return 'REPLAYED';
        }
      }
      insertEvent.run(event);
      return 'COMMITTED';
    },
  );

  return {
    // kv
    getKv: (key: string): string | null => getKv.get(key)?.value ?? null,
    setKv: (key: string, value: string): void => {
      setKv.run(key, value);
    },
    // jti (exposed for tests)
    pruneJti: (olderThanMs: number): void => {
      pruneJti.run(olderThanMs);
    },
    // scan_event
    commitScan,
    setOutcome: (eventId: string, outcome: 'GRANTED' | 'DENIED'): boolean => {
      const { changes } = setOutcome.run({ eventId, outcome });
      if (changes === 0) {
        console.error(
          `[db] setOutcome(${eventId}, ${outcome}) updated 0 rows (already pushed or missing; see #33)`,
        );
        return false;
      }
      return true;
    },
    getEvent: (eventId: string): LocalEvent | null => getEvent.get(eventId) ?? null,
    unpushedEvents: (): LocalEvent[] =>
      unpushedEvents.all({
        maxAttempts: maxPushAttempts,
        pendingModifier,
        batchLimit: OUTBOX_BATCH_LIMIT,
      }),
    outboxCount: (): number => countOutbox.get({ maxAttempts: maxPushAttempts })?.count ?? 0,
    markPushed: (eventId: string): void => {
      markPushed.run({ pushedAt: new Date().toISOString(), eventId });
    },
    recordRejected: (eventId: string): number =>
      incrementAttempts.get({ eventId })?.pushAttempts ?? maxPushAttempts,
    /** Exposed for tests: close and release the file lock. */
    close: () => db.close(),
  };
};
