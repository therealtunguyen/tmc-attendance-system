import type { PrismaClient } from '../../shared/prisma.js';
import type { DailyInput } from './attendance.daily.js';
import type {
  AttendanceStore,
  Correction,
  ScanOutcome,
  StoredEvent,
} from './attendance.service.js';

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
      orderBy: { createdAt: 'asc' },
      omit: { id: true },
    });
  }

  correctionsOf(employeeId: string): Promise<Correction[]> {
    return this.db.correction.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'asc' },
      omit: { id: true },
    });
  }

  async insertCorrection(correction: Correction): Promise<void> {
    await this.db.correction.create({ data: correction });
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
}
