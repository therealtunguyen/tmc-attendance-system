import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import { prismaOf } from '../../shared/transaction.js';
import type { EmployeeDirectory, EmployeeScopes } from '../employee-qr/index.js';
import type { AuditLog } from '../iam/index.js';
import { AttendanceRepo, recordLockKey } from './attendance.repo.js';
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
  const directory: EmployeeDirectory & EmployeeScopes = {
    find: async () => null,
    list: async () => [],
    scopesOf: async () => null,
  };
  // The access log writes no audit entry; the service only needs one to be constructed.
  const audit: AuditLog = { append: async () => {}, search: async () => [] };
  const serviceWith = () => {
    const { repo, findMany } = repoWith();
    return { service: new AttendanceService(repo, directory, audit), findMany };
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

describe('AttendanceRepo edge ingest (#33)', () => {
  const stored = {
    eventId: 'x-1',
    employeeId: 'emp-1',
    gateId: 'g1',
    method: 'QR' as const,
    occurredAt: range.from,
    outcome: 'GRANTED' as const,
    denyReason: null,
    edgeId: 'edge-bd',
    jti: 'jti-1',
    stale: true,
  };

  it('inserts in one statement that skips known eventIds and returns the new ones', async () => {
    const createManyAndReturn = vi.fn().mockResolvedValue([{ eventId: 'x-1' }]);
    const repo = new AttendanceRepo({
      attendanceEvent: { createManyAndReturn },
    } as unknown as PrismaClient);
    const events = [stored, { ...stored, eventId: 'x-2' }];
    expect(await repo.insertMany(events)).toEqual(['x-1']);
    expect(createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(createManyAndReturn).toHaveBeenCalledWith({
      data: events,
      skipDuplicates: true,
      select: { eventId: true },
    });
  });

  it('reads the uses of the given tokens, oldest first', async () => {
    const { repo, findMany } = repoWith([{ eventId: 'x-1', jti: 'jti-1' }]);
    expect(await repo.eventsWithJti(['jti-1', 'jti-2'])).toEqual([
      { eventId: 'x-1', jti: 'jti-1' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { jti: { in: ['jti-1', 'jti-2'] } },
      orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }],
      select: {
        eventId: true,
        employeeId: true,
        gateId: true,
        edgeId: true,
        outcome: true,
        occurredAt: true,
        jti: true,
      },
    });
  });

  it('an empty batch or token list never reaches the database', async () => {
    const repo = new AttendanceRepo({} as unknown as PrismaClient);
    expect(await repo.insertMany([])).toEqual([]);
    expect(await repo.eventsWithJti([])).toEqual([]);
  });
});

describe('AttendanceRepo corrections (FR-3.6)', () => {
  const day = new Date('2026-11-06T17:00:00Z');

  it('reads corrections oldest first, the insert order breaking a tie', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new AttendanceRepo({ correction: { findMany } } as unknown as PrismaClient);
    await repo.corrections(range.from, range.to, ['emp-1']);
    await repo.correctionsOf('emp-1');
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [args] of findMany.mock.calls) {
      expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { seq: 'asc' }]);
      expect(args.omit).toEqual({ id: true, seq: true });
    }
  });

  /** A client whose only connection is the transaction: the outer client has no query methods. */
  const lockedClient = () => {
    const steps: string[] = [];
    const $executeRaw = vi.fn(async (..._args: unknown[]) => {
      steps.push('lock');
      return 1;
    });
    const tx = {
      $executeRaw,
      correction: {
        findMany: vi.fn(async () => {
          steps.push('read');
          return [];
        }),
        create: vi.fn(async () => {
          steps.push('insert');
          return { id: 'c-1' };
        }),
      },
      attendanceEvent: { findMany: vi.fn(async () => []) },
    };
    const $transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx));
    const repo = new AttendanceRepo({ $transaction } as unknown as PrismaClient);
    return { repo, tx, steps, $executeRaw, $transaction };
  };

  it('runs the work in one transaction, after taking the lock of that record', async () => {
    const { repo, steps, $executeRaw, $transaction } = lockedClient();
    const result = await repo.withRecordLock('emp-1', day, async () => {
      steps.push('work');
      return 'done';
    });
    expect(result).toBe('done');
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(['lock', 'work']);
    expect($executeRaw.mock.calls[0]![1]).toBe(recordLockKey('emp-1', day));
  });

  it('gives the work a store and a transaction on that same connection', async () => {
    const { repo, tx, steps } = lockedClient();
    await repo.withRecordLock('emp-1', day, async (store, handle) => {
      expect(prismaOf(handle)).toBe(tx);
      await store.corrections(day, range.to, ['emp-1']);
      await store.grantedEvents(day, range.to, ['emp-1']);
      await store.insertCorrection({
        employeeId: 'emp-1',
        day,
        field: 'LAST_OUT',
        originalValue: null,
        correctedValue: range.to,
        reason: 'r',
        correctedBy: 'hr-1',
        createdAt: range.to,
      });
    });
    expect(steps).toEqual(['lock', 'read', 'insert']);
    expect(tx.attendanceEvent.findMany).toHaveBeenCalledTimes(1);
  });

  it('gives each record its own key, the same one every time', () => {
    expect(recordLockKey('emp-1', day)).toBe(recordLockKey('emp-1', new Date(day)));
    expect(recordLockKey('emp-1', day)).not.toBe(recordLockKey('emp-2', day));
    expect(recordLockKey('emp-1', day)).not.toBe(
      recordLockKey('emp-1', new Date('2026-11-07T17:00:00Z')),
    );
  });
});
