// Report month parsing (FR-4.1). Pure: the clock is a parameter, so it is tested alone.
import type { DateRange } from '../../shared/types.js';

const HOUR_MS = 3_600_000;
/** Both factories are in Vietnam: Asia/Ho_Chi_Minh is UTC+7 all year (no daylight saving). */
export const VN_OFFSET_MS = 7 * HOUR_MS;

/** A report month: 'YYYY-MM' and its Vietnam local days, first to last, both included (like AttendanceQuery.dailyRecords). */
export interface ReportMonth {
  month: string;
  range: DateRange;
}

/**
 * Parses ?month=YYYY-MM (FR-4.1). Returns an error message instead of throwing, for a 400.
 * The current Vietnam month is allowed (a partial month); a later one is rejected.
 */
export const parseMonth = (value: unknown, now: Date): ReportMonth | string => {
  const match = typeof value === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value) : null;
  if (!match) return 'month must be YYYY-MM';
  const year = Number(match[1]);
  const month = Number(match[2]);
  // Date.UTC maps years 0-99 to 1900-1999, which would not match the month echoed back.
  if (year < 2000) return 'month must be YYYY-MM from 2000 on';

  const local = new Date(now.getTime() + VN_OFFSET_MS);
  const current = local.getUTCFullYear() * 12 + local.getUTCMonth();
  if (year * 12 + (month - 1) > current) return 'month must not be in the future';

  return {
    month: value as string,
    range: {
      from: new Date(Date.UTC(year, month - 1, 1) - VN_OFFSET_MS),
      // Day 0 of the next month is the last day of this one.
      to: new Date(Date.UTC(year, month, 0) - VN_OFFSET_MS),
    },
  };
};
