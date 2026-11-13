import { describe, expect, it } from 'vitest';
import {
  buildDailyRecords,
  localDayStart,
  MIN_PUNCH_GAP_MS,
  parseRecordId,
  recordIdOf,
  type DailyInput,
} from './attendance.daily.js';

const granted = (employeeId: string | null, at: string): DailyInput => ({
  employeeId,
  occurredAt: new Date(at),
  outcome: 'GRANTED',
});

describe('localDayStart (Vietnam, UTC+7)', () => {
  it.each([
    ['2026-11-06T17:00:00Z', '2026-11-06T17:00:00Z'], // 00:00 local, first instant of 07/11
    ['2026-11-06T16:59:59Z', '2026-11-05T17:00:00Z'], // 23:59:59 local on 06/11
    ['2026-11-07T10:00:00Z', '2026-11-06T17:00:00Z'], // 17:00 local on 07/11
  ])('%s falls on the local day starting %s', (at, start) => {
    expect(localDayStart(new Date(at))).toEqual(new Date(start));
  });
});

describe('buildDailyRecords (FR-3.4, FR-3.5)', () => {
  it('first in is the earliest and last out the latest scan, whatever the input order', () => {
    const [record] = buildDailyRecords([
      granted('emp-1', '2026-11-07T05:00:00Z'), // lunch exit, between first and last
      granted('emp-1', '2026-11-07T10:30:00Z'),
      granted('emp-1', '2026-11-07T01:00:00Z'),
      granted('emp-1', '2026-11-07T06:00:00Z'),
    ]);
    expect(record).toEqual({
      employeeId: 'emp-1',
      day: new Date('2026-11-06T17:00:00Z'),
      firstIn: new Date('2026-11-07T01:00:00Z'),
      lastOut: new Date('2026-11-07T10:30:00Z'),
      hours: 9.5,
      missingPunch: false,
    });
  });

  it('a single scan is a missing punch with no last out and 0 hours', () => {
    expect(buildDailyRecords([granted('emp-1', '2026-11-07T01:00:00Z')])).toEqual([
      expect.objectContaining({ lastOut: null, hours: 0, missingPunch: true }),
    ]);
  });

  it('a double tap is a missing punch with no last out and 0 hours (#113 C2)', () => {
    expect(
      buildDailyRecords([
        granted('emp-1', '2026-11-07T01:00:00Z'),
        granted('emp-1', '2026-11-07T01:00:05Z'),
      ]),
    ).toEqual([expect.objectContaining({ lastOut: null, hours: 0, missingPunch: true })]);
  });

  it('the punch gap is inclusive at exactly MIN_PUNCH_GAP_MS (#113 C2)', () => {
    const t0 = new Date('2026-11-07T01:00:00Z').getTime();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const [ok] = buildDailyRecords([
      granted('emp-1', at(0)),
      granted('emp-1', at(MIN_PUNCH_GAP_MS)),
    ]);
    expect(ok).toMatchObject({ lastOut: new Date(t0 + MIN_PUNCH_GAP_MS), missingPunch: false });
    const [short] = buildDailyRecords([
      granted('emp-1', at(0)),
      granted('emp-1', at(MIN_PUNCH_GAP_MS - 1_000)),
    ]);
    expect(short).toMatchObject({ lastOut: null, missingPunch: true, hours: 0 });
  });

  it('rounds hours to 2 decimals', () => {
    const [record] = buildDailyRecords([
      granted('emp-1', '2026-11-07T01:00:00Z'),
      granted('emp-1', '2026-11-07T09:20:00Z'),
    ]);
    expect(record?.hours).toBe(8.33);
  });

  it('a night across local midnight gives two days, each a missing punch', () => {
    const records = buildDailyRecords([
      granted('emp-1', '2026-11-07T16:30:00Z'), // 23:30 local on 07/11
      granted('emp-1', '2026-11-07T17:30:00Z'), // 00:30 local on 08/11
    ]);
    expect(records.map((r) => [r.day.toISOString(), r.missingPunch])).toEqual([
      ['2026-11-06T17:00:00.000Z', true],
      ['2026-11-07T17:00:00.000Z', true],
    ]);
  });

  it('ignores PENDING, DENIED and events with no employee', () => {
    expect(
      buildDailyRecords([
        { ...granted('emp-1', '2026-11-07T01:00:00Z'), outcome: 'PENDING' },
        { ...granted('emp-1', '2026-11-07T09:00:00Z'), outcome: 'DENIED' },
        granted(null, '2026-11-07T09:00:00Z'),
      ]),
    ).toEqual([]);
  });

  it('sorts by employee, then day', () => {
    const records = buildDailyRecords([
      granted('emp-2', '2026-11-07T01:00:00Z'),
      granted('emp-1', '2026-11-08T01:00:00Z'),
      granted('emp-1', '2026-11-07T01:00:00Z'),
    ]);
    expect(records.map((r) => [r.employeeId, r.day.toISOString()])).toEqual([
      ['emp-1', '2026-11-06T17:00:00.000Z'],
      ['emp-1', '2026-11-07T17:00:00.000Z'],
      ['emp-2', '2026-11-06T17:00:00.000Z'],
    ]);
  });
});

describe('record IDs', () => {
  it('names the employee and the Vietnam day, and reads back', () => {
    const day = new Date('2026-11-06T17:00:00Z');
    const id = recordIdOf({ employeeId: 'emp_1', day });
    expect(id).toBe('emp_1_2026-11-07');
    expect(parseRecordId(id)).toEqual({ employeeId: 'emp_1', day });
  });

  it.each(['', 'emp-1', 'emp-1_2026-11', '_2026-11-07', 'emp-1_2026-13-01', 'emp-1_2026-02-31'])(
    'refuses %j',
    (id) => {
      expect(parseRecordId(id)).toBeNull();
    },
  );
});

describe('buildDailyRecords with HR corrections (FR-3.6)', () => {
  const day = new Date('2026-11-06T17:00:00Z');
  const correction = (
    field: 'FIRST_IN' | 'LAST_OUT',
    at: string,
    createdAt = '2026-11-08T00:00:00Z',
    employeeId = 'emp-1',
  ) => ({
    employeeId,
    day,
    field,
    correctedValue: new Date(at),
    createdAt: new Date(createdAt),
  });
  const scan = granted('emp-1', '2026-11-07T01:00:00Z');

  it('a corrected last out ends a missing punch and gives hours', () => {
    const [record] = buildDailyRecords([scan], [correction('LAST_OUT', '2026-11-07T10:00:00Z')]);
    expect(record).toMatchObject({ hours: 9, missingPunch: false, corrected: true });
  });

  it('a corrected last out wins over a double tap (#113 C2)', () => {
    const [record] = buildDailyRecords(
      [scan, granted('emp-1', '2026-11-07T01:00:05Z')],
      [correction('LAST_OUT', '2026-11-07T10:00:00Z')],
    );
    expect(record).toMatchObject({ hours: 9, missingPunch: false, corrected: true });
  });

  it('a corrected first in leaves a single scan as a missing punch', () => {
    const [record] = buildDailyRecords([scan], [correction('FIRST_IN', '2026-11-07T00:30:00Z')]);
    expect(record).toMatchObject({
      firstIn: new Date('2026-11-07T00:30:00Z'),
      lastOut: null,
      hours: 0,
      missingPunch: true,
      corrected: true,
    });
  });

  it('the newest correction of a field applies, whatever the order', () => {
    const [record] = buildDailyRecords(
      [scan],
      [
        correction('LAST_OUT', '2026-11-07T11:00:00Z', '2026-11-08T02:00:00Z'),
        correction('LAST_OUT', '2026-11-07T10:00:00Z', '2026-11-08T01:00:00Z'),
      ],
    );
    expect(record?.lastOut).toEqual(new Date('2026-11-07T11:00:00Z'));
  });

  it('ignores corrections of another employee or another day', () => {
    const [record] = buildDailyRecords(
      [scan],
      [
        correction('LAST_OUT', '2026-11-07T10:00:00Z', undefined, 'emp-2'),
        {
          ...correction('LAST_OUT', '2026-11-08T10:00:00Z'),
          day: new Date('2026-11-07T17:00:00Z'),
        },
      ],
    );
    expect(record).toMatchObject({ lastOut: null, missingPunch: true });
    expect(record).not.toHaveProperty('corrected');
  });

  it('a correction alone does not create a day', () => {
    expect(buildDailyRecords([], [correction('LAST_OUT', '2026-11-07T10:00:00Z')])).toEqual([]);
  });

  it('a late scan after a corrected last out gives 0 hours and flags the day', () => {
    const [record] = buildDailyRecords(
      [granted('emp-1', '2026-11-07T11:00:00Z')],
      [correction('LAST_OUT', '2026-11-07T10:00:00Z')],
    );
    expect(record).toMatchObject({ hours: 0, missingPunch: true });
  });

  it('a late scan before a corrected first in gives 0 hours and flags the day', () => {
    // One scan at 12:00, first in corrected to 15:00; then two earlier scans arrive from an edge.
    const [record] = buildDailyRecords(
      [
        granted('emp-1', '2026-11-07T05:00:00Z'),
        granted('emp-1', '2026-11-07T01:00:00Z'),
        granted('emp-1', '2026-11-07T03:00:00Z'),
      ],
      [correction('FIRST_IN', '2026-11-07T08:00:00Z')],
    );
    expect(record).toMatchObject({
      firstIn: new Date('2026-11-07T08:00:00Z'),
      lastOut: new Date('2026-11-07T05:00:00Z'),
      hours: 0,
      missingPunch: true,
    });
  });

  it('two scans at the same instant are a missing punch, 0 hours (#113 C2)', () => {
    const [record] = buildDailyRecords([
      granted('emp-1', '2026-11-07T01:00:00Z'),
      granted('emp-1', '2026-11-07T01:00:00Z'),
    ]);
    expect(record).toMatchObject({ lastOut: null, hours: 0, missingPunch: true });
  });
});
