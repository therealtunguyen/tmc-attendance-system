import { describe, expect, it } from 'vitest';
import { parseMonth } from './reporting.month.js';

const NOW = new Date('2026-11-08T05:00:00Z');

describe('parseMonth (FR-4.1)', () => {
  it.each([
    ['2026-02', '2026-01-31T17:00:00.000Z', '2026-02-27T17:00:00.000Z'],
    ['2024-02', '2024-01-31T17:00:00.000Z', '2024-02-28T17:00:00.000Z'], // leap year
    ['2025-12', '2025-11-30T17:00:00.000Z', '2025-12-30T17:00:00.000Z'],
    ['2025-03', '2025-02-28T17:00:00.000Z', '2025-03-30T17:00:00.000Z'],
  ])('%s runs from %s to %s (Vietnam day starts)', (month, from, to) => {
    const parsed = parseMonth(month, NOW);
    expect(parsed).toEqual({ month, range: { from: new Date(from), to: new Date(to) } });
  });

  it.each([['0000-01'], ['0099-12'], ['1999-12']])('rejects %s (before 2000)', (value) => {
    expect(parseMonth(value, NOW)).toBe('month must be YYYY-MM from 2000 on');
  });

  it('accepts 2000-01 with its exact range', () => {
    expect(parseMonth('2000-01', NOW)).toEqual({
      month: '2000-01',
      range: {
        from: new Date('1999-12-31T17:00:00.000Z'),
        to: new Date('2000-01-30T17:00:00.000Z'),
      },
    });
  });

  it('accepts the current month (a partial month)', () => {
    expect(parseMonth('2026-11', NOW)).toMatchObject({ month: '2026-11' });
  });

  it.each([
    ['2026-1'],
    ['2026-13'],
    ['2026-00'],
    ['2026-01-01'],
    [''],
    [' 2026-01'],
    [undefined],
    [123],
    [['2026-01']],
    [null],
  ])('rejects the malformed value %j', (value) => {
    expect(parseMonth(value, NOW)).toBe('month must be YYYY-MM');
  });

  it('rejects a month after the current Vietnam month', () => {
    expect(parseMonth('2026-12', NOW)).toBe('month must not be in the future');
    expect(parseMonth('2027-01', NOW)).toBe('month must not be in the future');
  });

  it('uses the Vietnam month, not the UTC one, for the future check', () => {
    // 17:30 UTC on 30/11 is already 1 December in Vietnam.
    const early = new Date('2026-11-30T17:30:00Z');
    expect(parseMonth('2026-12', early)).toMatchObject({ month: '2026-12' });
    expect(parseMonth('2027-01', early)).toBe('month must not be in the future');
    // One minute before midnight in Vietnam it is still November.
    expect(parseMonth('2026-12', new Date('2026-11-30T16:59:00Z'))).toBe(
      'month must not be in the future',
    );
  });
});
