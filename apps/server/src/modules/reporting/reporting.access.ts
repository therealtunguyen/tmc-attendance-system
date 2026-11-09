// Security access log (FR-4.4): every scan, denied ones included.
import type { EdgeDenyReason } from '../../shared/contracts/edge.js';
import type { DateRange } from '../../shared/types.js';
import type { AccessOutcome, AttendanceQuery } from '../attendance/index.js';
import type { EmployeeRoster } from '../employee-qr/index.js';
import { isRestricted } from '../iam/index.js';
import type { UserRef } from '../iam/index.js';
import type { GateLookup } from './reporting.gates.js';

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
  guardId: string | null;
  overrideReason: string | null;
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
    private source: Pick<AttendanceQuery, 'accessLog'>,
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

    // No scope: an employee of another factory can scan at this gate. A lookup by ids would need a new
    // EmployeeRoster method; left for later.
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
        guardId: e.guardId ?? null,
        overrideReason: e.reason ?? null,
        employeeCode: person?.code ?? null,
        firstName: person?.firstName ?? null,
      };
    });
  }
}
