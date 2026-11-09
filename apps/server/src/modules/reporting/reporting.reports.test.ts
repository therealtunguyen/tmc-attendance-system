import { beforeEach, describe, expect, it } from 'vitest';
import type { UserRef } from '../iam/index.js';
import {
  BIG_RECORDS,
  BIG_ROSTER,
  FakeAttendance,
  FakeRoster,
  UNITS,
  fakeConfig,
} from './reporting.fakes.js';
import { parseMonth } from './reporting.month.js';
import type { ReportMonth } from './reporting.month.js';
import {
  EXE_MIN_GROUP,
  MonthlyReportService,
  ReportForbiddenError,
  UnknownScopeError,
  queryUnits,
} from './reporting.reports.js';
import type { ReportQuery } from './reporting.reports.js';

const month = parseMonth('2026-10', new Date('2026-11-08T00:00:00Z')) as ReportMonth;

let roster: FakeRoster;
let attendance: FakeAttendance;
let svc: MonthlyReportService;
beforeEach(() => {
  roster = new FakeRoster();
  attendance = new FakeAttendance();
  svc = new MonthlyReportService(roster, attendance, fakeConfig);
});

const hr: UserRef = { id: 'hr', role: 'HR' };
const hrBd: UserRef = {
  id: 'hr-bd',
  role: 'HR',
  scopes: ['binh-duong', 'bd-prod', 'bd-cut', 'bd-sew'],
};
const sup = (scopes?: string[]): UserRef => ({ id: 'sup', role: 'SUP', scopes });
const exe: UserRef = { id: 'exe', role: 'EXE' };
const q = (by: ReportQuery['by'], scope?: string): ReportQuery => ({ month, by, scope });
const ids = (rows: unknown) => (rows as { employeeId: string }[]).map((r) => r.employeeId).sort();

describe('MonthlyReportService (FR-4.1, FR-4.3)', () => {
  it('unrestricted HR sees every employee of both factories', async () => {
    const report = await svc.monthly(hr, q('employee'));
    expect(report).toMatchObject({ month: '2026-10', by: 'employee', scope: null });
    // The inactive employee has no records, so no row.
    expect(ids(report.rows)).toEqual(['e-cut', 'e-none', 'e-pack', 'e-sew']);
  });

  it('by=factory gives one row per factory with the right totals', async () => {
    const report = await svc.monthly(hr, q('factory'));
    expect(report.rows).toEqual([
      {
        factoryId: 'binh-duong',
        factoryName: 'Binh Duong',
        employees: 3,
        daysPresent: 4,
        hours: 27.5,
        missingPunchDays: 1,
      },
      {
        factoryId: 'long-an',
        factoryName: 'Long An',
        employees: 1,
        daysPresent: 2,
        hours: 16,
        missingPunchDays: 0,
      },
    ]);
  });

  it('by=department groups by department', async () => {
    const report = await svc.monthly(hr, q('department'));
    if (report.by !== 'department') throw new Error('expected a department report');
    expect(report.rows.map((r) => [r.factoryId, r.departmentId, r.employees])).toEqual([
      ['binh-duong', 'bd-prod', 2],
      ['binh-duong', null, 1],
      ['long-an', 'la-prod', 1],
    ]);
  });

  it('calls dailyRecords with the month range, once per factory', async () => {
    await svc.monthly(hr, q('employee'));
    expect(attendance.calls.map((c) => c.scope).sort()).toEqual(['binh-duong', 'long-an']);
    for (const c of attendance.calls) expect(c.range).toEqual(month.range);
    expect(roster.calls.sort()).toEqual(['binh-duong', 'long-an']);
  });

  describe('narrowest query', () => {
    it('SUP of bd-cut reads only bd-cut', async () => {
      await svc.monthly(sup(['bd-cut']), q('employee'));
      expect(roster.calls).toEqual(['bd-cut']);
      expect(attendance.calls.map((c) => c.scope)).toEqual(['bd-cut']);
    });

    it('scope=bd-prod reads its two teams', async () => {
      await svc.monthly(hr, q('employee', 'bd-prod'));
      expect(roster.calls.sort()).toEqual(['bd-cut', 'bd-sew']);
      expect(attendance.calls.map((c) => c.scope).sort()).toEqual(['bd-cut', 'bd-sew']);
    });

    it('HR scoped to binh-duong (expanded scopes) reads the factory only', async () => {
      await svc.monthly(hrBd, q('employee'));
      expect(roster.calls).toEqual(['binh-duong']);
      expect(attendance.calls.map((c) => c.scope)).toEqual(['binh-duong']);
    });
  });

  describe('HR scoped to a factory', () => {
    it('sees only that factory', async () => {
      const report = await svc.monthly(hrBd, q('employee'));
      expect(ids(report.rows)).toEqual(['e-cut', 'e-none', 'e-sew']);
      expect(attendance.calls.map((c) => c.scope)).toEqual(['binh-duong']);
    });

    it.each(['long-an', 'la-pack'])('is forbidden scope=%s', async (scope) => {
      await expect(svc.monthly(hrBd, q('employee', scope))).rejects.toBeInstanceOf(
        ReportForbiddenError,
      );
    });
  });

  describe('SUP of one team', () => {
    it.each([undefined, 'bd-cut'])('sees only their team (scope=%s)', async (scope) => {
      const report = await svc.monthly(sup(['bd-cut']), q('employee', scope));
      expect(ids(report.rows)).toEqual(['e-cut']);
    });

    it.each(['bd-sew', 'bd-prod', 'binh-duong'])('is forbidden scope=%s', async (scope) => {
      await expect(svc.monthly(sup(['bd-cut']), q('employee', scope))).rejects.toBeInstanceOf(
        ReportForbiddenError,
      );
    });

    it.each([undefined, []])('with scopes %j gets no rows', async (scopes) => {
      const report = await svc.monthly(sup(scopes), q('employee'));
      expect(report.rows).toEqual([]);
    });
  });

  it('scope=bd-prod returns its teams, not the employee without a team', async () => {
    const report = await svc.monthly(hr, q('employee', 'bd-prod'));
    expect(ids(report.rows)).toEqual(['e-cut', 'e-sew']);
    expect(report.scope).toBe('bd-prod');
  });

  describe('EXE (FR-4.3)', () => {
    it('never gets per-employee rows, and nothing is read', async () => {
      await expect(svc.monthly(exe, q('employee'))).rejects.toBeInstanceOf(ReportForbiddenError);
      expect(roster.calls).toEqual([]);
      expect(attendance.calls).toEqual([]);
    });

    it.each(['department', 'factory'] as const)('gets by=%s', async (by) => {
      const big = new MonthlyReportService(
        new FakeRoster(BIG_ROSTER),
        new FakeAttendance(BIG_ROSTER, BIG_RECORDS),
        fakeConfig,
      );
      expect((await big.monthly(exe, q(by))).rows.length).toBeGreaterThan(0);
    });

    it('does not see a department with fewer than the minimum group; suppressed counts it', async () => {
      const report = await svc.monthly(exe, q('department'));
      // Default fixtures: bd-prod 2, no department 1, la-prod 1: all too small.
      expect(report.rows).toEqual([]);
      expect(report.suppressed).toBe(3);
    });

    it('keeps a group of exactly EXE_MIN_GROUP, drops the smaller one', async () => {
      expect(EXE_MIN_GROUP).toBe(5);
      const big = new MonthlyReportService(
        new FakeRoster(BIG_ROSTER),
        new FakeAttendance(BIG_ROSTER, BIG_RECORDS),
        fakeConfig,
      );
      const report = await big.monthly(exe, q('factory'));
      if (report.by !== 'factory') throw new Error('expected a factory report');
      // long-an has exactly 5; binh-duong has 3.
      expect(report.rows.map((r) => [r.factoryId, r.employees])).toEqual([['long-an', 5]]);
      expect(report.suppressed).toBe(1);
    });

    it('HR sees the same small rows, with nothing suppressed', async () => {
      const report = await svc.monthly(hr, q('department'));
      expect(report.rows).toHaveLength(3);
      expect(report.suppressed).toBe(0);
    });
  });

  describe('unknown scope', () => {
    it('unrestricted: UnknownScopeError', async () => {
      await expect(svc.monthly(hr, q('employee', 'nowhere'))).rejects.toBeInstanceOf(
        UnknownScopeError,
      );
    });

    it('restricted: forbidden, so ids cannot be probed', async () => {
      await expect(svc.monthly(hrBd, q('employee', 'nowhere'))).rejects.toBeInstanceOf(
        ReportForbiddenError,
      );
    });
  });
});

describe('queryUnits', () => {
  it.each([
    ['a team', ['bd-cut'], ['bd-cut']],
    ['a department: its teams', ['bd-prod'], ['bd-cut', 'bd-sew']],
    ['a factory', ['binh-duong'], ['binh-duong']],
    ['a factory and one of its teams: the factory', ['binh-duong', 'bd-cut'], ['binh-duong']],
    ['two teams in different factories', ['la-pack', 'bd-cut'], ['bd-cut', 'la-pack']],
    ['an unknown id', ['nowhere'], []],
    ['duplicates', ['bd-cut', 'bd-cut'], ['bd-cut']],
  ])('%s', (_name, targets, expected) => {
    expect(queryUnits(UNITS, targets)).toEqual(expected);
  });
});
