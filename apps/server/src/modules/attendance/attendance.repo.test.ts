import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import type { EmployeeDirectory } from '../employee-qr/index.js';
import { AttendanceRepo } from './attendance.repo.js';
import { AttendanceService } from './attendance.service.js';

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
    expect(findMany.mock.calls[0]![0].select.denyReason).toBe(true);
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
      denyReason: 'EXPIRED',
      outcome: 'DENIED',
      jti: null,
      stale: false,
      occurredAt: range.from,
    };
    const { repo } = repoWith([row]);
    const [event] = await repo.accessLog({ range, limit: 1 });
    expect(event).toEqual(row);
    expect(event?.denyReason).toBe('EXPIRED');
    expect(event).not.toHaveProperty('id');
    expect(event).not.toHaveProperty('receivedAt');
  });
});

describe('AttendanceService.accessLog over AttendanceRepo (FR-4.4)', () => {
  const directory: EmployeeDirectory = {
    find: async () => null,
    list: async () => [],
  };
  const serviceWith = () => {
    const { repo, findMany } = repoWith();
    return { service: new AttendanceService(repo, directory), findMany };
  };

  it('a normal query reaches findMany with take = limit and the repo where/orderBy', async () => {
    const { service, findMany } = serviceWith();
    await service.accessLog({ range, gateIds: ['g1'], outcome: 'GRANTED', limit: 25 });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        occurredAt: { gte: range.from, lt: range.to },
        gateId: { in: ['g1'] },
        outcome: 'GRANTED',
      },
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'asc' }],
      take: 25,
      select,
    });
  });

  it('an empty gateIds list or an inverted range never reaches findMany', async () => {
    const { service, findMany } = serviceWith();
    expect(await service.accessLog({ range, gateIds: [], limit: 10 })).toEqual([]);
    expect(
      await service.accessLog({ range: { from: range.to, to: range.from }, limit: 10 }),
    ).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('an invalid Date or a limit above the maximum rejects before findMany', async () => {
    const { service, findMany } = serviceWith();
    await expect(
      service.accessLog({ range: { from: new Date('nope'), to: range.to }, limit: 10 }),
    ).rejects.toThrow(RangeError);
    await expect(service.accessLog({ range, limit: 501 })).rejects.toThrow(RangeError);
    expect(findMany).not.toHaveBeenCalled();
  });
});
