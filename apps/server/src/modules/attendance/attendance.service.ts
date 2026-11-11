import {
  DENY_REASONS,
  type EdgeDenyReason,
  type PushEventsRequest,
  type PushEventsResponse,
} from '../../shared/contracts/edge.js';
import type { DateRange, Scope } from '../../shared/types.js';
import type { EmployeeDirectory, EmployeeScopes } from '../employee-qr/index.js';
import type { AuditLog } from '../iam/index.js';
import {
  buildDailyRecords,
  localDayStart,
  nextDay,
  parseRecordId,
  recordIdOf,
  type DailyInput,
} from './attendance.daily.js';

const MAX_REASON_LENGTH = 500;

export type ScanOutcome = 'GRANTED' | 'DENIED';

export interface ScanEvent {
  eventId: string;
  employeeId: string | null;
  gateId: string;
  method: 'QR' | 'MANUAL';
  guardId?: string;
  reason?: string;
  occurredAt: Date;
  /**
   * Outcome at commit time (ADR-3): PENDING (default) before the TCS call, or DENIED when the
   * QR failed validation, so the TCS call is skipped (report Figure 5.2). GRANTED only comes
   * from setOutcome(), after the gate opened.
   */
  outcome?: 'PENDING' | 'DENIED';
  /** Why the scan was denied, for the security access log (FR-4.4). Only with outcome DENIED. */
  denyReason?: EdgeDenyReason;
}

/** A row in AttendanceEvent. Edge ingest (#32) fills the extra fields; record() leaves the defaults. */
export interface StoredEvent extends Omit<
  ScanEvent,
  'outcome' | 'denyReason' | 'guardId' | 'reason'
> {
  /** Null when read back from the database without a value. */
  guardId?: string | null;
  reason?: string | null;
  outcome: ScanOutcome | 'PENDING';
  denyReason: EdgeDenyReason | null;
  edgeId: string | null;
  jti: string | null;
  stale: boolean;
}

export type AccessOutcome = StoredEvent['outcome']; // 'GRANTED' | 'DENIED' | 'PENDING'

/** One stored use of a QR token: what reconciliation needs to compare edges (ADR-10). */
export type JtiSighting = Pick<
  StoredEvent,
  'eventId' | 'employeeId' | 'gateId' | 'edgeId' | 'outcome' | 'occurredAt' | 'jti'
>;

/** Checks what an edge decided on its own against what the server knows (ADR-9, ADR-10). */
export interface SyncReconciliation {
  /**
   * `stored` are the events one push has just added. Never rejects: the events are already
   * stored, so a failed check must not make the edge send them again.
   */
  reconcile(edgeId: string, stored: StoredEvent[]): Promise<void>;
}

/** FR-4.4: one page of the access log holds at most this many rows; callers page by time. */
export const ACCESS_LOG_MAX_LIMIT = 500;

/** HR opens at most this many days of one employee's records at a time: a quarter. */
export const MAX_RECORDS_RANGE_DAYS = 92;

/** What the security access log asks for (FR-4.4). Filters, order and limit run in the database. */
export interface AccessLogQuery {
  /** occurredAt from range.from (inclusive) to range.to (exclusive). */
  range: DateRange;
  /** Only these gates; undefined = every gate. An empty list matches nothing. */
  gateIds?: readonly string[];
  outcome?: AccessOutcome;
  /** Newest first, at most this many rows (an integer from 1 to ACCESS_LOG_MAX_LIMIT). */
  limit: number;
}

export interface DailyRecord {
  employeeId: string;
  day: Date;
  firstIn: Date | null;
  lastOut: Date | null;
  hours: number;
  missingPunch: boolean;
  /** Present and true when HR changed a value of this day (FR-3.6). */
  corrected?: boolean;
}

export type CorrectionField = 'FIRST_IN' | 'LAST_OUT';

/** One HR change to a daily record (FR-3.6). Only added, never changed or deleted. */
export interface Correction {
  employeeId: string;
  /** The Vietnam local day start of the record. */
  day: Date;
  field: CorrectionField;
  /** The value just before this correction; null when the day had no last out. */
  originalValue: Date | null;
  correctedValue: Date;
  reason: string;
  /** The HR user. */
  correctedBy: string;
  createdAt: Date;
}

export interface CorrectionRequest {
  field: CorrectionField;
  value: Date;
  reason: string;
}

/** The daily record does not exist: a bad ID, or a day with no granted scan (UC-8 precondition). */
export class RecordNotFoundError extends Error {
  constructor(readonly recordId: string) {
    super(`No daily record ${recordId}`);
  }
}

/** The correction breaks a rule, so nothing was stored. The message says which, for HR. */
export class InvalidCorrectionError extends Error {}

/** setOutcome() for an eventId that was never recorded. */
export class UnknownEventError extends Error {
  constructor(readonly eventId: string) {
    super(`No attendance event ${eventId}`);
  }
}

/** setOutcome() would change an outcome already decided (GRANTED <-> DENIED). */
export class OutcomeConflictError extends Error {
  constructor(
    readonly eventId: string,
    readonly current: ScanOutcome,
  ) {
    super(`Attendance event ${eventId} is already ${current}`);
  }
}

/** Storage the service needs. The Prisma repo implements it; tests use an in-memory one. */
export interface AttendanceStore {
  /** Inserts unless the eventId exists; true if inserted. Must be atomic (two racing inserts -> one true). */
  insert(event: StoredEvent): Promise<boolean>;
  /**
   * Inserts every event whose eventId is new, in one atomic write; existing ones are skipped.
   * Returns the eventIds this call stored.
   */
  insertMany(events: StoredEvent[]): Promise<string[]>;
  /** Every stored event that carries one of these token IDs, oldest first. */
  eventsWithJti(jtis: string[]): Promise<JtiSighting[]>;
  /** GRANTED events with an employee, occurredAt in [from, to); only these employees if given. */
  grantedEvents(from: Date, to: Date, employeeIds?: string[]): Promise<DailyInput[]>;
  /** Every GRANTED event of one employee, whatever the date. */
  grantedEventsOf(employeeId: string): Promise<DailyInput[]>;
  /** Corrections of the days in [from, to), oldest first; only these employees if given. */
  corrections(from: Date, to: Date, employeeIds?: string[]): Promise<Correction[]>;
  /** Every correction of one employee, oldest first. */
  correctionsOf(employeeId: string): Promise<Correction[]>;
  /**
   * Runs `work` while holding the lock of one daily record: two calls for the same employee and
   * day never overlap, so each one validates against what the other stored. Other records do
   * not wait.
   */
  withRecordLock<T>(employeeId: string, day: Date, work: () => Promise<T>): Promise<T>;
  /** Returns the ID of the new row. */
  insertCorrection(correction: Correction): Promise<string>;
  /** Only to undo a correction whose audit entry could not be written. */
  deleteCorrection(id: string): Promise<void>;
  /** Sets the outcome only while it is PENDING or already equal; true if the row now has it. */
  decide(eventId: string, outcome: ScanOutcome): Promise<boolean>;
  /** Null when there is no such event. */
  outcomeOf(eventId: string): Promise<StoredEvent['outcome'] | null>;
  /** Every scan matching the query, denied ones included, newest first by occurredAt then eventId ascending; rows as stored. */
  accessLog(query: AccessLogQuery): Promise<StoredEvent[]>;
}

export interface AttendanceRecorder {
  /**
   * Idempotent by eventId (FR-3.2). Returns false if the event already exists.
   * Stored as PENDING, or DENIED if event.outcome says validation failed (ADR-3).
   */
  record(event: ScanEvent): Promise<boolean>;
  /**
   * PENDING -> GRANTED/DENIED once the turnstile answered. Repeating the same outcome is a no-op.
   * Throws UnknownEventError, or OutcomeConflictError if a different outcome is already set.
   */
  setOutcome(eventId: string, outcome: ScanOutcome): Promise<void>;
}

export interface EdgeIngest {
  /**
   * Stores events pushed by an edge outbox with edgeId and the server's receivedAt (ADR-9).
   * Idempotent by eventId: duplicates are skipped but still listed in `accepted`.
   */
  ingest(req: PushEventsRequest): Promise<PushEventsResponse>;
}

export interface AttendanceQuery {
  dailyRecords(range: DateRange, scope: Scope): Promise<DailyRecord[]>;
  history(employeeId: string): Promise<DailyRecord[]>;
  /** Every scan, denied ones included, newest first by occurredAt then eventId ascending; rows as stored. */
  accessLog(query: AccessLogQuery): Promise<StoredEvent[]>;
}

/** Event store, daily records, missing punches, HR corrections (FR-1.6, FR-3.x). */
export class AttendanceService implements AttendanceRecorder, EdgeIngest, AttendanceQuery {
  constructor(
    private repo: AttendanceStore,
    private directory: EmployeeDirectory & EmployeeScopes,
    private audit: AuditLog,
    private now: () => Date = () => new Date(),
    private reconciliation: SyncReconciliation = { reconcile: async () => {} },
  ) {}

  /**
   * Commits the scan before the turnstile is called (ADR-3, Figure 5.2): PENDING, or DENIED
   * straight away when validation failed.
   */
  async record(event: ScanEvent): Promise<boolean> {
    const { eventId, employeeId, gateId, method, occurredAt, outcome = 'PENDING' } = event;
    if (method === 'MANUAL' && (event.guardId !== undefined || event.reason !== undefined)) {
      if (!event.guardId?.trim() || !event.reason?.trim()) {
        throw new TypeError('MANUAL override requires guardId and reason');
      }
    }
    // A runtime guard: GRANTED at commit time would count an entry before the gate opened.
    if (outcome !== 'PENDING' && outcome !== 'DENIED') {
      throw new TypeError(`record() takes outcome PENDING or DENIED, got ${String(outcome)}`);
    }
    if (event.denyReason !== undefined) {
      if (outcome !== 'DENIED') throw new TypeError('denyReason requires outcome DENIED');
      if (!DENY_REASONS.includes(event.denyReason)) {
        throw new TypeError(`Unknown denyReason ${String(event.denyReason)}`);
      }
    }
    return this.repo.insert({
      eventId,
      employeeId,
      gateId,
      method,
      occurredAt,
      outcome,
      denyReason: event.denyReason ?? null,
      edgeId: null,
      jti: null,
      stale: false,
      ...(method === 'MANUAL' ? { guardId: event.guardId, reason: event.reason } : {}),
    });
  }

  async setOutcome(eventId: string, outcome: ScanOutcome): Promise<void> {
    if (await this.repo.decide(eventId, outcome)) return;
    const current = await this.repo.outcomeOf(eventId);
    if (current === null) throw new UnknownEventError(eventId);
    // decide() refused, so current is the other final outcome.
    throw new OutcomeConflictError(eventId, current as ScanOutcome);
  }

  /**
   * The edge decided these scans locally (ADR-9), so each is stored as sent: outcome, jti and
   * stale included. A known eventId is skipped, never updated (contract: shared/contracts/edge.ts),
   * so the jti and stale of a skipped duplicate are not merged into the stored row.
   * Only the events this push added are reconciled (#33): a batch sent again raises no second alert.
   */
  async ingest({ edgeId, events }: PushEventsRequest): Promise<PushEventsResponse> {
    const rows: StoredEvent[] = events.map((e) => ({
      eventId: e.eventId,
      employeeId: e.employeeId,
      gateId: e.gateId,
      method: e.method,
      occurredAt: new Date(e.occurredAt),
      outcome: e.outcome,
      denyReason: e.denyReason ?? null,
      edgeId,
      jti: e.jti,
      stale: e.stale,
    }));
    const added = new Set(await this.repo.insertMany(rows));
    // delete() is true once per eventId, so a duplicate inside the batch counts once: the first, as stored.
    const stored = rows.filter((row) => added.delete(row.eventId));
    if (stored.length > 0) await this.reconciliation.reconcile(edgeId, stored);
    // New and duplicate alike: the server now holds every one, so the edge drops them all.
    return { accepted: [...new Set(events.map((e) => e.eventId))] };
  }

  /**
   * Daily records of the employees in `scope` (factory or team, via EmployeeDirectory) for every
   * Vietnam local day from range.from to range.to, both included. Computed from the granted
   * events on each read, so a late edge push is always reflected (FR-3.4, FR-3.5).
   */
  async dailyRecords(range: DateRange, scope: Scope): Promise<DailyRecord[]> {
    const employeeIds = (await this.directory.list(scope)).map((e) => e.id);
    if (employeeIds.length === 0) return [];
    const from = localDayStart(range.from);
    const to = nextDay(localDayStart(range.to));
    return this.build(from, to, employeeIds);
  }

  /** One employee's daily records, newest day first (FR-1.6, UC-3). */
  async history(employeeId: string): Promise<DailyRecord[]> {
    const [events, corrections] = await Promise.all([
      this.repo.grantedEventsOf(employeeId),
      this.repo.correctionsOf(employeeId),
    ]);
    return buildDailyRecords(events, corrections).reverse();
  }

  /** What HR opens to correct a day (UC-8 step 1), each record with its ID. Local days, both included. */
  async employeeRecords(
    employeeId: string,
    range: DateRange,
  ): Promise<(DailyRecord & { recordId: string })[]> {
    const from = localDayStart(range.from);
    const to = nextDay(localDayStart(range.to));
    const records = await this.build(from, to, [employeeId]);
    return records.map((record) => ({ ...record, recordId: recordIdOf(record) }));
  }

  /** Every correction of one daily record, oldest first: the original values stay visible. */
  async recordCorrections(recordId: string): Promise<Correction[]> {
    const key = parseRecordId(recordId);
    if (!key) throw new RecordNotFoundError(recordId);
    return this.repo.corrections(key.day, nextDay(key.day), [key.employeeId]);
  }

  /**
   * HR changes one value of a daily record, with a reason (FR-3.6, UC-8). The scans are not touched:
   * the correction is stored beside them, with the value it replaced. Returns the recomputed record.
   * The correction is stored first and then audited. The audit log belongs to the IAM module and
   * cannot share a transaction with this write, so if the audit append fails the correction is
   * deleted again and the error is rethrown: no unaudited change, and no audit entry for a change
   * that never happened.
   * Read, validate, store and audit all run under the lock of that one record, so two corrections
   * of the same day cannot both pass against the old state and leave first in after last out.
   */
  async correct(
    actorId: string,
    recordId: string,
    request: CorrectionRequest,
  ): Promise<DailyRecord> {
    const key = parseRecordId(recordId);
    if (!key) throw new RecordNotFoundError(recordId);
    const reason = request.reason.trim();
    if (!reason) throw new InvalidCorrectionError('reason is required');
    if (reason.length > MAX_REASON_LENGTH) {
      throw new InvalidCorrectionError(`reason must be at most ${MAX_REASON_LENGTH} characters`);
    }
    return this.repo.withRecordLock(key.employeeId, key.day, () =>
      this.correctLocked(actorId, recordId, key, { ...request, reason }),
    );
  }

  /** The body of correct(); the caller holds the lock of the record and has trimmed the reason. */
  private async correctLocked(
    actorId: string,
    recordId: string,
    { employeeId, day }: Pick<DailyRecord, 'employeeId' | 'day'>,
    { field, value, reason: trimmed }: CorrectionRequest,
  ): Promise<DailyRecord> {
    const to = nextDay(day);
    const [events, corrections] = await Promise.all([
      this.repo.grantedEvents(day, to, [employeeId]),
      this.repo.corrections(day, to, [employeeId]),
    ]);
    const [before] = buildDailyRecords(events, corrections);
    if (!before) throw new RecordNotFoundError(recordId);
    if (localDayStart(value).getTime() !== day.getTime()) {
      throw new InvalidCorrectionError('value must be on the day of the record');
    }
    const now = this.now();
    // A time that has not happened yet would add hours to an open shift (reports, HRS export).
    if (value.getTime() > now.getTime()) {
      throw new InvalidCorrectionError('value must not be in the future');
    }
    const firstIn = field === 'FIRST_IN' ? value : before.firstIn;
    const lastOut = field === 'LAST_OUT' ? value : before.lastOut;
    if (firstIn && lastOut && firstIn.getTime() >= lastOut.getTime()) {
      throw new InvalidCorrectionError('first in must be before last out');
    }

    const correction: Correction = {
      employeeId,
      day,
      field,
      originalValue: field === 'FIRST_IN' ? before.firstIn : before.lastOut,
      correctedValue: value,
      reason: trimmed,
      correctedBy: actorId,
      createdAt: now,
    };
    const [after] = buildDailyRecords(events, [...corrections, correction]);
    const id = await this.repo.insertCorrection(correction);
    try {
      await this.audit.append({
        actorId,
        action: 'ATTENDANCE_CORRECT',
        target: `attendance:${recordId}`,
        at: correction.createdAt,
        before,
        after: { ...after, field, reason: trimmed },
      });
    } catch (error) {
      // The caller must see the audit failure, so a failed undo is only logged, never rethrown.
      await this.repo.deleteCorrection(id).catch((undoError: unknown) => {
        console.error(
          `Correction ${id} is stored but not audited, and could not be removed`,
          undoError,
        );
      });
      throw error;
    }
    return after as DailyRecord;
  }

  /**
   * Whether the employee belongs to one of these factories or teams (BR-15). One lookup of the
   * employee's own factory and team, not a listing of every scope.
   */
  async inScopes(employeeId: string, scopes: Scope[]): Promise<boolean> {
    if (scopes.length === 0) return false;
    const own = await this.directory.scopesOf(employeeId);
    return own !== null && own.some((scope) => scopes.includes(scope));
  }

  /** The one path to a daily record, so reports, exports and the portal all see corrections. */
  private async build(from: Date, to: Date, employeeIds: string[]): Promise<DailyRecord[]> {
    const [events, corrections] = await Promise.all([
      this.repo.grantedEvents(from, to, employeeIds),
      this.repo.corrections(from, to, employeeIds),
    ]);
    return buildDailyRecords(events, corrections);
  }

  async accessLog(query: AccessLogQuery): Promise<StoredEvent[]> {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > ACCESS_LOG_MAX_LIMIT
    ) {
      throw new RangeError(`limit must be an integer from 1 to ${ACCESS_LOG_MAX_LIMIT}`);
    }
    const { range } = query;
    if (Number.isNaN(range.from.getTime()) || Number.isNaN(range.to.getTime())) {
      throw new RangeError('range.from and range.to must be valid dates');
    }
    if (query.gateIds?.length === 0) return [];
    if (range.to <= range.from) return [];
    return this.repo.accessLog(query);
  }
}
