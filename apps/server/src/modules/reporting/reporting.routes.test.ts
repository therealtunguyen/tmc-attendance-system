import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { UserRef } from '../iam/index.js';
import { FakeAttendance, FakeRoster, fakeConfig } from './reporting.fakes.js';
import { MonthlyReportService } from './reporting.reports.js';
import { reportingRoutes } from './reporting.routes.js';

const NOW = new Date('2026-11-08T00:00:00Z');
const reports = new MonthlyReportService(new FakeRoster(), new FakeAttendance(), fakeConfig);

/** Stands in for the IAM auth middleware (FR-5.1). */
const signedIn = (user?: UserRef) =>
  Router().use((_req, res, next) => {
    if (user) res.locals.user = user;
    next();
  });
const app = (user?: UserRef) =>
  createApp([signedIn(user), reportingRoutes({ reports, now: () => NOW })]);

const user = (role: UserRef['role'], scopes?: string[]): UserRef => ({ id: role, role, scopes });
const hr = user('HR');
const JSON_URL = '/api/reports/monthly';
const CSV_URL = '/api/reports/monthly.csv';

describe('report routes: RBAC (FR-4.3)', () => {
  it.each([JSON_URL, CSV_URL])('401 without a session: %s', async (url) => {
    expect((await request(app()).get(`${url}?month=2026-10`)).status).toBe(401);
  });

  it.each(['EMP', 'GRD', 'ADM'] as const)('403 for %s', async (role) => {
    for (const url of [JSON_URL, CSV_URL]) {
      expect((await request(app(user(role))).get(`${url}?month=2026-10`)).status).toBe(403);
    }
  });

  it('200 for HR, SUP and EXE (by=factory)', async () => {
    expect((await request(app(hr)).get(`${JSON_URL}?month=2026-10`)).status).toBe(200);
    const sup = user('SUP', ['bd-cut']);
    expect((await request(app(sup)).get(`${JSON_URL}?month=2026-10`)).status).toBe(200);
    const exe = await request(app(user('EXE'))).get(`${JSON_URL}?month=2026-10&by=factory`);
    expect(exe.status).toBe(200);
  });

  it.each([JSON_URL, CSV_URL])('403 for EXE by=employee: %s', async (url) => {
    const res = await request(app(user('EXE'))).get(`${url}?month=2026-10&by=employee`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('403 for a SUP asking another team', async () => {
    const res = await request(app(user('SUP', ['bd-cut']))).get(
      `${JSON_URL}?month=2026-10&scope=bd-sew`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });
});

describe('report routes: personal data is not cached', () => {
  it.each([JSON_URL, CSV_URL])('Cache-Control: no-store on 200: %s', async (url) => {
    const res = await request(app(hr)).get(`${url}?month=2026-10`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the JSON says how many rows were suppressed', async () => {
    const res = await request(app(hr)).get(`${JSON_URL}?month=2026-10`);
    expect(res.body.suppressed).toBe(0);
    const exe = await request(app(user('EXE'))).get(`${JSON_URL}?month=2026-10&by=factory`);
    expect(exe.body).toMatchObject({ suppressed: 2, rows: [] });
  });
});

describe('report routes: bad input', () => {
  it.each([
    ['', 'missing month', 'month must be YYYY-MM'],
    ['?month=2026-13', 'invalid month', 'month must be YYYY-MM'],
    ['?month=2026-12', 'future month', 'month must not be in the future'],
    ['?month=2026-10&by=team', 'bad by', 'by must be employee, department or factory'],
    [
      '?month=2026-10&scope=bd-cut&scope=bd-sew',
      'repeated scope',
      'scope must be a single org unit id',
    ],
    ['?month=2026-10&scope=', 'empty scope', 'scope must be a single org unit id'],
    ['?month=2026-10&scope=nowhere', 'unknown scope', 'Unknown scope'],
  ])('400 for %s (%s)', async (qs, _case, error) => {
    for (const url of [JSON_URL, CSV_URL]) {
      const res = await request(app(hr)).get(`${url}${qs}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error });
    }
  });
});

describe('GET /api/reports/monthly', () => {
  it('returns month, by, scope and rows for by=employee', async () => {
    const res = await request(app(hr)).get(`${JSON_URL}?month=2026-10`);
    expect(res.body).toMatchObject({ month: '2026-10', by: 'employee', scope: null });
    expect(res.body.rows).toHaveLength(4);
    expect(res.body.rows[0]).toEqual({
      employeeId: 'e-cut',
      code: 'E-CUT',
      firstName: 'Lan',
      lastName: 'Nguyen e-cut',
      factoryId: 'binh-duong',
      departmentId: 'bd-prod',
      teamId: 'bd-cut',
      daysPresent: 2,
      hours: 15.5,
      missingPunchDays: 0,
    });
  });
});

describe('GET /api/reports/monthly.csv (FR-4.2)', () => {
  const EMPLOYEE_HEADER =
    'employeeId,code,firstName,lastName,factoryId,departmentId,teamId,daysPresent,hours,missingPunchDays';

  it('sends a UTF-8 CSV attachment with a BOM', async () => {
    const res = await request(app(hr)).get(`${CSV_URL}?month=2026-10`);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="report-employee-2026-10.csv"',
    );
    expect(res.text.startsWith('\uFEFF')).toBe(true);
  });

  it('has the exact header, quotes commas, and matches the JSON rows', async () => {
    const csv = await request(app(hr)).get(`${CSV_URL}?month=2026-10`);
    const json = await request(app(hr)).get(`${JSON_URL}?month=2026-10`);
    const lines = csv.text.slice(1).split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(json.body.rows.length + 1);
    expect(lines[0]).toBe(EMPLOYEE_HEADER);
    const pack = lines.find((l) => l.startsWith('e-pack,'))!;
    expect(pack).toContain('"Tran, Van"');
    const cut = lines.find((l) => l.startsWith('e-cut,'))!;
    expect(cut).toBe('e-cut,E-CUT,Lan,Nguyen e-cut,binh-duong,bd-prod,bd-cut,2,15.5,0');
    // Same order as the JSON rows.
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(
      json.body.rows.map((r: { employeeId: string }) => r.employeeId),
    );
  });

  it('uses the department and factory column sets', async () => {
    const dep = await request(app(hr)).get(`${CSV_URL}?month=2026-10&by=department`);
    expect(dep.text.slice(1).split('\r\n')[0]).toBe(
      'factoryId,departmentId,departmentName,employees,daysPresent,hours,missingPunchDays',
    );
    const fac = await request(app(hr)).get(`${CSV_URL}?month=2026-10&by=factory`);
    expect(fac.text.slice(1).split('\r\n')[0]).toBe(
      'factoryId,factoryName,employees,daysPresent,hours,missingPunchDays',
    );
    expect(fac.headers['content-disposition']).toContain('report-factory-2026-10.csv');
  });
});
