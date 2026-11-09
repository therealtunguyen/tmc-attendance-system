import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  FakeAttendance,
  FakeEdgeSyncs,
  FakeRoster,
  InMemoryExportRuns,
  RecordingAudit,
  RecordingNotifier,
  ROSTER,
  ScriptedHrs,
  fakeConfig,
} from './reporting.fakes.js';
import type { ExportOptions } from './reporting.service.js';
import {
  EdgesNotSyncedError,
  ExportBusyError,
  HrExportService,
  InvalidExportMonthError,
} from './reporting.service.js';
import { CompanyMonthSource, hrsRows } from './reporting.source.js';
import type { MonthData, MonthSource } from './reporting.source.js';
import type { EdgeSync } from './reporting.edges.js';

const NOW = new Date('2026-11-01T06:00:00+07:00');
const MONTH_END = new Date('2026-10-31T17:00:00Z'); // 2026-11-01 00:00 in Vietnam
const SYNCED: EdgeSync[] = [
  { edgeId: 'edge-bd', factoryId: 'binh-duong', lastSyncAt: new Date('2026-11-01T01:00:00Z') },
  { edgeId: 'edge-la', factoryId: 'long-an', lastSyncAt: new Date('2026-11-01T01:00:00Z') },
];

let runs: InMemoryExportRuns;
let hrs: ScriptedHrs;
let edges: FakeEdgeSyncs;
let notifier: RecordingNotifier;
let audit: RecordingAudit;
let sleeps: number[];
let log: Mock<(message: string, error?: unknown) => void>;
let now: Date;
let source: MonthSource;

const build = (
  script: ConstructorParameters<typeof ScriptedHrs>[0] = ['ACCEPTED'],
  options: ExportOptions = {},
) => {
  hrs = new ScriptedHrs(script);
  return new HrExportService(runs, source, hrs, edges, notifier, audit, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => now,
    log,
    ...options,
  });
};

beforeEach(() => {
  runs = new InMemoryExportRuns();
  edges = new FakeEdgeSyncs(SYNCED.map((e) => ({ ...e })));
  notifier = new RecordingNotifier();
  audit = new RecordingAudit();
  sleeps = [];
  log = vi.fn<(message: string, error?: unknown) => void>();
  now = NOW;
  source = new CompanyMonthSource(new FakeRoster(), new FakeAttendance(), fakeConfig);
});

describe('scheduled export', () => {
  it('sends once and does not claim a DONE month again', async () => {
    const svc = build();
    expect((await svc.runScheduled('2026-10', false))?.status).toBe('DONE');
    expect(await svc.runScheduled('2026-10', false)).toBeNull();
    expect(hrs.batches).toHaveLength(1);
  });

  it('sends the whole company without names', async () => {
    const svc = build();
    await svc.runScheduled('2026-10', false);
    const data: MonthData = {
      employees: ROSTER,
      records: await new FakeAttendance().dailyRecords(
        { from: new Date(), to: new Date() },
        'binh-duong',
      ),
    };
    const batch = hrs.batches[0]!;
    expect(batch.month).toBe('2026-10');
    expect(batch.rows).toHaveLength(6);
    const ids = new Set((batch.rows as { employeeId: string }[]).map((r) => r.employeeId));
    expect(ids).toEqual(new Set(['e-cut', 'e-sew', 'e-none', 'e-pack']));
    expect(batch.rows.slice(0, 1)).toEqual(
      hrsRows(ROSTER, data.records)
        .filter((r) => r.employeeId === 'e-cut')
        .slice(0, 1),
    );
    const json = JSON.stringify(batch);
    expect(json).not.toContain('Lan');
    expect(json).not.toContain('Nguyen');
    expect(json).not.toContain('Tran');
  });

  it('stays DONE without an alert when HRS accepted but the audit write fails', async () => {
    const svc = build();
    const append = audit.append.bind(audit);
    vi.spyOn(audit, 'append').mockImplementation(async (entry) => {
      if (entry.action === 'EXPORT_DONE') throw new Error('audit down');
      return append(entry);
    });
    expect(await svc.runScheduled('2026-10', false)).toMatchObject({ status: 'DONE' });
    expect((await runs.find('2026-10'))?.status).toBe('DONE');
    expect(notifier.alerts).toEqual([]);
    expect(hrs.batches).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('audit'), expect.any(Error));
  });

  it('retries a thrown error: fails twice, then DONE without an alert', async () => {
    const svc = build(['throw', 'throw', 'ACCEPTED']);
    const run = await svc.runScheduled('2026-10', false);
    expect(run).toMatchObject({ status: 'DONE', attempts: 3, lastError: null });
    expect(sleeps).toEqual([60_000, 300_000]);
    expect(notifier.alerts).toEqual([]);
    expect(audit.entries.filter((e) => e.action === 'EXPORT_DONE')).toHaveLength(1);
    expect(audit.entries.find((e) => e.action === 'EXPORT_DONE')).toMatchObject({
      actorId: 'system',
      target: 'export:2026-10',
      after: { attempts: 3, rows: 6 },
    });
  });

  it('fails after 4 attempts with one alert and never retries by itself', async () => {
    const svc = build(['throw']);
    const run = await svc.runScheduled('2026-10', false);
    expect(run).toMatchObject({ status: 'FAILED', attempts: 4, lastError: 'HRS unreachable' });
    expect(sleeps).toEqual([60_000, 300_000, 900_000]);
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]!.kind).toBe('EXPORT_FAILED');
    expect(notifier.alerts[0]!.message).toContain('2026-10');
    expect(notifier.alerts[0]!.message).toContain('4 attempt(s)');
    expect(notifier.alerts[0]!.message).toContain('HRS unreachable');
    expect(audit.entries.find((e) => e.action === 'EXPORT_FAILED')).toMatchObject({
      after: { attempts: 4, error: 'HRS unreachable' },
    });
    expect(await svc.runScheduled('2026-10', false)).toBeNull();
    expect(notifier.alerts).toHaveLength(1);
    expect(hrs.batches).toHaveLength(4);
  });

  it('does not retry a REJECTED batch', async () => {
    const svc = build(['REJECTED']);
    const run = await svc.runScheduled('2026-10', false);
    expect(run).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'HRS rejected the batch',
    });
    expect(sleeps).toEqual([]);
    expect(notifier.alerts).toHaveLength(1);
  });

  it('cuts a long error to 500 characters', async () => {
    source = {
      company: async () => {
        throw new Error('x'.repeat(900));
      },
    };
    const run = await build().runScheduled('2026-10', false);
    expect(run?.lastError).toHaveLength(500);
  });
});

describe('edge sync check', () => {
  const unsynced = (): EdgeSync[] => [
    SYNCED[0]!,
    { edgeId: 'edge-la', factoryId: 'long-an', lastSyncAt: null },
  ];

  it('blocks quietly before the last chance, then runs once the edge syncs', async () => {
    edges.edges = unsynced();
    const svc = build();
    const blocked = await svc.runScheduled('2026-10', false);
    expect(blocked?.status).toBe('BLOCKED');
    expect(blocked?.lastError).toBe('Waiting for edge sync: edge-la (long-an, never synced)');
    expect(notifier.alerts).toEqual([]);
    expect(hrs.batches).toEqual([]);
    expect(audit.entries).toEqual([]);

    edges.edges = SYNCED.map((e) => ({ ...e }));
    expect((await svc.runScheduled('2026-10', false))?.status).toBe('DONE');
    expect(hrs.batches).toHaveLength(1);
  });

  it('fails with one alert naming the edges on the last chance', async () => {
    edges.edges = [
      { edgeId: 'edge-bd', factoryId: 'binh-duong', lastSyncAt: new Date('2026-10-31T10:00:00Z') },
      { edgeId: 'edge-la', factoryId: 'long-an', lastSyncAt: null },
    ];
    const run = await build().runScheduled('2026-10', true);
    expect(run?.status).toBe('FAILED');
    expect(hrs.batches).toEqual([]);
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]!.message).toBe(
      'HRS export of 2026-10 failed: edges not synced since the month ended: edge-bd (binh-duong, last sync 2026-10-31T10:00:00.000Z), edge-la (long-an, never synced). Re-run once they sync, or with ignoreUnsyncedEdges.',
    );
    expect(audit.entries.map((e) => e.action)).toEqual(['EXPORT_FAILED']);
    expect(audit.entries[0]!.after).toMatchObject({ attempts: 0 });
  });

  it('counts a sync exactly at the month end as synced', async () => {
    edges.edges = SYNCED.map((e) => ({ ...e, lastSyncAt: MONTH_END }));
    expect((await build().runScheduled('2026-10', false))?.status).toBe('DONE');
  });

  it('does not count a sync one millisecond before the month end', async () => {
    edges.edges = SYNCED.map((e) => ({ ...e, lastSyncAt: new Date(MONTH_END.getTime() - 1) }));
    expect((await build().runScheduled('2026-10', false))?.status).toBe('BLOCKED');
  });
});

describe('recordMissed', () => {
  it('stores FAILED, audits and alerts once', async () => {
    const svc = build();
    const run = await svc.recordMissed('2026-10');
    expect(run).toMatchObject({
      status: 'FAILED',
      lastError: 'Missed the export window (day 1 before 12:00)',
    });
    expect(notifier.alerts).toEqual([
      {
        kind: 'EXPORT_FAILED',
        message:
          'HRS export of 2026-10 did not run in its window (day 1 before 12:00). Re-run it with POST /api/exports/2026-10/rerun.',
      },
    ]);
    expect(audit.entries.map((e) => e.action)).toEqual(['EXPORT_FAILED']);
    expect(await svc.recordMissed('2026-10')).toBeNull();
    expect(notifier.alerts).toHaveLength(1);
  });
});

describe('recordMissed keeps what the previous run said', () => {
  it('after BLOCKED: the unsynced edges stay in lastError and in the alert', async () => {
    edges.edges = [{ edgeId: 'edge-la', factoryId: 'long-an', lastSyncAt: null }];
    const svc = build();
    await svc.runScheduled('2026-10', false);
    const run = await svc.recordMissed('2026-10');
    const waiting = 'Waiting for edge sync: edge-la (long-an, never synced)';
    expect(run).toMatchObject({
      status: 'FAILED',
      lastError: `Missed the export window (day 1 before 12:00). ${waiting}`,
    });
    expect(notifier.alerts).toEqual([
      {
        kind: 'EXPORT_FAILED',
        message: `HRS export of 2026-10 did not run in its window (day 1 before 12:00): ${waiting}. Re-run it with POST /api/exports/2026-10/rerun.`,
      },
    ]);
    expect(audit.entries.map((e) => e.action)).toEqual(['EXPORT_FAILED']);
  });

  it('after a stale RUNNING run: says it never finished, with the start time', async () => {
    const startedAt = new Date(NOW.getTime() - 3 * 3_600_000);
    runs.rows.set('2026-10', {
      month: '2026-10',
      status: 'RUNNING',
      trigger: 'SCHEDULE',
      attempts: 0,
      lastError: null,
      startedAt,
      finishedAt: null,
    });
    const run = await build().recordMissed('2026-10');
    const since = startedAt.toISOString();
    expect(run).toMatchObject({
      status: 'FAILED',
      lastError: `Started at ${since} and never finished (the server stopped during the run)`,
    });
    expect(notifier.alerts).toEqual([
      {
        kind: 'EXPORT_FAILED',
        message: `HRS export of 2026-10 did not finish: it started at ${since} and the server stopped before it ended. Re-run it with POST /api/exports/2026-10/rerun.`,
      },
    ]);
  });
});

describe('rerun (FR-4.6)', () => {
  const NOV_15 = new Date('2026-11-15T09:00:00+07:00');

  it('rejects the current and future months', async () => {
    now = NOV_15;
    const svc = build();
    for (const month of ['2026-11', '2026-12', 'nope']) {
      await expect(svc.rerun('hr-1', month, { ignoreUnsyncedEdges: false })).rejects.toThrow(
        InvalidExportMonthError,
      );
    }
    expect(runs.rows.size).toBe(0);
  });

  it('re-runs a DONE month: RUNNING at once, DONE when finished, with the actor audited', async () => {
    const svc = build();
    await svc.runScheduled('2026-10', false);
    now = NOV_15;
    const { run, finished } = await svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false });
    expect(run).toMatchObject({ month: '2026-10', status: 'RUNNING', trigger: 'MANUAL' });
    expect((await finished).status).toBe('DONE');
    expect(hrs.batches).toHaveLength(2);
    const rerun = audit.entries.find((e) => e.action === 'EXPORT_RERUN');
    expect(rerun).toMatchObject({
      actorId: 'hr-1',
      target: 'export:2026-10',
      after: { ignoreUnsyncedEdges: false },
    });
    expect(audit.entries.filter((e) => e.action === 'EXPORT_DONE').at(-1)!.actorId).toBe('hr-1');
  });

  it('refuses while an edge is unsynced, without claiming; the flag overrides', async () => {
    now = NOV_15;
    edges.edges = [{ edgeId: 'edge-la', factoryId: 'long-an', lastSyncAt: null }];
    const svc = build();
    const error = await svc
      .rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EdgesNotSyncedError);
    expect((error as EdgesNotSyncedError).edges.map((e) => e.edgeId)).toEqual(['edge-la']);
    expect(runs.rows.size).toBe(0);

    const { finished } = await svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: true });
    expect((await finished).status).toBe('DONE');
    expect(audit.entries.find((e) => e.action === 'EXPORT_RERUN')!.after).toEqual({
      ignoreUnsyncedEdges: true,
    });
  });

  it('is busy while RUNNING, and takes over a stale RUNNING run', async () => {
    now = NOV_15;
    const svc = build();
    let release!: () => void;
    const slow: MonthSource = {
      company: () =>
        new Promise<MonthData>((r) => (release = () => r({ employees: [], records: [] }))),
    };
    source = slow;
    const first = build();
    const started = await first.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false });
    await expect(svc.rerun('hr-2', '2026-10', { ignoreUnsyncedEdges: false })).rejects.toThrow(
      ExportBusyError,
    );
    release();
    await started.finished;

    // Stale: a RUNNING row from long ago.
    runs.rows.set('2026-09', {
      month: '2026-09',
      status: 'RUNNING',
      trigger: 'SCHEDULE',
      attempts: 0,
      lastError: null,
      startedAt: new Date(NOV_15.getTime() - 3 * 3_600_000),
      finishedAt: null,
    });
    source = new CompanyMonthSource(new FakeRoster(), new FakeAttendance(), fakeConfig);
    const { finished } = await build().rerun('hr-1', '2026-09', { ignoreUnsyncedEdges: false });
    expect((await finished).status).toBe('DONE');
  });
});

describe('rerun when the audit write fails', () => {
  const NOV_15 = new Date('2026-11-15T09:00:00+07:00');
  const failRerunAudit = () => {
    const append = audit.append.bind(audit);
    vi.spyOn(audit, 'append').mockImplementation(async (entry) => {
      if (entry.action === 'EXPORT_RERUN') throw new Error('audit down');
      return append(entry);
    });
  };

  it('puts the previous DONE outcome back', async () => {
    const svc = build(['throw', 'ACCEPTED']);
    await svc.runScheduled('2026-10', false);
    const before = await svc.status('2026-10');
    expect(before).toMatchObject({ status: 'DONE', attempts: 2 });
    now = NOV_15;
    failRerunAudit();
    await expect(svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false })).rejects.toThrow(
      'audit down',
    );
    expect(await svc.status('2026-10')).toMatchObject({
      status: 'DONE',
      attempts: 2,
      lastError: null,
      finishedAt: before!.finishedAt,
    });
    expect(hrs.batches).toHaveLength(2);
    expect(notifier.alerts).toEqual([]);
  });

  it('ends FAILED when there was no previous run', async () => {
    now = NOV_15;
    const svc = build();
    failRerunAudit();
    await expect(svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false })).rejects.toThrow(
      'audit down',
    );
    expect(await svc.status('2026-10')).toMatchObject({
      status: 'FAILED',
      attempts: 0,
      lastError: 'audit down',
    });
    expect(hrs.batches).toEqual([]);
  });
});

describe('empty month', () => {
  it('sends nothing, ends FAILED with one alert and an audit entry', async () => {
    source = { company: async () => ({ employees: [], records: [] }) };
    const run = await build().runScheduled('2026-10', false);
    expect(run).toMatchObject({
      status: 'FAILED',
      attempts: 0,
      lastError: 'No attendance records for 2026-10; nothing was sent to HRS',
    });
    expect(hrs.batches).toEqual([]);
    expect(notifier.alerts).toHaveLength(1);
    expect(audit.entries.map((e) => e.action)).toEqual(['EXPORT_RUN', 'EXPORT_FAILED']);
    expect(audit.entries[1]!.after).toMatchObject({ attempts: 0 });
  });

  it('fails a manual rerun the same way', async () => {
    source = { company: async () => ({ employees: [], records: [] }) };
    now = new Date('2026-11-15T09:00:00+07:00');
    const { finished } = await build().rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false });
    expect((await finished).status).toBe('FAILED');
    expect(hrs.batches).toEqual([]);
    expect(notifier.alerts).toHaveLength(1);
  });
});

describe('stop (shutdown)', () => {
  // The default sleep (60 s) is used on purpose: stop() must cut it short.
  const sleeping = () => build(['throw'], { sleep: undefined, retryDelaysMs: [60_000] });
  const inRetrySleep = () => vi.waitFor(() => expect(hrs.batches).toHaveLength(1));

  it('ends a scheduled run BLOCKED, quietly, without waiting for the retry sleep', async () => {
    const svc = sleeping();
    const pending = svc.runScheduled('2026-10', false);
    await inRetrySleep();
    const started = Date.now();
    await svc.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await pending).toMatchObject({
      status: 'BLOCKED',
      attempts: 1,
      lastError: 'Interrupted by shutdown after 1 attempt(s)',
    });
    expect(hrs.batches).toHaveLength(1);
    expect(notifier.alerts).toEqual([]);
    expect(audit.entries.some((e) => e.action === 'EXPORT_FAILED')).toBe(false);
  });

  it('ends an interrupted manual rerun FAILED with audit and one alert', async () => {
    now = new Date('2026-11-15T09:00:00+07:00');
    const svc = sleeping();
    const { finished } = await svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false });
    await inRetrySleep();
    await svc.stop();
    expect(await finished).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'Interrupted by shutdown after 1 attempt(s)',
    });
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]!.message).toContain('2026-10');
    expect(audit.entries.filter((e) => e.action === 'EXPORT_FAILED')).toHaveLength(1);
  });

  it('refuses new work after stop', async () => {
    now = new Date('2026-11-15T09:00:00+07:00');
    const svc = build();
    await svc.stop();
    expect(await svc.runScheduled('2026-10', false)).toBeNull();
    expect(await svc.recordMissed('2026-10')).toBeNull();
    await expect(svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false })).rejects.toThrow(
      ExportBusyError,
    );
    expect(runs.rows.size).toBe(0);
  });

  it('waits for a manual rerun that is still running', async () => {
    now = new Date('2026-11-15T09:00:00+07:00');
    let release!: () => void;
    source = {
      company: () =>
        new Promise<MonthData>((r) => (release = () => r({ employees: [], records: [] }))),
    };
    const svc = build();
    const { finished } = await svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false });
    let stopped = false;
    const stopping = svc.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await runs.find('2026-10'))?.status).not.toBe('RUNNING');
    expect((await finished).status).toBe('FAILED');
  });
});

describe('unexpected failures', () => {
  it('stores FAILED and alerts when the source throws; finished resolves', async () => {
    source = {
      company: async () => {
        throw new Error('db down');
      },
    };
    const svc = build();
    const run = await svc.runScheduled('2026-10', false);
    expect(run).toMatchObject({ status: 'FAILED', lastError: 'db down' });
    expect(notifier.alerts).toHaveLength(1);
    expect(log).toHaveBeenCalled();
    expect(hrs.batches).toEqual([]);

    now = new Date('2026-11-15T09:00:00+07:00');
    const { finished } = await svc.rerun('hr-1', '2026-10', { ignoreUnsyncedEdges: false });
    expect((await finished).status).toBe('FAILED');
  });

  it('keeps the run FAILED and logs when the alert cannot be sent', async () => {
    notifier.fail = true;
    const run = await build(['throw']).runScheduled('2026-10', false);
    expect(run?.status).toBe('FAILED');
    expect(runs.rows.get('2026-10')!.status).toBe('FAILED');
    expect(log).toHaveBeenCalled();
  });

  it('fails the run when the edge status cannot be read', async () => {
    edges.edgeSyncs = async () => {
      throw new Error('gate db down');
    };
    const run = await build().runScheduled('2026-10', false);
    expect(run).toMatchObject({ status: 'FAILED', lastError: 'gate db down' });
    expect(notifier.alerts).toHaveLength(1);
  });
});

describe('status', () => {
  it('returns the stored run or null', async () => {
    const svc = build();
    expect(await svc.status('2026-10')).toBeNull();
    await svc.runScheduled('2026-10', false);
    expect((await svc.status('2026-10'))?.status).toBe('DONE');
  });
});
