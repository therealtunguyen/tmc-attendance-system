import { describe, expect, it } from 'vitest';
import { InMemoryExportRuns } from './reporting.fakes.js';
import { canClaim } from './reporting.runs.js';
import type { ExportRun, ExportStatus, ExportTrigger } from './reporting.runs.js';

const STALE = new Date('2026-11-01T01:00:00Z');
const run = (status: ExportStatus, startedAt = new Date('2026-11-01T00:00:00Z')): ExportRun => ({
  month: '2026-10',
  status,
  trigger: 'SCHEDULE',
  attempts: 0,
  lastError: null,
  startedAt,
  finishedAt: null,
});

describe('canClaim', () => {
  it('allows a month with no run, for both triggers', () => {
    expect(canClaim(null, 'SCHEDULE', STALE)).toBe(true);
    expect(canClaim(null, 'MANUAL', STALE)).toBe(true);
  });

  it.each([
    ['BLOCKED', 'SCHEDULE', true],
    ['FAILED', 'SCHEDULE', false],
    ['DONE', 'SCHEDULE', false],
    ['BLOCKED', 'MANUAL', true],
    ['FAILED', 'MANUAL', true],
    ['DONE', 'MANUAL', true],
    ['RUNNING', 'SCHEDULE', false],
    ['RUNNING', 'MANUAL', false],
  ] as [ExportStatus, ExportTrigger, boolean][])('%s by %s -> %s', (status, trigger, expected) => {
    const startedAt = new Date(STALE.getTime() + 1); // a fresh RUNNING run
    expect(canClaim(run(status, startedAt), trigger, STALE)).toBe(expected);
  });

  it('takes over a RUNNING run only when it started before the stale limit', () => {
    const before = new Date(STALE.getTime() - 1);
    expect(canClaim(run('RUNNING', before), 'SCHEDULE', STALE)).toBe(true);
    expect(canClaim(run('RUNNING', before), 'MANUAL', STALE)).toBe(true);
    expect(canClaim(run('RUNNING', STALE), 'SCHEDULE', STALE)).toBe(false);
    expect(canClaim(run('RUNNING', new Date(STALE.getTime() + 1)), 'MANUAL', STALE)).toBe(false);
  });
});

describe('InMemoryExportRuns', () => {
  const at = new Date('2026-11-01T02:00:00Z'); // after STALE: a fresh run
  const finish = { status: 'DONE', attempts: 2, lastError: null, at } as const;

  it('claims a new month as RUNNING, and a second schedule claim loses', async () => {
    const runs = new InMemoryExportRuns();
    expect(await runs.claim('2026-10', 'SCHEDULE', at, STALE)).toEqual({
      month: '2026-10',
      status: 'RUNNING',
      trigger: 'SCHEDULE',
      attempts: 0,
      lastError: null,
      startedAt: at,
      finishedAt: null,
    });
    expect(await runs.claim('2026-10', 'SCHEDULE', at, STALE)).toBeNull();
  });

  it('stores the outcome, and a manual claim restarts a DONE month but the schedule does not', async () => {
    const runs = new InMemoryExportRuns();
    await runs.claim('2026-10', 'SCHEDULE', at, STALE);
    const done = await runs.finish('2026-10', finish);
    expect(done).toMatchObject({ status: 'DONE', attempts: 2, finishedAt: at });
    expect(await runs.find('2026-10')).toEqual(done);
    expect(await runs.claim('2026-10', 'SCHEDULE', at, STALE)).toBeNull();
    expect(await runs.claim('2026-10', 'MANUAL', at, STALE)).toMatchObject({
      status: 'RUNNING',
      trigger: 'MANUAL',
      attempts: 0,
      finishedAt: null,
    });
  });

  it('returns copies', async () => {
    const runs = new InMemoryExportRuns();
    const claimed = await runs.claim('2026-10', 'SCHEDULE', at, STALE);
    claimed!.status = 'DONE';
    expect((await runs.find('2026-10'))?.status).toBe('RUNNING');
  });
});
