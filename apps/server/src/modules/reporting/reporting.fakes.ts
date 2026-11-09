// In-memory fakes shared by the report tests.
import type { HrsClient, MonthlyBatch, SendResult } from '../../adapters/hrs/hrs-client.js';
import type { OrgUnit } from '../admin/index.js';
import type { DailyRecord } from '../attendance/index.js';
import type { EmployeeRoster, RosterEntry } from '../employee-qr/index.js';
import type { AuditEntry, AuditLog } from '../iam/index.js';
import type { DateRange } from '../../shared/types.js';
import type { EdgeSync, EdgeSyncStatus } from './reporting.edges.js';
import type { AlertKind, Notifier } from './reporting.notifier.js';
import { canClaim } from './reporting.runs.js';
import type { ExportResult, ExportRun, ExportRunStore, ExportTrigger } from './reporting.runs.js';

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
  constructor(private entries: RosterEntry[] = ROSTER) {}
  async roster(scope?: string): Promise<RosterEntry[]> {
    this.calls.push(scope);
    return this.entries.filter(
      (e) => scope === undefined || e.factoryId === scope || e.teamId === scope,
    );
  }
}

/** Attendance fake: records of the employees listed in the scope; remembers each call. */
export class FakeAttendance {
  calls: { range: DateRange; scope: string }[] = [];
  constructor(
    private entries: RosterEntry[] = ROSTER,
    private records: DailyRecord[] = RECORDS,
  ) {}
  async dailyRecords(range: DateRange, scope: string): Promise<DailyRecord[]> {
    this.calls.push({ range, scope });
    const ids = new Set(
      this.entries.filter((e) => e.factoryId === scope || e.teamId === scope).map((e) => e.id),
    );
    return this.records.filter((r) => ids.has(r.employeeId));
  }
}

/** Long An with 5 employees in la-pack, so it passes the EXE minimum group (FR-4.3). */
export const BIG_ROSTER: RosterEntry[] = [
  ...ROSTER.filter((e) => e.factoryId !== 'long-an'),
  ...['a', 'b', 'c', 'd', 'e'].map((n) => emp(`e-la-${n}`, 'long-an', 'la-pack')),
];
export const BIG_RECORDS: DailyRecord[] = [
  ...RECORDS.filter((r) => r.employeeId !== 'e-pack'),
  ...['a', 'b', 'c', 'd', 'e'].map((n) => day(`e-la-${n}`, 1, 8)),
];

export const fakeConfig = { orgUnits: async () => UNITS };

/** ExportRunStore fake: the same claim rule as the repo, rows kept in a map; returns copies. */
export class InMemoryExportRuns implements ExportRunStore {
  rows = new Map<string, ExportRun>();

  async find(month: string): Promise<ExportRun | null> {
    const row = this.rows.get(month);
    return row ? { ...row } : null;
  }

  async claim(
    month: string,
    trigger: ExportTrigger,
    at: Date,
    staleBefore: Date,
  ): Promise<ExportRun | null> {
    if (!canClaim(this.rows.get(month) ?? null, trigger, staleBefore)) return null;
    const run: ExportRun = {
      month,
      status: 'RUNNING',
      trigger,
      attempts: 0,
      lastError: null,
      startedAt: at,
      finishedAt: null,
    };
    this.rows.set(month, run);
    return { ...run };
  }

  async finish(
    month: string,
    { status, attempts, lastError, at }: ExportResult,
  ): Promise<ExportRun> {
    const row = this.rows.get(month);
    if (!row) throw new Error(`No export run for ${month}`);
    const run = { ...row, status, attempts, lastError, finishedAt: at };
    this.rows.set(month, run);
    return { ...run };
  }
}

/** HRS fake: answers from a script, one entry per call (the last repeats); records every batch. */
export class ScriptedHrs implements HrsClient {
  batches: MonthlyBatch[] = [];
  constructor(private script: readonly (SendResult | 'throw')[] = ['ACCEPTED']) {}

  async send(batch: MonthlyBatch): Promise<SendResult> {
    const step = this.script[Math.min(this.batches.length, this.script.length - 1)]!;
    this.batches.push(batch);
    if (step === 'throw') throw new Error('HRS unreachable');
    return step;
  }
}

/** EdgeSyncStatus fake: the list can be changed between calls. */
export class FakeEdgeSyncs implements EdgeSyncStatus {
  constructor(public edges: EdgeSync[] = []) {}
  async edgeSyncs(): Promise<EdgeSync[]> {
    return this.edges.map((e) => ({ ...e }));
  }
}

/** Notifier fake: records alerts; rejects when `fail` is set. */
export class RecordingNotifier implements Notifier {
  alerts: { kind: AlertKind; message: string }[] = [];
  fail = false;
  async alert(kind: AlertKind, message: string): Promise<void> {
    if (this.fail) throw new Error('mail down');
    this.alerts.push({ kind, message });
  }
}

export class RecordingAudit implements AuditLog {
  entries: AuditEntry[] = [];
  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
  async search(): Promise<AuditEntry[]> {
    return this.entries;
  }
}
