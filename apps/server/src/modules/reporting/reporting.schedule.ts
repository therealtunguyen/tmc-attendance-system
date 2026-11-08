// When the monthly HRS export runs (FR-4.5). The decision is pure; the timer is a thin serial loop.
import type { ConfigReader } from '../admin/index.js';
import type { ExportRun, ExportRunStore } from './reporting.runs.js';
import type { ScheduledExport } from './reporting.service.js';
import { VN_OFFSET_MS } from './reporting.month.js';

/** The export must be in HRS by 12:00 on day 1 (FR-4.5). */
export const EXPORT_DEADLINE = '12:00';
/** From this time on day 1 a run still waiting for edges fails and alerts, leaving an hour to react. */
export const LAST_CHANCE = '11:00';

/**
 * The missed-window alert is raised on day 1 (from EXPORT_DEADLINE) and day 2 only, covering a server that was down
 * during the window. Later the scheduler stays quiet: a month never exported shows as 404 on
 * GET /api/exports/:month and HR re-runs it (FR-4.6).
 */
export const MISSED_ALERT_LAST_DAY = 2;

export type ExportDecision =
  | { action: 'NONE' }
  | { action: 'RUN'; month: string; lastChance: boolean }
  | { action: 'MISSED'; month: string };

/** The month before the Vietnam local month of `now`, as YYYY-MM. */
export const previousMonth = (now: Date): string => {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  const index = local.getUTCFullYear() * 12 + local.getUTCMonth() - 1;
  const year = Math.floor(index / 12);
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/**
 * What the scheduler does now for the previous month (FR-4.5), in Vietnam time. `run` is that month's ExportRun.
 * DONE or FAILED -> NONE. Day 1 before monthlyAt -> NONE; from monthlyAt to EXPORT_DEADLINE -> RUN. After that, up to
 * day MISSED_ALERT_LAST_DAY, a RUNNING run is left alone and a missing or BLOCKED one is MISSED; later days -> NONE.
 */
export const exportDecision = (
  now: Date,
  monthlyAt: string,
  run: ExportRun | null,
): ExportDecision => {
  const month = previousMonth(now);
  if (run?.status === 'DONE' || run?.status === 'FAILED') return { action: 'NONE' };

  const local = new Date(now.getTime() + VN_OFFSET_MS);
  const time = local.toISOString().slice(11, 16);
  if (local.getUTCDate() === 1) {
    if (time < monthlyAt) return { action: 'NONE' };
    if (time < EXPORT_DEADLINE) return { action: 'RUN', month, lastChance: time >= LAST_CHANCE };
  }
  if (local.getUTCDate() > MISSED_ALERT_LAST_DAY) return { action: 'NONE' };
  // Past the window: a long retry may cross noon, but a month never started (or still waiting) is missed.
  return run?.status === 'RUNNING' ? { action: 'NONE' } : { action: 'MISSED', month };
};

/** Serial ticks, like the gate monitor: the next tick is scheduled after the current one settles. stop() waits for it. */
export const startExportScheduler = (
  tick: () => Promise<void>,
  interval = 60_000,
  onError: (error: unknown) => void = (error) => console.error('Export scheduler failed', error),
) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  const next = () => {
    running = tick()
      .catch(onError)
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(next, interval);
          timer.unref();
        }
      });
  };
  next();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
};

/** One scheduler tick (FR-4.5): reads the time setting and the previous month's run, then acts on exportDecision. */
export class ExportScheduler {
  constructor(
    private config: Pick<ConfigReader, 'get'>,
    private runs: Pick<ExportRunStore, 'find'>,
    private exporter: ScheduledExport,
    private now: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<void> {
    const now = this.now();
    const monthlyAt = (await this.config.get('export.monthlyAt')) ?? '06:00';
    const run = await this.runs.find(previousMonth(now));
    const decision = exportDecision(now, monthlyAt, run);
    if (decision.action === 'RUN')
      await this.exporter.runScheduled(decision.month, decision.lastChance);
    else if (decision.action === 'MISSED') await this.exporter.recordMissed(decision.month);
  }
}
