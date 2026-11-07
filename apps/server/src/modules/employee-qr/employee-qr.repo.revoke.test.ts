import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import { EmployeeQrRepo } from './employee-qr.repo.js';

const row = { id: 'e-1', qrRevoked: true };

const repoWith = (employee: Record<string, unknown>) =>
  new EmployeeQrRepo({ employee } as unknown as PrismaClient);

describe('EmployeeQrRepo.setQrRevoked (FR-1.4, FR-1.5)', () => {
  it('revoking only touches a row that is not revoked yet', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(row);
    expect(await repoWith({ updateMany, findUnique }).setQrRevoked('e-1', true)).toBe(row);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e-1', qrRevoked: false },
      data: { qrRevoked: true },
    });
  });

  it('reissuing only touches a revoked row of an active employee', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(row);
    await repoWith({ updateMany, findUnique }).setQrRevoked('e-1', false);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e-1', qrRevoked: true, active: true },
      data: { qrRevoked: false },
    });
  });

  it('returns null when the row did not change', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();
    expect(await repoWith({ updateMany, findUnique }).setQrRevoked('e-1', true)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rethrows a database error', async () => {
    const down = new Error('down');
    const updateMany = vi.fn().mockRejectedValue(down);
    await expect(repoWith({ updateMany }).setQrRevoked('e-1', true)).rejects.toBe(down);
  });
});
