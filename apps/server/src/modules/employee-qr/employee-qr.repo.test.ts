import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import { EmployeeQrRepo } from './employee-qr.repo.js';
import { DuplicateEmployeeCodeError, type NewEmployee } from './employee-qr.service.js';

const lan: NewEmployee = {
  code: 'BD-0001',
  firstName: 'Lan',
  lastName: 'Nguyen',
  email: 'lan@tmc.vn',
  factoryId: 'binh-duong',
  teamId: 'bd-line-1',
};
const row = { ...lan, id: 'e-1', active: true, qrRevoked: false };
const off = { ...row, active: false, qrRevoked: true };

const prismaError = (code: string) => Object.assign(new Error(code), { code });

/** Only the calls the repo makes, so a test states exactly what reaches Prisma. */
const repoWith = (employee: Record<string, unknown>) =>
  new EmployeeQrRepo({ employee } as unknown as PrismaClient);

describe('EmployeeQrRepo (FR-1.1, FR-1.5)', () => {
  it('create stores the data and selects the profile columns only', async () => {
    const create = vi.fn().mockResolvedValue(row);
    expect(await repoWith({ create }).create(lan)).toBe(row);
    const { data, select } = create.mock.calls[0][0];
    expect(data).toEqual(lan);
    expect(Object.keys(select).sort()).toEqual(
      [
        'active',
        'code',
        'email',
        'factoryId',
        'firstName',
        'id',
        'lastName',
        'qrRevoked',
        'teamId',
      ].sort(),
    );
  });

  it('create turns a unique violation into DuplicateEmployeeCodeError', async () => {
    const create = vi.fn().mockRejectedValue(prismaError('P2002'));
    await expect(repoWith({ create }).create(lan)).rejects.toBeInstanceOf(
      DuplicateEmployeeCodeError,
    );
  });

  it('create rethrows any other database error', async () => {
    const down = prismaError('P1001');
    const create = vi.fn().mockRejectedValue(down);
    await expect(repoWith({ create }).create(lan)).rejects.toBe(down);
  });

  it('update returns the row, or null when there is no such employee', async () => {
    const update = vi.fn().mockResolvedValueOnce(row).mockRejectedValueOnce(prismaError('P2025'));
    const repo = repoWith({ update });
    expect(await repo.update('e-1', { lastName: 'Tran' })).toBe(row);
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: 'e-1' },
      data: { lastName: 'Tran' },
    });
    expect(await repo.update('nope', { lastName: 'Tran' })).toBeNull();
  });

  it('update rethrows any other database error', async () => {
    const down = prismaError('P1001');
    const update = vi.fn().mockRejectedValue(down);
    await expect(repoWith({ update }).update('e-1', {})).rejects.toBe(down);
  });

  it('find looks up by id', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    expect(await repoWith({ findUnique }).find('nope')).toBeNull();
    expect(findUnique.mock.calls[0][0]).toMatchObject({ where: { id: 'nope' } });
  });

  it('list without a scope returns everyone, ordered by code', async () => {
    const findMany = vi.fn().mockResolvedValue([row]);
    expect(await repoWith({ findMany }).list()).toEqual([row]);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: {}, orderBy: { code: 'asc' } });
  });

  it.each(['binh-duong', ''])('list with scope %j filters by factory or team', async (scope) => {
    const findMany = vi.fn().mockResolvedValue([]);
    await repoWith({ findMany }).list(scope);
    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [{ factoryId: scope }, { teamId: scope }],
    });
  });

  it('deactivate writes conditionally and returns the updated row', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(off);
    expect(await repoWith({ updateMany, findUnique }).deactivate('e-1')).toBe(off);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e-1', OR: [{ active: true }, { qrRevoked: false }] },
      data: { active: false, qrRevoked: true },
    });
  });

  it('deactivate returns null when the row did not change', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();
    expect(await repoWith({ updateMany, findUnique }).deactivate('e-1')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
