import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import { ReportingRepo } from './reporting.repo.js';
import type { ExportRun } from './reporting.runs.js';

const at = new Date('2026-11-01T00:00:00Z');
const stale = new Date('2026-10-31T23:00:00Z');
const row: ExportRun = {
  month: '2026-10',
  status: 'RUNNING',
  trigger: 'SCHEDULE',
  attempts: 0,
  lastError: null,
  startedAt: at,
  finishedAt: null,
};
const fresh = (trigger: string) => ({
  status: 'RUNNING',
  trigger,
  attempts: 0,
  lastError: null,
  startedAt: at,
  finishedAt: null,
});

const repoWith = (exportRun: Record<string, unknown>) =>
  new ReportingRepo({ exportRun } as unknown as PrismaClient);

describe('ReportingRepo', () => {
  it('find reads the row by month', async () => {
    const findUnique = vi.fn().mockResolvedValue({ ...row, extra: 1 });
    expect(await repoWith({ findUnique }).find('2026-10')).toEqual(row);
    expect(findUnique).toHaveBeenCalledWith({ where: { month: '2026-10' } });
    findUnique.mockResolvedValue(null);
    expect(await repoWith({ findUnique }).find('2026-10')).toBeNull();
  });

  it('claim creates a RUNNING row for a new month', async () => {
    const create = vi.fn().mockResolvedValue(row);
    const updateMany = vi.fn();
    expect(await repoWith({ create, updateMany }).claim('2026-10', 'SCHEDULE', at, stale)).toEqual(
      row,
    );
    expect(create).toHaveBeenCalledWith({ data: { month: '2026-10', ...fresh('SCHEDULE') } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('on P2002 the schedule takes over only a BLOCKED or stale RUNNING row', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002' });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(row);
    const claimed = await repoWith({ create, updateMany, findUnique }).claim(
      '2026-10',
      'SCHEDULE',
      at,
      stale,
    );
    expect(claimed).toEqual(row);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        month: '2026-10',
        OR: [{ status: { in: ['BLOCKED'] } }, { status: 'RUNNING', startedAt: { lt: stale } }],
      },
      data: fresh('SCHEDULE'),
    });
  });

  it('on P2002 a manual claim may also restart FAILED and DONE', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002' });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(row);
    await repoWith({ create, updateMany, findUnique }).claim('2026-10', 'MANUAL', at, stale);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        month: '2026-10',
        OR: [
          { status: { in: ['BLOCKED', 'FAILED', 'DONE'] } },
          { status: 'RUNNING', startedAt: { lt: stale } },
        ],
      },
      data: fresh('MANUAL'),
    });
  });

  it('returns null when the conditional update matched nothing', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002' });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();
    expect(
      await repoWith({ create, updateMany, findUnique }).claim('2026-10', 'SCHEDULE', at, stale),
    ).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rethrows other errors', async () => {
    const boom = new Error('down');
    const create = vi.fn().mockRejectedValue(boom);
    const updateMany = vi.fn();
    await expect(
      repoWith({ create, updateMany }).claim('2026-10', 'SCHEDULE', at, stale),
    ).rejects.toBe(boom);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('finish updates only the run it claimed and returns the stored row', async () => {
    const done = { ...row, status: 'FAILED' as const, attempts: 4, lastError: 'x', finishedAt: at };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(done);
    const result = { status: 'FAILED', attempts: 4, lastError: 'x', at } as const;
    expect(await repoWith({ updateMany, findUnique }).finish('2026-10', at, result)).toEqual(done);
    expect(updateMany).toHaveBeenCalledWith({
      where: { month: '2026-10', status: 'RUNNING', startedAt: at },
      data: { status: 'FAILED', attempts: 4, lastError: 'x', finishedAt: at },
    });
  });

  it('finish returns null when another run took the month over', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();
    const result = { status: 'DONE', attempts: 1, lastError: null, at } as const;
    expect(await repoWith({ updateMany, findUnique }).finish('2026-10', at, result)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
