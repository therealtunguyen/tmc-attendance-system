import { describe, expect, it } from 'vitest';
import type { DateRange } from '../../shared/types.js';
import type { DailyRecord } from '../attendance/index.js';
import { FakeAttendance, FakeRoster, fakeConfig, ROSTER } from './reporting.fakes.js';
import { CompanyMonthSource, hrsRows, readMonth } from './reporting.source.js';
import type { OrgUnit } from '../admin/index.js';

const range: DateRange = {
  from: new Date('2026-09-30T17:00:00Z'),
  to: new Date('2026-10-30T17:00:00Z'),
};

describe('readMonth', () => {
  it('reads roster and records once per factory with the range, and merges', async () => {
    const roster = new FakeRoster();
    const attendance = new FakeAttendance();
    const data = await readMonth(roster, attendance, ['binh-duong', 'long-an'], range);
    expect(roster.calls.sort()).toEqual(['binh-duong', 'long-an']);
    expect(attendance.calls.map((c) => c.scope).sort()).toEqual(['binh-duong', 'long-an']);
    expect(attendance.calls.every((c) => c.range === range)).toBe(true);
    expect(data.employees.map((e) => e.id).sort()).toEqual(ROSTER.map((e) => e.id).sort());
    expect(data.records).toHaveLength(6);
  });

  it('de-duplicates an employee returned by two factories', async () => {
    const roster = { roster: async () => ROSTER.slice(0, 2) };
    const data = await readMonth(roster, new FakeAttendance(), ['binh-duong', 'long-an'], range);
    expect(data.employees.map((e) => e.id)).toEqual(['e-cut', 'e-sew']);
  });

  it('reads nothing for no factories', async () => {
    const roster = new FakeRoster();
    expect(await readMonth(roster, new FakeAttendance(), [], range)).toEqual({
      employees: [],
      records: [],
    });
    expect(roster.calls).toEqual([]);
  });
});

describe('CompanyMonthSource', () => {
  it('reads every FACTORY and no other kind of unit', async () => {
    const roster = new FakeRoster();
    const attendance = new FakeAttendance();
    const source = new CompanyMonthSource(roster, attendance, fakeConfig);
    const data = await source.company(range);
    expect(roster.calls.sort()).toEqual(['binh-duong', 'long-an']);
    expect(attendance.calls.map((c) => c.scope).sort()).toEqual(['binh-duong', 'long-an']);
    expect(data.employees).toHaveLength(ROSTER.length);
  });

  it('follows the org tree', async () => {
    const units: OrgUnit[] = [
      { id: 'f3', kind: 'FACTORY', name: 'F3', parentId: null, supervisorIds: [] },
      { id: 'd3', kind: 'DEPARTMENT', name: 'D3', parentId: 'f3', supervisorIds: [] },
    ];
    const roster = new FakeRoster();
    await new CompanyMonthSource(roster, new FakeAttendance(), {
      orgUnits: async () => units,
    }).company(range);
    expect(roster.calls).toEqual(['f3']);
  });
});

describe('hrsRows', () => {
  const rec = (employeeId: string, day: string, extra: Partial<DailyRecord> = {}): DailyRecord => ({
    employeeId,
    day: new Date(day),
    firstIn: null,
    lastOut: null,
    hours: 0,
    missingPunch: false,
    ...extra,
  });

  it('maps a record to the Vietnam date with ISO times', () => {
    const rows = hrsRows(
      [{ id: 'e1', code: 'A001' }],
      [
        rec('e1', '2026-10-04T17:00:00.000Z', {
          firstIn: new Date('2026-10-05T01:00:00Z'),
          lastOut: new Date('2026-10-05T10:30:00Z'),
          hours: 8.5,
        }),
      ],
    );
    expect(rows).toEqual([
      {
        employeeId: 'e1',
        employeeCode: 'A001',
        date: '2026-10-05',
        firstIn: '2026-10-05T01:00:00.000Z',
        lastOut: '2026-10-05T10:30:00.000Z',
        hours: 8.5,
        missingPunch: false,
      },
    ]);
  });

  it('keeps a missing punch with a null lastOut', () => {
    const [row] = hrsRows(
      [{ id: 'e1', code: 'A001' }],
      [
        rec('e1', '2026-09-30T17:00:00.000Z', {
          firstIn: new Date('2026-10-01T01:00:00Z'),
          missingPunch: true,
        }),
      ],
    );
    expect(row).toMatchObject({ date: '2026-10-01', lastOut: null, missingPunch: true });
  });

  it('drops records of unknown employees and sorts by code then date', () => {
    const rows = hrsRows(
      [
        { id: 'b', code: 'B' },
        { id: 'a', code: 'C' },
      ],
      [
        rec('a', '2026-10-02T17:00:00Z'),
        rec('x', '2026-10-01T17:00:00Z'),
        rec('b', '2026-10-05T17:00:00Z'),
        rec('a', '2026-10-01T17:00:00Z'),
        rec('b', '2026-10-03T17:00:00Z'),
      ],
    );
    expect(rows.map((r) => `${r.employeeCode} ${r.date}`)).toEqual([
      'B 2026-10-04',
      'B 2026-10-06',
      'C 2026-10-02',
      'C 2026-10-03',
    ]);
  });

  it('has exactly the 7 data-minimised fields, even for a full roster entry', () => {
    const [row] = hrsRows(ROSTER, [rec('e-cut', '2026-09-30T17:00:00Z')]);
    expect(Object.keys(row!).sort()).toEqual(
      ['date', 'employeeCode', 'employeeId', 'firstIn', 'hours', 'lastOut', 'missingPunch'].sort(),
    );
    expect(JSON.stringify(row)).not.toContain('Nguyen');
  });
});
