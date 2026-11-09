// Monthly attendance reports (FR-4.1, FR-4.3): who may see what, and the data to aggregate.
import type { Scope } from '../../shared/types.js';
import type { ConfigReader, OrgUnit } from '../admin/index.js';
import { descendants, factoryOf } from '../admin/index.js';
import type { AttendanceQuery } from '../attendance/index.js';
import type { EmployeeRoster } from '../employee-qr/index.js';
import { inScope, isRestricted } from '../iam/index.js';
import type { UserRef } from '../iam/index.js';
import { departmentRows, employeeRows, factoryRows } from './reporting.aggregate.js';
import type { DepartmentRow, EmployeeRow, FactoryRow, ReportBy } from './reporting.aggregate.js';
import type { ReportMonth } from './reporting.month.js';
import { readMonth } from './reporting.source.js';

export interface ReportQuery {
  month: ReportMonth;
  by: ReportBy;
  /** One org unit (factory, department or team); undefined = everything the viewer may see. */
  scope?: Scope;
}

export type MonthlyReport =
  | { month: string; by: 'employee'; scope: Scope | null; suppressed: number; rows: EmployeeRow[] }
  | {
      month: string;
      by: 'department';
      scope: Scope | null;
      suppressed: number;
      rows: DepartmentRow[];
    }
  | { month: string; by: 'factory'; scope: Scope | null; suppressed: number; rows: FactoryRow[] };

/**
 * Smallest group an executive may see (FR-4.3, data minimisation): a department or factory row
 * with fewer employees is effectively one person's data, so it is left out for EXE.
 */
export const EXE_MIN_GROUP = 5;

/**
 * The narrowest org units to read so that every target is covered (employees carry only
 * factoryId and teamId): a factory or team is itself, a department is its teams. A team whose
 * factory is also queried is dropped, since the factory already covers it. Sorted, no duplicates.
 */
export const queryUnits = (units: readonly OrgUnit[], targets: readonly Scope[]): Scope[] => {
  const byId = new Map(units.map((u) => [u.id, u]));
  const picked = new Set<Scope>();
  for (const t of targets) {
    const unit = byId.get(t);
    if (unit?.kind === 'FACTORY' || unit?.kind === 'TEAM') picked.add(unit.id);
    else if (unit?.kind === 'DEPARTMENT') {
      for (const u of units) if (u.kind === 'TEAM' && u.parentId === unit.id) picked.add(u.id);
    }
  }
  return [...picked]
    .filter((id) => {
      const unit = byId.get(id);
      if (unit?.kind !== 'TEAM') return true;
      const factory = factoryOf(units, id);
      return !(factory && picked.has(factory.id));
    })
    .sort();
};

/** The viewer may not see this report (FR-4.3): out of scope, or per-employee rows for EXE. */
export class ReportForbiddenError extends Error {}
/** ?scope names no org unit. */
export class UnknownScopeError extends Error {}

export interface MonthlyReports {
  /** Throws ReportForbiddenError or UnknownScopeError. */
  monthly(viewer: UserRef, query: ReportQuery): Promise<MonthlyReport>;
}

/** Monthly attendance per employee, department or factory (FR-4.1, FR-4.3). */
export class MonthlyReportService implements MonthlyReports {
  constructor(
    private roster: EmployeeRoster,
    private attendance: Pick<AttendanceQuery, 'dailyRecords'>,
    private config: Pick<ConfigReader, 'orgUnits'>,
  ) {}

  async monthly(viewer: UserRef, { month, by, scope }: ReportQuery): Promise<MonthlyReport> {
    // FR-4.3: executives get totals, never a row per person.
    if (viewer.role === 'EXE' && by === 'employee') {
      throw new ReportForbiddenError('Executives see aggregates only');
    }
    const units = await this.config.orgUnits();

    let targets: Scope[];
    if (scope !== undefined) {
      // Scope check first, so a restricted user cannot probe which unit ids exist.
      if (isRestricted(viewer) && !inScope(viewer, scope)) {
        throw new ReportForbiddenError('Out of scope');
      }
      if (!units.some((u) => u.id === scope)) throw new UnknownScopeError(scope);
      targets = [scope];
    } else {
      // authenticate has already expanded the scopes to their descendants.
      targets = isRestricted(viewer)
        ? (viewer.scopes ?? [])
        : units.filter((u) => u.kind === 'FACTORY').map((u) => u.id);
    }
    const allowed = new Set(descendants(units, targets));

    // The narrowest units that cover the targets; the scope filter stays as defence in depth.
    const data = await readMonth(
      this.roster,
      this.attendance,
      queryUnits(units, targets),
      month.range,
    );
    const employees = data.employees.filter(
      (e) => allowed.has(e.factoryId) || (e.teamId !== null && allowed.has(e.teamId)),
    );

    const rows = employeeRows(employees, data.records, units);
    const base = { month: month.month, scope: scope ?? null };
    const minGroup = viewer.role === 'EXE' ? EXE_MIN_GROUP : 0;
    if (by === 'department') {
      const all = departmentRows(rows, units);
      const kept = all.filter((r) => r.employees >= minGroup);
      return { ...base, by, suppressed: all.length - kept.length, rows: kept };
    }
    if (by === 'factory') {
      const all = factoryRows(rows, units);
      const kept = all.filter((r) => r.employees >= minGroup);
      return { ...base, by, suppressed: all.length - kept.length, rows: kept };
    }
    return { ...base, by, suppressed: 0, rows };
  }
}
