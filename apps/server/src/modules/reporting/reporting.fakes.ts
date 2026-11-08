// In-memory fakes shared by the report tests.
import type { OrgUnit } from '../admin/index.js';
import type { DailyRecord } from '../attendance/index.js';
import type { EmployeeRoster, RosterEntry } from '../employee-qr/index.js';
import type { DateRange } from '../../shared/types.js';

const unit = (id: string, kind: OrgUnit['kind'], parentId: string | null, name = id): OrgUnit => ({
  id,
  kind,
  name,
  parentId,
  supervisorIds: [],
});

export const UNITS: OrgUnit[] = [
  unit('binh-duong', 'FACTORY', null, 'Binh Duong'),
  unit('long-an', 'FACTORY', null, 'Long An'),
  unit('bd-prod', 'DEPARTMENT', 'binh-duong', 'Production BD'),
  unit('la-prod', 'DEPARTMENT', 'long-an', 'Production LA'),
  unit('bd-cut', 'TEAM', 'bd-prod', 'Cutting'),
  unit('bd-sew', 'TEAM', 'bd-prod', 'Sewing'),
  unit('la-pack', 'TEAM', 'la-prod', 'Packing'),
];

const emp = (
  id: string,
  factoryId: string,
  teamId: string | null,
  extra: Partial<RosterEntry> = {},
): RosterEntry => ({
  id,
  code: id.toUpperCase(),
  firstName: 'Lan',
  lastName: `Nguyen ${id}`,
  active: true,
  factoryId,
  teamId,
  ...extra,
});

export const ROSTER: RosterEntry[] = [
  emp('e-cut', 'binh-duong', 'bd-cut'),
  emp('e-sew', 'binh-duong', 'bd-sew'),
  emp('e-none', 'binh-duong', null),
  emp('e-gone', 'binh-duong', 'bd-cut', { active: false }),
  emp('e-pack', 'long-an', 'la-pack', { lastName: 'Tran, Van' }),
];

const day = (employeeId: string, d: number, hours: number, missingPunch = false): DailyRecord => ({
  employeeId,
  day: new Date(Date.UTC(2026, 9, d) - 7 * 3_600_000),
  firstIn: null,
  lastOut: null,
  hours,
  missingPunch,
});

export const RECORDS: DailyRecord[] = [
  day('e-cut', 1, 8),
  day('e-cut', 2, 7.5),
  day('e-sew', 1, 8, true),
  day('e-none', 1, 4),
  day('e-pack', 1, 8),
  day('e-pack', 2, 8),
];

/** Roster fake: filters on factoryId or teamId, like the real one. */
export class FakeRoster implements EmployeeRoster {
  calls: (string | undefined)[] = [];
  async roster(scope?: string): Promise<RosterEntry[]> {
    this.calls.push(scope);
    return ROSTER.filter((e) => scope === undefined || e.factoryId === scope || e.teamId === scope);
  }
}

/** Attendance fake: records of the employees listed in the scope; remembers each call. */
export class FakeAttendance {
  calls: { range: DateRange; scope: string }[] = [];
  async dailyRecords(range: DateRange, scope: string): Promise<DailyRecord[]> {
    this.calls.push({ range, scope });
    const ids = new Set(
      ROSTER.filter((e) => e.factoryId === scope || e.teamId === scope).map((e) => e.id),
    );
    return RECORDS.filter((r) => ids.has(r.employeeId));
  }
}

export const fakeConfig = { orgUnits: async () => UNITS };
