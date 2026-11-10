import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExportScheduler,
  exportDecision,
  previousMonth,
  startExportScheduler,
} from './reporting.schedule.js';
import type { ExportRun, ExportStatus } from './reporting.runs.js';

/** Vietnam local time -> instant (UTC+7). */
const vn = (local: string) => new Date(`${local}:00+07:00`);
const run = (status: ExportStatus, startedAt = vn('2026-11-01T06:00')): ExportRun => ({
  month: '2026-10',
  status,
  trigger: 'SCHEDULE',
  attempts: 0,
  lastError: null,
  startedAt,
  finishedAt: null,
});
const HOUR = 3_600_000;
/** Decision at `now` with the default 2 h staleness rule. */
const decide = (now: Date, r: ExportRun | null, monthlyAt = '06:00') =>
  exportDecision(now, monthlyAt, r, new Date(now.getTime() - 2 * HOUR));
const at = (time: string, r: ExportRun | null = null, monthlyAt = '06:00') =>
  decide(vn(`2026-11-01T${time}`), r, monthlyAt);

describe('previousMonth', () => {
  it('is the month before the Vietnam local month', () => {
    expect(previousMonth(vn('2026-11-01T06:00'))).toBe('2026-10');
    expect(previousMonth(vn('2026-11-30T23:59'))).toBe('2026-10');
  });

  it('crosses the year, using Vietnam time', () => {
    expect(previousMonth(vn('2027-01-01T00:30'))).toBe('2026-12');
    // 17:30Z on Dec 31 is already Jan 1 in Vietnam
    expect(previousMonth(new Date('2026-12-31T17:30:00Z'))).toBe('2026-12');
    expect(previousMonth(new Date('2026-12-31T16:30:00Z'))).toBe('2026-11');
  });
});

describe('exportDecision', () => {
  it('waits for the configured time on day 1', () => {
    expect(at('05:59')).toEqual({ action: 'NONE' });
    expect(at('00:00')).toEqual({ action: 'NONE' });
  });

  it('runs from the configured time, with last chance from 11:00', () => {
    const run10 = (lastChance: boolean) => ({ action: 'RUN', month: '2026-10', lastChance });
    expect(at('06:00')).toEqual(run10(false));
    expect(at('10:59')).toEqual(run10(false));
    expect(at('11:00')).toEqual(run10(true));
    expect(at('11:59')).toEqual(run10(true));
  });

  it('honours a monthlyAt after the last-chance time', () => {
    expect(at('11:29', null, '11:30')).toEqual({ action: 'NONE' });
    expect(at('11:30', null, '11:30')).toEqual({
      action: 'RUN',
      month: '2026-10',
      lastChance: true,
    });
  });

  it('reports a missed month from 12:00 on day 1 through day 2', () => {
    const missed = { action: 'MISSED', month: '2026-10' };
    expect(at('12:00')).toEqual(missed);
    expect(decide(vn('2026-11-02T00:00'), null)).toEqual(missed);
    expect(decide(vn('2026-11-02T08:00'), null)).toEqual(missed);
    expect(decide(vn('2026-11-02T23:59'), null)).toEqual(missed);
  });

  it('stays quiet from day 3, e.g. a server first started mid-month', () => {
    expect(decide(vn('2026-11-03T00:00'), null)).toEqual({ action: 'NONE' });
    expect(decide(vn('2026-11-08T09:00'), null)).toEqual({ action: 'NONE' });
    expect(decide(vn('2026-11-03T08:00'), run('BLOCKED'))).toEqual({
      action: 'NONE',
    });
  });

  it('never acts on a DONE or FAILED month', () => {
    for (const status of ['DONE', 'FAILED'] as const) {
      for (const time of ['05:00', '08:00', '11:30', '12:30']) {
        expect(at(time, run(status))).toEqual({ action: 'NONE' });
      }
      expect(decide(vn('2026-11-03T08:00'), run(status))).toEqual({
        action: 'NONE',
      });
    }
  });

  it('resumes a BLOCKED month in the window and misses it after', () => {
    expect(at('08:00', run('BLOCKED'))).toEqual({
      action: 'RUN',
      month: '2026-10',
      lastChance: false,
    });
    expect(at('12:30', run('BLOCKED'))).toEqual({ action: 'MISSED', month: '2026-10' });
  });

  it('lets a fresh RUNNING run cross noon, and leaves staleness to the store in the window', () => {
    const fresh = (now: Date) => run('RUNNING', new Date(now.getTime() - 10 * 60_000));
    const noon = vn('2026-11-01T13:00');
    expect(decide(noon, fresh(noon))).toEqual({ action: 'NONE' });
    expect(at('12:30', run('RUNNING', vn('2026-11-01T11:00')))).toEqual({ action: 'NONE' });
    expect(at('08:00', run('RUNNING'))).toEqual({
      action: 'RUN',
      month: '2026-10',
      lastChance: false,
    });
  });

  it('reports a stale RUNNING run as missed after the window, on any day', () => {
    // the reviewer's repro: started hours earlier, now day 1 13:00 Vietnam (06:00Z)
    const now = new Date('2026-12-01T06:00:00Z');
    const stale = {
      ...run('RUNNING'),
      month: '2026-11',
      startedAt: new Date('2026-12-01T00:00:00Z'),
    };
    expect(exportDecision(now, '06:00', stale, new Date(now.getTime() - 2 * HOUR))).toEqual({
      action: 'MISSED',
      month: '2026-11',
    });
    const day10 = vn('2026-11-10T09:00');
    expect(decide(day10, run('RUNNING', new Date(day10.getTime() - 3 * HOUR)))).toEqual({
      action: 'MISSED',
      month: '2026-10',
    });
  });

  it('takes over a stale RUNNING run in the window', () => {
    const now = vn('2026-11-01T08:00');
    expect(decide(now, run('RUNNING', new Date(now.getTime() - 3 * HOUR)))).toEqual({
      action: 'RUN',
      month: '2026-10',
      lastChance: false,
    });
  });

  it('does not treat a RUNNING run started exactly at staleBefore as stale', () => {
    const now = vn('2026-11-05T09:00');
    const staleBefore = new Date(now.getTime() - 2 * HOUR);
    expect(exportDecision(now, '06:00', run('RUNNING', staleBefore), staleBefore)).toEqual({
      action: 'NONE',
    });
    expect(
      exportDecision(
        now,
        '06:00',
        run('RUNNING', new Date(staleBefore.getTime() - 1)),
        staleBefore,
      ),
    ).toEqual({ action: 'MISSED', month: '2026-10' });
  });
});

describe('startExportScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('runs ticks serially and stop() waits for the running tick', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let release!: () => void;
    const tick = vi.fn(async () => {
      events.push('start');
      await new Promise<void>((r) => (release = r));
      events.push('end');
    });
    const stop = startExportScheduler(tick, 1000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1); // still running: no overlap

    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(events).toEqual(['start', 'end']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('schedules the next tick after the previous settles', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const stop = startExportScheduler(tick, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    await stop();
  });

  it('reports an error and keeps ticking', async () => {
    vi.useFakeTimers();
    const boom = new Error('boom');
    const tick = vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startExportScheduler(tick, 1000, onError);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(tick).toHaveBeenCalledTimes(2);
    await stop();
  });
});

describe('ExportScheduler', () => {
  const setup = (
    local: string,
    monthlyAt?: string,
    existing: ExportRun | null = null,
    options: { staleAfterMs?: number } = {},
  ) => {
    const log = vi.fn();
    const exporter = {
      runScheduled: vi.fn(async () => null),
      recordMissed: vi.fn(async () => null),
    };
    const scheduler = new ExportScheduler(
      { get: async () => monthlyAt },
      { find: async (month) => (existing && existing.month === month ? existing : null) },
      exporter,
      { now: () => vn(local), log, ...options },
    );
    return { exporter, scheduler, log };
  };

  it('does nothing before the configured time', async () => {
    const { exporter, scheduler } = setup('2026-11-01T05:00');
    await scheduler.tick();
    expect(exporter.runScheduled).not.toHaveBeenCalled();
    expect(exporter.recordMissed).not.toHaveBeenCalled();
  });

  it('runs the previous month from 06:00, with last chance from 11:00', async () => {
    const early = setup('2026-11-01T06:00');
    await early.scheduler.tick();
    expect(early.exporter.runScheduled).toHaveBeenCalledWith('2026-10', false);
    const late = setup('2026-11-01T11:00');
    await late.scheduler.tick();
    expect(late.exporter.runScheduled).toHaveBeenCalledWith('2026-10', true);
  });

  it('records a missed month on day 2', async () => {
    const { exporter, scheduler } = setup('2026-11-02T08:00');
    await scheduler.tick();
    expect(exporter.recordMissed).toHaveBeenCalledWith('2026-10');
    expect(exporter.runScheduled).not.toHaveBeenCalled();
  });

  it('does nothing on day 8 when the month has no run', async () => {
    const { exporter, scheduler } = setup('2026-11-08T09:00');
    await scheduler.tick();
    expect(exporter.runScheduled).not.toHaveBeenCalled();
    expect(exporter.recordMissed).not.toHaveBeenCalled();
  });

  it('does nothing for a DONE month', async () => {
    const { exporter, scheduler } = setup('2026-11-01T08:00', undefined, run('DONE'));
    await scheduler.tick();
    expect(exporter.runScheduled).not.toHaveBeenCalled();
    expect(exporter.recordMissed).not.toHaveBeenCalled();
  });

  it('respects the configured time', async () => {
    const before = setup('2026-11-01T07:00', '07:30');
    await before.scheduler.tick();
    expect(before.exporter.runScheduled).not.toHaveBeenCalled();
    const after = setup('2026-11-01T07:30', '07:30');
    await after.scheduler.tick();
    expect(after.exporter.runScheduled).toHaveBeenCalledWith('2026-10', false);
  });

  it('records a stale RUNNING run as missed', async () => {
    const { exporter, scheduler } = setup(
      '2026-11-05T09:00',
      undefined,
      run('RUNNING', vn('2026-11-05T06:00')),
    );
    await scheduler.tick();
    expect(exporter.recordMissed).toHaveBeenCalledWith('2026-10');
    expect(exporter.runScheduled).not.toHaveBeenCalled();
  });

  it('respects the staleAfterMs option', async () => {
    const started = run('RUNNING', vn('2026-11-05T08:30'));
    const lenient = setup('2026-11-05T09:00', undefined, started);
    await lenient.scheduler.tick();
    expect(lenient.exporter.recordMissed).not.toHaveBeenCalled();
    const strict = setup('2026-11-05T09:00', undefined, started, { staleAfterMs: 20 * 60_000 });
    await strict.scheduler.tick();
    expect(strict.exporter.recordMissed).toHaveBeenCalledWith('2026-10');
  });

  it('falls back to 06:00 and logs when monthlyAt is not zero-padded HH:MM', async () => {
    const { exporter, scheduler, log } = setup('2026-11-01T06:00', '9:00');
    await scheduler.tick();
    expect(exporter.runScheduled).toHaveBeenCalledWith('2026-10', false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('9:00');
    const valid = setup('2026-11-01T06:00', '07:00');
    await valid.scheduler.tick();
    expect(valid.log).not.toHaveBeenCalled();
  });
});
