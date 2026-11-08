import {
  DENY_REASONS,
  type EdgeDenyReason,
  type PushEventsRequest,
  type PushEventsResponse,
} from '../../shared/contracts/edge.js';
import { todo } from '../../shared/errors.js';
import type { DateRange, Scope } from '../../shared/types.js';
import type { EmployeeDirectory } from '../employee-qr/index.js';
import { buildDailyRecords, localDayStart, nextDay, type DailyInput } from './attendance.daily.js';

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
export interface StoredEvent extends Omit<ScanEvent, 'outcome' | 'denyReason'> {
  outcome: ScanOutcome | 'PENDING';
  denyReason: EdgeDenyReason | null;
  edgeId: string | null;
  jti: string | null;
  stale: boolean;
}

export interface DailyRecord {
  employeeId: string;
  day: Date;
  firstIn: Date | null;
  lastOut: Date | null;
  hours: number;
  missingPunch: boolean;
}

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
  /** Inserts every event whose eventId is new, in one atomic write; existing ones are skipped. */
  insertMany(events: StoredEvent[]): Promise<void>;
  /** GRANTED events with an employee, occurredAt in [from, to); only these employees if given. */
  grantedEvents(from: Date, to: Date, employeeIds?: string[]): Promise<DailyInput[]>;
  /** Sets the outcome only while it is PENDING or already equal; true if the row now has it. */
  decide(eventId: string, outcome: ScanOutcome): Promise<boolean>;
  /** Null when there is no such event. */
  outcomeOf(eventId: string): Promise<StoredEvent['outcome'] | null>;
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
  accessLog(range: DateRange): Promise<ScanEvent[]>;
}

/** Event store, daily records, missing punches, HR corrections (FR-1.6, FR-3.x). */
export class AttendanceService implements AttendanceRecorder, EdgeIngest, AttendanceQuery {
  constructor(
    private repo: AttendanceStore,
    private directory: EmployeeDirectory,
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
   * stale included. A known eventId is skipped, never updated (contract: shared/contracts/edge.ts).
   * TODO(#33): a skipped duplicate drops the edge's jti and stale, so a row first written PENDING by
   * record() never gets them; reconciliation must decide whether to merge them in.
   */
  async ingest({ edgeId, events }: PushEventsRequest): Promise<PushEventsResponse> {
    await this.repo.insertMany(
      events.map((e) => ({
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
      })),
    );
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
    return buildDailyRecords(await this.repo.grantedEvents(from, to, employeeIds));
  }

  async history(): Promise<DailyRecord[]> {
    return todo();
  }

  async accessLog(): Promise<ScanEvent[]> {
    return todo();
  }
}
