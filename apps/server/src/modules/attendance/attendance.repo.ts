import { createHash } from 'node:crypto';
import type { EdgeDenyReason } from '../../shared/contracts/edge.js';
import type { PrismaClient } from '../../shared/prisma.js';
import type { DailyInput } from './attendance.daily.js';
import type {
  AccessLogQuery,
  AttendanceStore,
  Correction,
  ScanOutcome,
  StoredEvent,
} from './attendance.service.js';

/**
 * Oldest first. createdAt comes from the service clock and can tie, so seq (assigned by the
 * database on insert) decides: the order is always the order the corrections were stored in.
 */
const CORRECTION_ORDER = [{ createdAt: 'asc' as const }, { seq: 'asc' as const }];
const CORRECTION_OMIT = { id: true, seq: true } as const;

/** The longest one correction may hold its record: the reads, one insert and one audit append. */
const RECORD_LOCK_TIMEOUT_MS = 10_000;

/**
 * The advisory lock key of one daily record. Two records with the same hash only wait for each
 * other; they never fail.
 */
export const recordLockKey = (employeeId: string, day: Date): bigint =>
  createHash('sha256')
    .update(`attendance-record:${employeeId}:${day.toISOString()}`)
    .digest()
    .readBigInt64BE(0);

/** Owns: AttendanceEvent, Correction. Daily records are computed on read, so they have no table. */
export class AttendanceRepo implements AttendanceStore {
  constructor(private db: PrismaClient) {}

  async insert(event: StoredEvent): Promise<boolean> {
    // ON CONFLICT ("eventId") DO NOTHING: a repeated or racing insert is skipped, never an error.
    const { count } = await this.db.attendanceEvent.createMany({
      data: [event],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async insertMany(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    // One INSERT ... ON CONFLICT DO NOTHING: all new rows land together, duplicates are skipped.
    await this.db.attendanceEvent.createMany({ data: events, skipDuplicates: true });
  }

  grantedEvents(from: Date, to: Date, employeeIds?: string[]): Promise<DailyInput[]> {
    return this.db.attendanceEvent.findMany({
      where: {
        outcome: 'GRANTED',
        employeeId: employeeIds ? { in: employeeIds } : { not: null },
        occurredAt: { gte: from, lt: to },
      },
      select: { employeeId: true, occurredAt: true, outcome: true },
    });
  }

  grantedEventsOf(employeeId: string): Promise<DailyInput[]> {
    return this.db.attendanceEvent.findMany({
      where: { outcome: 'GRANTED', employeeId },
      select: { employeeId: true, occurredAt: true, outcome: true },
    });
  }

  corrections(from: Date, to: Date, employeeIds?: string[]): Promise<Correction[]> {
    return this.db.correction.findMany({
      where: {
        day: { gte: from, lt: to },
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      },
      orderBy: CORRECTION_ORDER,
      omit: CORRECTION_OMIT,
    });
  }

  correctionsOf(employeeId: string): Promise<Correction[]> {
    return this.db.correction.findMany({
      where: { employeeId },
      orderBy: CORRECTION_ORDER,
      omit: CORRECTION_OMIT,
    });
  }

  withRecordLock<T>(employeeId: string, day: Date, work: () => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        // Held until this transaction ends. `work` runs on other connections, and the lock still
        // keeps every other holder of the same key out until it is done.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${recordLockKey(employeeId, day)})`;
        return work();
      },
      { maxWait: RECORD_LOCK_TIMEOUT_MS, timeout: RECORD_LOCK_TIMEOUT_MS },
    );
  }

  async insertCorrection(correction: Correction): Promise<string> {
    const { id } = await this.db.correction.create({ data: correction, select: { id: true } });
    return id;
  }

  async deleteCorrection(id: string): Promise<void> {
    await this.db.correction.deleteMany({ where: { id } });
  }

  async decide(eventId: string, outcome: ScanOutcome): Promise<boolean> {
    // Conditional, so a decided outcome is never flipped by a late or concurrent call.
    const { count } = await this.db.attendanceEvent.updateMany({
      where: { eventId, outcome: { in: ['PENDING', outcome] } },
      data: { outcome },
    });
    return count === 1;
  }

  async outcomeOf(eventId: string): Promise<StoredEvent['outcome'] | null> {
    const row = await this.db.attendanceEvent.findUnique({
      where: { eventId },
      select: { outcome: true },
    });
    return row?.outcome ?? null;
  }

  async accessLog({ range, gateIds, outcome, limit }: AccessLogQuery): Promise<StoredEvent[]> {
    const rows = await this.db.attendanceEvent.findMany({
      where: {
        occurredAt: { gte: range.from, lt: range.to },
        ...(gateIds && { gateId: { in: [...gateIds] } }),
        ...(outcome && { outcome }),
      },
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'asc' }],
      take: limit,
      select: {
        eventId: true,
        employeeId: true,
        gateId: true,
        edgeId: true,
        method: true,
        guardId: true,
        reason: true,
        denyReason: true,
        outcome: true,
        jti: true,
        stale: true,
        occurredAt: true,
      },
    });
    // Written only through ingest and record(), which accept DENY_REASONS values only.
    return rows.map((row) => ({ ...row, denyReason: row.denyReason as EdgeDenyReason | null }));
  }
}
