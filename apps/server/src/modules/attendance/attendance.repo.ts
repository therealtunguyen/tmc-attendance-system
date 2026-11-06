import type { PrismaClient } from '../../shared/prisma.js';
import type { AttendanceStore, ScanOutcome, StoredEvent } from './attendance.service.js';

/** Owns: AttendanceEvent, DailyRecord, Correction. */
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
