import { describe, expect, it } from 'vitest';
import type { OrgUnit } from '../admin/index.js';
import {
  departmentOf,
  departmentRows,
  employeeRows,
  factoryRows,
  type DayTotals,
  type ReportEmployee,
} from './reporting.aggregate.js';

const unit = (
  id: string,
  kind: OrgUnit['kind'],
  name: string,
  parentId: string | null,
): OrgUnit => ({
  id,
  kind,
  name,
  parentId,
  supervisorIds: [],
});

const units: OrgUnit[] = [
  unit('long-an', 'FACTORY', 'Long An', null),
  unit('binh-duong', 'FACTORY', 'Binh Duong', null),
  unit('dept-sew', 'DEPARTMENT', 'Sewing', 'binh-duong'),
  unit('dept-cut', 'DEPARTMENT', 'Cutting', 'binh-duong'),
  unit('dept-pack', 'DEPARTMENT', 'Packing', 'long-an'),
  unit('team-s1', 'TEAM', 'Sewing 1', 'dept-sew'),
  unit('team-c1', 'TEAM', 'Cutting 1', 'dept-cut'),
  unit('team-p1', 'TEAM', 'Packing 1', 'dept-pack'),
  unit('team-orphan', 'TEAM', 'Orphan', 'gone'),
];

const emp = (
  id: string,
  code: string,
  factoryId: string,
  teamId: string | null,
  active = true,
): ReportEmployee => ({
  id,
  code,
  firstName: `F${id}`,
  lastName: `L${id}`,
  active,
  factoryId,
  teamId,
});

const day = (employeeId: string, hours: number, missingPunch = false): DayTotals => ({
  employeeId,
  hours,
  missingPunch,
});

const employees: ReportEmployee[] = [
  emp('e1', 'E001', 'binh-duong', 'team-s1'),
  emp('e2', 'E002', 'binh-duong', 'team-c1'),
  emp('e3', 'E003', 'binh-duong', null), // no team
  emp('e4', 'E004', 'long-an', 'team-p1'),
  emp('e5', 'E005', 'binh-duong', 'team-s1'), // active, no records
  emp('e6', 'E006', 'binh-duong', 'team-s1', false), // inactive, left during the month
  emp('e7', 'E007', 'long-an', 'team-p1', false), // inactive, no records
  emp('e8', 'E008', 'long-an', 'team-orphan'), // broken tree
];

describe('departmentOf', () => {
  it('returns the parent department of a team', () => {
    expect(departmentOf(units, 'team-s1')).toBe('dept-sew');
  });
  it.each([
    ['no team', null],
    ['an unknown team', 'nope'],
    ['a team whose parent is missing', 'team-orphan'],
    ['a unit that is not a team', 'dept-sew'],
  ])('returns null for %s', (_label, teamId) => {
    expect(departmentOf(units, teamId)).toBeNull();
  });
  it('returns null when the parent is not a department', () => {
    const odd = [unit('f', 'FACTORY', 'F', null), unit('t', 'TEAM', 'T', 'f')];
    expect(departmentOf(odd, 't')).toBeNull();
  });
});

describe('employeeRows (FR-4.1)', () => {
  const records: DayTotals[] = [
    day('e1', 7.33),
    day('e1', 8.5),
    day('e1', 0.17),
    day('e2', 0.1),
    day('e2', 0.2),
    day('e2', 0, true),
    day('e4', 8),
    day('e6', 4),
    day('ghost', 9),
  ];
  const rows = employeeRows(employees, records, units);
  const byId = (id: string) => rows.find((r) => r.employeeId === id);

  it('sums days, hours and missing punches per employee', () => {
    expect(byId('e1')).toMatchObject({ daysPresent: 3, hours: 16, missingPunchDays: 0 });
    expect(byId('e2')).toMatchObject({ daysPresent: 3, hours: 0.3, missingPunchDays: 1 });
  });

  it('carries the employee fields and the department', () => {
    expect(byId('e1')).toMatchObject({
      code: 'E001',
      firstName: 'Fe1',
      lastName: 'Le1',
      factoryId: 'binh-duong',
      teamId: 'team-s1',
      departmentId: 'dept-sew',
    });
    expect(byId('e3')).toMatchObject({ teamId: null, departmentId: null });
    expect(byId('e8')).toMatchObject({ teamId: 'team-orphan', departmentId: null });
  });

  it('gives an active employee without records a zero row', () => {
    expect(byId('e5')).toMatchObject({ daysPresent: 0, hours: 0, missingPunchDays: 0 });
  });

  it('keeps an inactive employee only when they have records', () => {
    expect(byId('e6')).toMatchObject({ daysPresent: 1, hours: 4 });
    expect(byId('e7')).toBeUndefined();
  });

  it('ignores records of unknown employees', () => {
    expect(rows.some((r) => r.employeeId === 'ghost')).toBe(false);
    expect(rows).toHaveLength(7);
  });

  it('is sorted by factory, then code', () => {
    expect(rows.map((r) => r.employeeId)).toEqual(['e1', 'e2', 'e3', 'e5', 'e6', 'e4', 'e8']);
  });

  it('rounds the hours once, at the end', () => {
    // 0.004 per record rounds to 0 each, but 250 of them make 1 hour.
    const many = Array.from({ length: 250 }, () => day('e1', 0.004));
    expect(employeeRows([employees[0]!], many, units)[0]!.hours).toBe(1);
  });

  it('does not mutate its inputs', () => {
    const e = structuredClone(employees);
    const r = structuredClone(records);
    employeeRows(e, r, units);
    expect(e).toEqual(employees);
    expect(r).toEqual(records);
  });
});

describe('departmentRows (FR-4.1)', () => {
  const records: DayTotals[] = [
    day('e1', 7.33),
    day('e1', 8.5),
    day('e5', 0.17, true),
    day('e2', 8),
    day('e3', 5),
    day('e4', 6),
    day('e8', 2),
  ];
  const rows = employeeRows(employees, records, units);
  const snapshot = structuredClone(rows);
  const result = departmentRows(rows, units);

  it('groups by factory and department with summed totals', () => {
    const sewing = result.find((r) => r.departmentId === 'dept-sew')!;
    expect(sewing).toEqual({
      factoryId: 'binh-duong',
      departmentId: 'dept-sew',
      departmentName: 'Sewing',
      employees: 2, // e1, e5 (e6 is inactive without records)
      daysPresent: 3,
      hours: 16,
      missingPunchDays: 1,
    });
  });

  it('forms one no-department group per factory', () => {
    const none = result.filter((r) => r.departmentId === null);
    expect(none.map((r) => [r.factoryId, r.employees, r.departmentName])).toEqual([
      ['binh-duong', 1, null],
      ['long-an', 1, null],
    ]);
  });

  it('is sorted by factory, then department name with unnamed last', () => {
    expect(result.map((r) => [r.factoryId, r.departmentName])).toEqual([
      ['binh-duong', 'Cutting'],
      ['binh-duong', 'Sewing'],
      ['binh-duong', null],
      ['long-an', 'Packing'],
      ['long-an', null],
    ]);
  });

  it('breaks name ties by department id', () => {
    const twin = [
      unit('f', 'FACTORY', 'F', null),
      unit('d2', 'DEPARTMENT', 'Same', 'f'),
      unit('d1', 'DEPARTMENT', 'Same', 'f'),
      unit('t2', 'TEAM', 'T2', 'd2'),
      unit('t1', 'TEAM', 'T1', 'd1'),
    ];
    const es = [emp('a', 'A', 'f', 't2'), emp('b', 'B', 'f', 't1')];
    const out = departmentRows(employeeRows(es, [], twin), twin);
    expect(out.map((r) => r.departmentId)).toEqual(['d1', 'd2']);
  });

  it('does not mutate its input', () => {
    expect(rows).toEqual(snapshot);
  });
});

describe('factoryRows (FR-4.1)', () => {
  const records: DayTotals[] = [day('e1', 7.33), day('e2', 8.5), day('e3', 0.17), day('e4', 3)];
  const rows = employeeRows(employees, records, units);
  const snapshot = structuredClone(rows);

  it('groups by factory with names and summed totals, sorted by factory id', () => {
    expect(factoryRows(rows, units)).toEqual([
      {
        factoryId: 'binh-duong',
        factoryName: 'Binh Duong',
        employees: 4, // e1, e2, e3, e5 (e6 is inactive without records)
        daysPresent: 3,
        hours: 16,
        missingPunchDays: 0,
      },
      {
        factoryId: 'long-an',
        factoryName: 'Long An',
        employees: 2, // e4, e8
        daysPresent: 1,
        hours: 3,
        missingPunchDays: 0,
      },
    ]);
  });

  it('uses a null name for a factory missing from the tree', () => {
    const out = factoryRows(rows, []);
    expect(out.map((r) => r.factoryName)).toEqual([null, null]);
  });

  it('does not mutate its input', () => {
    factoryRows(rows, units);
    expect(rows).toEqual(snapshot);
  });
});
