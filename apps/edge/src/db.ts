// SQLite schema and prepared statements for the edge agent (ADR-9, #23).
// Uses better-sqlite3 (synchronous) — the scan flow is sequential so async adds nothing.
import Database from 'better-sqlite3';
import { join } from 'node:path';

export type Db = ReturnType<typeof openDb>;

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
  pushedAt: string | null; // ISO 8601, null = not yet pushed
}

/**
 * Opens (or creates) the SQLite database, runs the schema migration, and returns
 * a bag of prepared statements. `dataDir` is the directory that holds the .db file;
 * it must already exist (created by main.ts at startup).
 */
export const openDb = (dataDir: string) => {
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
      jti      TEXT    PRIMARY KEY,
      seen_at  INTEGER NOT NULL  -- Unix ms
    );

    -- Mirrors EdgeEvent; outcome starts PENDING (ADR-9, #24).
    CREATE TABLE IF NOT EXISTS scan_event (
      event_id    TEXT    PRIMARY KEY,
      gate_id     TEXT    NOT NULL,
      employee_id TEXT,
      method      TEXT    NOT NULL CHECK (method IN ('QR', 'MANUAL')),
      outcome     TEXT    NOT NULL CHECK (outcome IN ('PENDING', 'GRANTED', 'DENIED'))
                          DEFAULT 'PENDING',
      occurred_at TEXT    NOT NULL,
      jti         TEXT,
      stale       INTEGER NOT NULL DEFAULT 0,
      pushed_at   TEXT               -- NULL = still in outbox
    );
  `);

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

  // ── scan_event ──────────────────────────────────────────────────────────────
  const insertEvent = db.prepare<[Omit<LocalEvent, 'pushedAt'>]>(`
    INSERT INTO scan_event
      (event_id, gate_id, employee_id, method, outcome, occurred_at, jti, stale)
    VALUES
      (@eventId, @gateId, @employeeId, @method, @outcome, @occurredAt, @jti, @stale)
  `);

  const setOutcome = db.prepare<[{ eventId: string; outcome: 'GRANTED' | 'DENIED' }]>(
    'UPDATE scan_event SET outcome = @outcome WHERE event_id = @eventId',
  );

  const unpushedEvents = db.prepare<[], LocalEvent>(`
    SELECT event_id    AS eventId,
           gate_id     AS gateId,
           employee_id AS employeeId,
           method,
           outcome,
           occurred_at AS occurredAt,
           jti,
           stale,
           pushed_at   AS pushedAt
    FROM   scan_event
    WHERE  pushed_at IS NULL
    ORDER  BY occurred_at
    LIMIT  100
  `);

  const markPushed = db.prepare<[{ pushedAt: string; eventId: string }]>(
    'UPDATE scan_event SET pushed_at = @pushedAt WHERE event_id = @eventId',
  );

  /**
   * Atomically commit a scan event and record the jti (if any), after pruning
   * stale jti entries. Returns `false` when the jti was already seen (REPLAYED).
   */
  const commitScan = db.transaction(
    (event: Omit<LocalEvent, 'pushedAt'>, jtiTtlMs: number): boolean => {
      const now = Date.now();
      if (event.jti) {
        pruneJti.run(now - jtiTtlMs);
        const { changes } = insertJti.run(event.jti, now);
        if (changes === 0) return false; // jti already seen → REPLAYED
      }
      insertEvent.run(event);
      return true;
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
    setOutcome: (eventId: string, outcome: 'GRANTED' | 'DENIED'): void => {
      setOutcome.run({ eventId, outcome });
    },
    unpushedEvents: (): LocalEvent[] => unpushedEvents.all(),
    markPushed: (eventId: string): void => {
      markPushed.run({ pushedAt: new Date().toISOString(), eventId });
    },
    /** Exposed for tests: close and release the file lock. */
    close: () => db.close(),
  };
};
