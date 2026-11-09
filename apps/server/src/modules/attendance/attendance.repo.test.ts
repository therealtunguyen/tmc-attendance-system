import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import { AttendanceRepo } from './attendance.repo.js';

const select = {
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
};
const range = { from: new Date('2026-11-07T00:00:00Z'), to: new Date('2026-11-08T00:00:00Z') };

const repoWith = (rows: unknown[] = []) => {
  const findMany = vi.fn().mockResolvedValue(rows);
  const repo = new AttendanceRepo({ attendanceEvent: { findMany } } as unknown as PrismaClient);
  return { repo, findMany };
};

describe('AttendanceRepo.accessLog (FR-4.4)', () => {
  it('filters, orders and limits in one query', async () => {
    const { repo, findMany } = repoWith();
    await repo.accessLog({ range, gateIds: ['g1', 'g2'], outcome: 'DENIED', limit: 50 });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        occurredAt: { gte: range.from, lt: range.to },
        gateId: { in: ['g1', 'g2'] },
        outcome: 'DENIED',
      },
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'asc' }],
      take: 50,
      select,
    });
  });

  it('leaves gateId and outcome out of the filter when not given', async () => {
    const { repo, findMany } = repoWith();
    await repo.accessLog({ range, limit: 5 });
    const args = findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ occurredAt: { gte: range.from, lt: range.to } });
    expect(args.where).not.toHaveProperty('gateId');
    expect(args.where).not.toHaveProperty('outcome');
    expect(args.take).toBe(5);
  });

  it('returns the selected columns as StoredEvent, nulls kept', async () => {
    const row = {
      eventId: 'e-1',
      employeeId: null,
      gateId: 'g1',
      edgeId: 'edge-bd',
      method: 'MANUAL',
      guardId: null,
      reason: null,
      outcome: 'DENIED',
      jti: null,
      stale: false,
      occurredAt: range.from,
    };
    const { repo } = repoWith([row]);
    const [event] = await repo.accessLog({ range, limit: 1 });
    expect(event).toEqual(row);
    expect(event).not.toHaveProperty('id');
    expect(event).not.toHaveProperty('receivedAt');
  });
});
