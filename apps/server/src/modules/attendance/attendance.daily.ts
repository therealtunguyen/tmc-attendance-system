// Daily record builder (report v1: FR-3.4, FR-3.5, Listing 8.5). Pure: no I/O, so it is tested alone.
import type { Correction, DailyRecord, StoredEvent } from './attendance.service.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Both factories are in Vietnam: Asia/Ho_Chi_Minh is UTC+7 all year (no daylight saving). */
const VN_OFFSET_MS = 7 * HOUR_MS;

/** Start of the Vietnam local day that contains `at`, as an instant. */
export const localDayStart = (at: Date): Date =>
  new Date(Math.floor((at.getTime() + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS);

/** The day after `day` (a localDayStart). */
export const nextDay = (day: Date): Date => new Date(day.getTime() + DAY_MS);

export type DailyInput = Pick<StoredEvent, 'employeeId' | 'occurredAt' | 'outcome'>;

/** The Vietnam calendar date of a local day start, as YYYY-MM-DD. */
const dateOf = (day: Date): string =>
  new Date(day.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

/**
 * A daily record has no row of its own (it is computed on read), so its ID is the employee and the
 * day: <employeeId>_<YYYY-MM-DD>.
 */
export const recordIdOf = (record: Pick<DailyRecord, 'employeeId' | 'day'>): string =>
  `${record.employeeId}_${dateOf(record.day)}`;

/** Null when the ID is malformed or names a date that does not exist. */
export const parseRecordId = (id: string): Pick<DailyRecord, 'employeeId' | 'day'> | null => {
  const match = /^(.+)_(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (!match) return null;
  const [, employeeId, date] = match as unknown as [string, string, string];
  const day = new Date(`${date}T00:00:00+07:00`);
  return !Number.isNaN(day.getTime()) && dateOf(day) === date ? { employeeId, day } : null;
};

type DailyCorrection = Pick<
  Correction,
  'employeeId' | 'day' | 'field' | 'correctedValue' | 'createdAt'
>;

/** The value in force for one field of one day: the newest correction, the later one on a tie. */
const correctedValue = (
  corrections: DailyCorrection[],
  employeeId: string,
  day: Date,
  field: Correction['field'],
): Date | null => {
  let newest: DailyCorrection | null = null;
  for (const c of corrections) {
    if (c.employeeId !== employeeId || c.day.getTime() !== day.getTime() || c.field !== field) {
      continue;
    }
    if (!newest || c.createdAt.getTime() >= newest.createdAt.getTime()) newest = c;
  }
  return newest?.correctedValue ?? null;
};

/**
 * One record per employee per local day with at least one granted scan. Only GRANTED events
 * are attendance transactions (glossary; FR-3.3); PENDING and DENIED are ignored.
 * firstIn / lastOut are the earliest / latest granted scan of the day, hours is the time between
 * them. A day with a single granted scan has no lastOut and is flagged as a missing punch.
 * An HR correction replaces the value it names, and hours and the flag follow it (FR-3.6, UC-8);
 * the scans themselves are never changed.
 * Sorted by employeeId, then day.
 */
export const buildDailyRecords = (
  events: DailyInput[],
  corrections: DailyCorrection[] = [],
): DailyRecord[] => {
  const days = new Map<string, { employeeId: string; day: Date; times: number[] }>();
  for (const e of events) {
    if (e.outcome !== 'GRANTED' || e.employeeId === null) continue;
    const day = localDayStart(e.occurredAt);
    const key = `${e.employeeId}\u0000${day.getTime()}`;
    let entry = days.get(key);
    if (!entry) days.set(key, (entry = { employeeId: e.employeeId, day, times: [] }));
    entry.times.push(e.occurredAt.getTime());
  }

  return [...days.values()]
    .map(({ employeeId, day, times }): DailyRecord => {
      const correctedIn = correctedValue(corrections, employeeId, day, 'FIRST_IN');
      const correctedOut = correctedValue(corrections, employeeId, day, 'LAST_OUT');
      const firstIn = correctedIn ?? new Date(Math.min(...times));
      const lastOut = correctedOut ?? (times.length === 1 ? null : new Date(Math.max(...times)));
      const span = lastOut ? lastOut.getTime() - firstIn.getTime() : 0;
      return {
        employeeId,
        day,
        firstIn,
        lastOut,
        // Never negative: a late edge push can move a scan past a corrected value.
        hours: Math.round((Math.max(span, 0) / HOUR_MS) * 100) / 100,
        missingPunch: lastOut === null,
        ...(correctedIn || correctedOut ? { corrected: true } : {}),
      };
    })
    .sort((a, b) =>
      a.employeeId === b.employeeId
        ? a.day.getTime() - b.day.getTime()
        : a.employeeId < b.employeeId
          ? -1
          : 1,
    );
};
