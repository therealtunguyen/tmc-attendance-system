import type { PrismaClient } from '../../shared/prisma.js';
import { RESTARTABLE } from './reporting.runs.js';
import type { ExportResult, ExportRun, ExportRunStore, ExportTrigger } from './reporting.runs.js';

const errorCode = (e: unknown) => (e as { code?: unknown } | null)?.code;

const toRun = (row: ExportRun): ExportRun => ({
  month: row.month,
  status: row.status,
  trigger: row.trigger,
  attempts: row.attempts,
  lastError: row.lastError,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

/** Owns: ExportRun. */
export class ReportingRepo implements ExportRunStore {
  constructor(private db: PrismaClient) {}

  async find(month: string): Promise<ExportRun | null> {
    const row = await this.db.exportRun.findUnique({ where: { month } });
    return row && toRun(row);
  }

  async claim(
    month: string,
    trigger: ExportTrigger,
    at: Date,
    staleBefore: Date,
  ): Promise<ExportRun | null> {
    const fresh = {
      status: 'RUNNING' as const,
      trigger,
      attempts: 0,
      lastError: null,
      startedAt: at,
      finishedAt: null,
    };
    try {
      return toRun(await this.db.exportRun.create({ data: { month, ...fresh } }));
    } catch (e) {
      if (errorCode(e) !== 'P2002') throw e;
    }
    // The row exists: take it over only from a state this trigger may restart, in one conditional write.
    const { count } = await this.db.exportRun.updateMany({
      where: {
        month,
        OR: [
          { status: { in: [...RESTARTABLE[trigger]] } },
          { status: 'RUNNING', startedAt: { lt: staleBefore } },
        ],
      },
      data: fresh,
    });
    return count === 0 ? null : this.find(month);
  }

  async finish(
    month: string,
    startedAt: Date,
    { status, attempts, lastError, at }: ExportResult,
  ): Promise<ExportRun | null> {
    const { count } = await this.db.exportRun.updateMany({
      where: { month, status: 'RUNNING', startedAt },
      data: { status, attempts, lastError, finishedAt: at },
    });
    return count === 0 ? null : this.find(month);
  }
}
