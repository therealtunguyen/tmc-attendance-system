import type { PrismaClient } from '../../shared/prisma.js';

/** Owns: ExportRun. */
export class ReportingRepo {
  constructor(private db: PrismaClient) {}
}
