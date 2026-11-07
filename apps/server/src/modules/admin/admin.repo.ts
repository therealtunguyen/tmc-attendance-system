import type { PrismaClient } from '../../shared/prisma.js';
import type { OrgKind, OrgUnit } from './admin.org.js';
import { DuplicateOrgUnitError, type AdminStore } from './admin.service.js';

const columns = {
  id: true,
  kind: true,
  name: true,
  parentId: true,
  supervisorIds: true,
} as const;

/** The kind column is a plain string validated in code, so it is narrowed here. */
const toUnit = (row: Omit<OrgUnit, 'kind'> & { kind: string }): OrgUnit => ({
  ...row,
  kind: row.kind as OrgKind,
});

const errorCode = (e: unknown) => (e as { code?: unknown } | null)?.code;

/** Owns: OrgUnit, ConfigValue. */
export class AdminRepo implements AdminStore {
  constructor(private db: PrismaClient) {}

  async listOrgUnits(): Promise<OrgUnit[]> {
    const rows = await this.db.orgUnit.findMany({ orderBy: { id: 'asc' }, select: columns });
    return rows.map(toUnit);
  }

  async createOrgUnit(unit: OrgUnit): Promise<OrgUnit> {
    try {
      return toUnit(await this.db.orgUnit.create({ data: unit, select: columns }));
    } catch (e) {
      if (errorCode(e) === 'P2002') throw new DuplicateOrgUnitError(unit.id);
      throw e;
    }
  }

  async updateOrgUnit(
    id: string,
    changes: Partial<Pick<OrgUnit, 'name' | 'supervisorIds'>>,
  ): Promise<OrgUnit | null> {
    try {
      return toUnit(
        await this.db.orgUnit.update({ where: { id }, data: changes, select: columns }),
      );
    } catch (e) {
      if (errorCode(e) === 'P2025') return null;
      throw e;
    }
  }

  listConfig(): Promise<{ key: string; value: string }[]> {
    return this.db.configValue.findMany({ select: { key: true, value: true } });
  }

  async getConfig(key: string): Promise<string | undefined> {
    const row = await this.db.configValue.findUnique({ where: { key }, select: { value: true } });
    return row?.value;
  }

  async setConfig(key: string, value: string, updatedBy: string): Promise<void> {
    await this.db.configValue.upsert({
      where: { key },
      create: { key, value, updatedBy },
      update: { value, updatedBy },
    });
  }
}
