import type { PrismaClient } from '../../shared/prisma.js';

/** Owns: AttendanceEvent, DailyRecord, Correction. */
export class AttendanceRepo {
  constructor(private db: PrismaClient) {}
}
