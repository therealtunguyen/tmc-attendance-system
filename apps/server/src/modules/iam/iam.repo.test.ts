import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import { asTransaction } from '../../shared/transaction.js';
import { IamRepo } from './iam.repo.js';
import { IamService, type AuditEntry, type AuditStore } from './iam.service.js';

const entry: AuditEntry = {
  actorId: 'hr-1',
  action: 'ATTENDANCE_CORRECT',
  target: 'attendance:emp-1_2026-11-07',
  at: new Date('2026-11-07T10:00:00Z'),
};

/** One connection's worth of the audit table, recording what ran on it. */
const connection = (name: string, steps: string[]) => ({
  $executeRaw: vi.fn(async () => {
    steps.push(`${name}: lock`);
    return 1;
  }),
  auditEntry: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => {
      steps.push(`${name}: insert`);
      return {};
    }),
  },
});

describe('IamRepo.append (FR-4.9, ADR-2)', () => {
  it('commits the entry in a transaction of its own when no transaction is given', async () => {
    const steps: string[] = [];
    const own = connection('own', steps);
    const $transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(own));
    await new IamRepo({ $transaction } as unknown as PrismaClient).append(entry);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(['own: lock', 'own: insert']);
  });

  it("writes the entry in the caller's transaction, chain lock first, and opens none", async () => {
    const steps: string[] = [];
    const callers = connection('caller', steps);
    const $transaction = vi.fn();
    await new IamRepo({ $transaction } as unknown as PrismaClient).append(
      entry,
      asTransaction(callers as never),
    );
    expect($transaction).not.toHaveBeenCalled();
    expect(steps).toEqual(['caller: lock', 'caller: insert']);
  });
});

describe('IamService.append', () => {
  it('hands the transaction on to the store', async () => {
    const append = vi.fn(async () => {});
    const iam = new IamService({ append } as unknown as AuditStore & never);
    const tx = asTransaction({} as never);
    await iam.append(entry, tx);
    await iam.append(entry);
    expect(append.mock.calls).toEqual([
      [entry, tx],
      [entry, undefined],
    ]);
  });
});
