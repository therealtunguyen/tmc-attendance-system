// Security access log (FR-4.4): every scan, denied ones included.
import type { EdgeDenyReason } from '../../shared/contracts/edge.js';
import type { DateRange } from '../../shared/types.js';
import type { EmployeeRoster } from '../employee-qr/index.js';
import { isRestricted } from '../iam/index.js';
import type { UserRef } from '../iam/index.js';
import type { GateLookup } from './reporting.gates.js';

export type AccessOutcome = 'GRANTED' | 'DENIED' | 'PENDING';

/** What Reporting asks Attendance for. Filters and the limit run in the database. */
export interface AccessLogQuery {
  /** occurredAt from range.from (inclusive) to range.to (exclusive). */
  range: DateRange;
  /** Only these gates; undefined = every gate. An empty list matches nothing. */
  gateIds?: readonly string[];
  outcome?: AccessOutcome;
  /** Newest first, at most this many. */
  limit: number;
}

/** One stored scan, as Attendance returns it. */
export interface AccessLogEvent {
  eventId: string;
  gateId: string;
  /** Null when the token did not verify. */
  employeeId: string | null;
  method: 'QR' | 'MANUAL';
  outcome: AccessOutcome;
  denyReason: EdgeDenyReason | null;
  occurredAt: Date;
}

/**
 * Implemented by Attendance (AttendanceQuery.accessLog, not built yet: still todo()). Reporting never
 * reads AttendanceEvent itself, so it states here what it needs.
 */
export interface AccessLogSource {
  accessLog(query: AccessLogQuery): Promise<AccessLogEvent[]>;
}

/** One line of the access log a guard sees (FR-4.4): no contact data, only the code and first name (NFR-4). */
export interface AccessLogRow {
  eventId: string;
  occurredAt: Date;
  gateId: string;
  gateName: string | null;
  factoryId: string | null;
  method: 'QR' | 'MANUAL';
  outcome: AccessOutcome;
  denyReason: EdgeDenyReason | null;
  employeeCode: string | null;
  firstName: string | null;
}

export interface AccessLogRequest {
  range: DateRange;
  gateId?: string;
  outcome?: AccessOutcome;
  limit: number;
}

/** ?gateId names a gate the viewer cannot see, or none at all (same answer, so ids cannot be probed). */
export class AccessLogGateNotFoundError extends Error {
  constructor() {
    super('Gate not found');
    this.name = 'AccessLogGateNotFoundError';
  }
}

export interface AccessLogReader {
  /** Throws AccessLogGateNotFoundError. */
  list(viewer: UserRef, request: AccessLogRequest): Promise<AccessLogRow[]>;
}

/** Security access log: every scan, denied ones included, limited to the viewer's factories (FR-4.4, BR-15). */
export class AccessLogService implements AccessLogReader {
  constructor(
    private source: AccessLogSource,
    private gateLookup: GateLookup,
    private roster: EmployeeRoster,
  ) {}

  async list(
    viewer: UserRef,
    { range, gateId, outcome, limit }: AccessLogRequest,
  ): Promise<AccessLogRow[]> {
    const restricted = isRestricted(viewer);
    const visible = await this.gateLookup.gates(restricted ? (viewer.scopes ?? []) : undefined);
    if (gateId !== undefined && !visible.some((g) => g.id === gateId)) {
      throw new AccessLogGateNotFoundError();
    }
    const gateIds =
      gateId !== undefined ? [gateId] : restricted ? visible.map((g) => g.id) : undefined;
    // An empty list must never turn into "every gate".
    if (gateIds?.length === 0) return [];

    const events = await this.source.accessLog({
      range,
      ...(gateIds !== undefined && { gateIds }),
      ...(outcome !== undefined && { outcome }),
      limit,
    });

    // No scope: an employee of another factory can scan at this gate.
    const people = new Map<string, { code: string; firstName: string }>();
    if (events.some((e) => e.employeeId !== null)) {
      for (const e of await this.roster.roster()) people.set(e.id, e);
    }
    const gates = new Map(visible.map((g) => [g.id, g]));

    return events.map((e) => {
      const gate = gates.get(e.gateId);
      const person = e.employeeId === null ? undefined : people.get(e.employeeId);
      return {
        eventId: e.eventId,
        occurredAt: e.occurredAt,
        gateId: e.gateId,
        gateName: gate?.name ?? null,
        factoryId: gate?.factoryId ?? null,
        method: e.method,
        outcome: e.outcome,
        denyReason: e.denyReason,
        employeeCode: person?.code ?? null,
        firstName: person?.firstName ?? null,
      };
    });
  }
}
