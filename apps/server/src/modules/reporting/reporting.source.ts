// One read of roster and daily records, shared by the monthly report and the HRS export.
import type { DateRange } from '../../shared/types.js';
import type { ConfigReader } from '../admin/index.js';
import type { AttendanceQuery, DailyRecord } from '../attendance/index.js';
import type { EmployeeRoster, RosterEntry } from '../employee-qr/index.js';
import { VN_OFFSET_MS } from './reporting.month.js';

export interface MonthData {
  employees: RosterEntry[];
  records: DailyRecord[];
}

/** Roster and daily records of these org units (factories or teams) for the range: two calls per unit, in parallel; employees de-duplicated by id. */
export const readMonth = async (
  roster: EmployeeRoster,
  attendance: Pick<AttendanceQuery, 'dailyRecords'>,
  scopes: readonly string[],
  range: DateRange,
): Promise<MonthData> => {
  const perFactory = await Promise.all(
    scopes.map(async (f) => {
      const [entries, records] = await Promise.all([
        roster.roster(f),
        attendance.dailyRecords(range, f),
      ]);
      return { entries, records };
    }),
  );
  const employees = new Map<string, RosterEntry>();
  const records: DailyRecord[] = [];
  for (const { entries, records: recs } of perFactory) {
    records.push(...recs);
    for (const e of entries) employees.set(e.id, e);
  }
  return { employees: [...employees.values()], records };
};

export interface MonthSource {
  /** Everyone in every factory for the range. */
  company(range: DateRange): Promise<MonthData>;
}

/** The whole company: every FACTORY unit of the org tree (FR-4.5). */
export class CompanyMonthSource implements MonthSource {
  constructor(
    private roster: EmployeeRoster,
    private attendance: Pick<AttendanceQuery, 'dailyRecords'>,
    private config: Pick<ConfigReader, 'orgUnits'>,
  ) {}

  async company(range: DateRange): Promise<MonthData> {
    const units = await this.config.orgUnits();
    const factoryIds = units.filter((u) => u.kind === 'FACTORY').map((u) => u.id);
    return readMonth(this.roster, this.attendance, factoryIds, range);
  }
}

/** One row of the HRS batch: no names or contact data (data minimisation, report Table 2.7). */
export interface HrsRow {
  employeeId: string;
  employeeCode: string;
  /** Vietnam local date, YYYY-MM-DD. */
  date: string;
  firstIn: string | null; // ISO 8601
  lastOut: string | null;
  hours: number;
  missingPunch: boolean;
}

/** One row per employee per day with a record; records of employees not listed are dropped. Sorted by code, then date. */
export const hrsRows = (
  employees: readonly Pick<RosterEntry, 'id' | 'code'>[],
  records: readonly DailyRecord[],
): HrsRow[] => {
  const codes = new Map(employees.map((e) => [e.id, e.code]));
  const rows: HrsRow[] = [];
  for (const r of records) {
    const employeeCode = codes.get(r.employeeId);
    if (employeeCode === undefined) continue;
    rows.push({
      employeeId: r.employeeId,
      employeeCode,
      date: new Date(r.day.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10),
      firstIn: r.firstIn?.toISOString() ?? null,
      lastOut: r.lastOut?.toISOString() ?? null,
      hours: r.hours,
      missingPunch: r.missingPunch,
    });
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((a, b) => compare(a.employeeCode, b.employeeCode) || compare(a.date, b.date));
};
