// Report aggregation (FR-4.1, FR-4.3). Pure: no I/O, so it is tested alone.
import type { OrgUnit } from '../admin/index.js';
import type { DailyRecord } from '../attendance/index.js';

export type ReportBy = 'employee' | 'department' | 'factory';
export const REPORT_BY: readonly ReportBy[] = ['employee', 'department', 'factory'];

/** The employee fields a report needs (EmployeeRoster's RosterEntry fits it). */
export interface ReportEmployee {
  id: string;
  code: string;
  firstName: string;
  lastName: string;
  active: boolean;
  factoryId: string;
  teamId: string | null;
}

export interface Totals {
  /** Local days with at least one granted scan. */
  daysPresent: number;
  /** Sum of the daily hours, rounded to 2 decimals. */
  hours: number;
  /** Days with a single granted scan (FR-3.5). */
  missingPunchDays: number;
}

export interface EmployeeRow extends Totals {
  employeeId: string;
  code: string;
  firstName: string;
  lastName: string;
  factoryId: string;
  departmentId: string | null;
  teamId: string | null;
}

export interface DepartmentRow extends Totals {
  factoryId: string;
  departmentId: string | null;
  departmentName: string | null;
  employees: number;
}

export interface FactoryRow extends Totals {
  factoryId: string;
  factoryName: string | null;
  employees: number;
}

export type DayTotals = Pick<DailyRecord, 'employeeId' | 'hours' | 'missingPunch'>;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Name of the unit with this id, or null when it is not in the tree. */
const nameOf = (units: readonly OrgUnit[], id: string | null): string | null =>
  (id === null ? undefined : units.find((u) => u.id === id)?.name) ?? null;

/**
 * The department of a team: the team's parent when `teamId` is a TEAM whose parent is a
 * DEPARTMENT. Null for no team, an unknown team, or a broken tree.
 */
export const departmentOf = (units: readonly OrgUnit[], teamId: string | null): string | null => {
  if (teamId === null) return null;
  const team = units.find((u) => u.id === teamId);
  if (team?.kind !== 'TEAM' || team.parentId === null) return null;
  const parent = units.find((u) => u.id === team.parentId);
  return parent?.kind === 'DEPARTMENT' ? parent.id : null;
};

/** Sums the totals of `rows`; the hours are rounded once, at the end. */
const sumTotals = (rows: readonly Totals[]): Totals => {
  let hours = 0;
  let daysPresent = 0;
  let missingPunchDays = 0;
  for (const r of rows) {
    hours += r.hours;
    daysPresent += r.daysPresent;
    missingPunchDays += r.missingPunchDays;
  }
  return { daysPresent, hours: round2(hours), missingPunchDays };
};

/**
 * One row per employee (FR-4.1). Days present = records of the employee, hours = their sum
 * rounded once at the end. Every active employee has a row, even with no records; an inactive
 * one only if they have a record in the period (they left during it). Records of employees not
 * in `employees` are ignored. Sorted by factory, then code.
 */
export const employeeRows = (
  employees: readonly ReportEmployee[],
  records: readonly DayTotals[],
  units: readonly OrgUnit[],
): EmployeeRow[] => {
  const byEmployee = new Map<string, DayTotals[]>();
  for (const r of records) {
    const list = byEmployee.get(r.employeeId);
    if (list) list.push(r);
    else byEmployee.set(r.employeeId, [r]);
  }

  const rows: EmployeeRow[] = [];
  for (const e of employees) {
    const own = byEmployee.get(e.id) ?? [];
    if (!e.active && own.length === 0) continue;
    rows.push({
      employeeId: e.id,
      code: e.code,
      firstName: e.firstName,
      lastName: e.lastName,
      factoryId: e.factoryId,
      departmentId: departmentOf(units, e.teamId),
      teamId: e.teamId,
      daysPresent: own.length,
      hours: round2(own.reduce((sum, r) => sum + r.hours, 0)),
      missingPunchDays: own.filter((r) => r.missingPunch).length,
    });
  }
  return rows.sort((a, b) => compare(a.factoryId, b.factoryId) || compare(a.code, b.code));
};

/**
 * Employee rows grouped by factory and department (FR-4.1). Employees without a department form
 * one group per factory (department null). Sorted by factory, then department name (unnamed
 * last), then department id.
 */
export const departmentRows = (
  rows: readonly EmployeeRow[],
  units: readonly OrgUnit[],
): DepartmentRow[] => {
  const groups = new Map<string, EmployeeRow[]>();
  for (const r of rows) {
    const key = `${r.factoryId}\u0000${r.departmentId ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()]
    .map((group): DepartmentRow => {
      const { factoryId, departmentId } = group[0]!;
      return {
        factoryId,
        departmentId,
        departmentName: nameOf(units, departmentId),
        employees: group.length,
        ...sumTotals(group),
      };
    })
    .sort(
      (a, b) =>
        compare(a.factoryId, b.factoryId) ||
        (a.departmentName === null ? 1 : 0) - (b.departmentName === null ? 1 : 0) ||
        compare(a.departmentName ?? '', b.departmentName ?? '') ||
        compare(a.departmentId ?? '', b.departmentId ?? ''),
    );
};

/** Employee rows grouped by factory (FR-4.1). Sorted by factory id. */
export const factoryRows = (
  rows: readonly EmployeeRow[],
  units: readonly OrgUnit[],
): FactoryRow[] => {
  const groups = new Map<string, EmployeeRow[]>();
  for (const r of rows) {
    const list = groups.get(r.factoryId);
    if (list) list.push(r);
    else groups.set(r.factoryId, [r]);
  }
  return [...groups.entries()]
    .map(([factoryId, group]): FactoryRow => ({
      factoryId,
      factoryName: nameOf(units, factoryId),
      employees: group.length,
      ...sumTotals(group),
    }))
    .sort((a, b) => compare(a.factoryId, b.factoryId));
};
