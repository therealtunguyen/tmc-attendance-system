// Monthly attendance reports (FR-4.1, FR-4.3): who may see what, and the data to aggregate.
import type { Scope } from '../../shared/types.js';
import type { ConfigReader } from '../admin/index.js';
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
  | { month: string; by: 'employee'; scope: Scope | null; rows: EmployeeRow[] }
  | { month: string; by: 'department'; scope: Scope | null; rows: DepartmentRow[] }
  | { month: string; by: 'factory'; scope: Scope | null; rows: FactoryRow[] };

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

    const factoryIds = new Set<string>();
    for (const t of targets) {
      const factory = factoryOf(units, t);
      if (factory) factoryIds.add(factory.id);
    }
    const data = await readMonth(this.roster, this.attendance, [...factoryIds], month.range);
    const employees = data.employees.filter(
      (e) => allowed.has(e.factoryId) || (e.teamId !== null && allowed.has(e.teamId)),
    );

    const rows = employeeRows(employees, data.records, units);
    const base = { month: month.month, scope: scope ?? null };
    if (by === 'department') return { ...base, by, rows: departmentRows(rows, units) };
    if (by === 'factory') return { ...base, by, rows: factoryRows(rows, units) };
    return { ...base, by, rows };
  }
}
