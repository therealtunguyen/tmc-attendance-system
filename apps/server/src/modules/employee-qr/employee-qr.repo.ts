import type { PrismaClient } from '../../shared/prisma.js';
import type { Scope } from '../../shared/types.js';
import {
  DuplicateEmployeeCodeError,
  type Employee,
  type EmployeeChanges,
  type EmployeeStore,
  type NewEmployee,
} from './employee-qr.service.js';

const columns = {
  id: true,
  code: true,
  firstName: true,
  lastName: true,
  email: true,
  factoryId: true,
  teamId: true,
  active: true,
  qrRevoked: true,
} as const;

/** Prisma error codes: unique constraint failed, record to update not found. */
const errorCode = (e: unknown) => (e as { code?: unknown } | null)?.code;

/** Owns: Employee, QrCredential. */
export class EmployeeQrRepo implements EmployeeStore {
  constructor(private db: PrismaClient) {}

  async create(data: NewEmployee): Promise<Employee> {
    try {
      return await this.db.employee.create({ data, select: columns });
    } catch (e) {
      if (errorCode(e) === 'P2002') throw new DuplicateEmployeeCodeError(data.code);
      throw e;
    }
  }

  update(id: string, changes: EmployeeChanges): Promise<Employee | null> {
    return this.write(id, changes);
  }

  find(id: string): Promise<Employee | null> {
    return this.db.employee.findUnique({ where: { id }, select: columns });
  }

  list(scope?: Scope): Promise<Employee[]> {
    return this.db.employee.findMany({
      where: scope !== undefined ? { OR: [{ factoryId: scope }, { teamId: scope }] } : {},
      orderBy: { code: 'asc' },
      select: columns,
    });
  }

  async deactivate(id: string): Promise<Employee | null> {
    // Conditional, so of two concurrent deactivations only one changes the row.
    const { count } = await this.db.employee.updateMany({
      where: { id, OR: [{ active: true }, { qrRevoked: false }] },
      data: { active: false, qrRevoked: true },
    });
    return count ? this.find(id) : null;
  }

  private async write(
    id: string,
    data: EmployeeChanges & { active?: boolean; qrRevoked?: boolean },
  ): Promise<Employee | null> {
    try {
      return await this.db.employee.update({ where: { id }, data, select: columns });
    } catch (e) {
      if (errorCode(e) === 'P2025') return null;
      throw e;
    }
  }
}
