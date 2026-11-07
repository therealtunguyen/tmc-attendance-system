// Daily record builder (report v1: FR-3.4, FR-3.5, Listing 8.5). Pure: no I/O, so it is tested alone.
import type { DailyRecord, StoredEvent } from './attendance.service.js';

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

/**
 * One record per employee per local day with at least one granted scan. Only GRANTED events
 * are attendance transactions (glossary; FR-3.3); PENDING and DENIED are ignored.
 * firstIn / lastOut are the earliest / latest granted scan of the day, hours is the time between
 * them. A day with a single granted scan has no lastOut and is flagged as a missing punch.
 * Sorted by employeeId, then day.
 */
export const buildDailyRecords = (events: DailyInput[]): DailyRecord[] => {
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
      const first = Math.min(...times);
      const last = Math.max(...times);
      const missingPunch = times.length === 1;
      return {
        employeeId,
        day,
        firstIn: new Date(first),
        lastOut: missingPunch ? null : new Date(last),
        hours: missingPunch ? 0 : Math.round(((last - first) / HOUR_MS) * 100) / 100,
        missingPunch,
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
