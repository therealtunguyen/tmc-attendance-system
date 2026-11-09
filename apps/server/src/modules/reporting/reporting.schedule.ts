// When the monthly HRS export runs (FR-4.5). The decision is pure; the timer is a thin serial loop.
import type { ConfigReader } from '../admin/index.js';
import { STALE_AFTER_MS, type ExportRun, type ExportRunStore } from './reporting.runs.js';
import type { ScheduledExport } from './reporting.service.js';
import { VN_OFFSET_MS } from './reporting.month.js';

/** The export must be in HRS by 12:00 on day 1 (FR-4.5). */
export const EXPORT_DEADLINE = '12:00';
/** From this time on day 1 a run still waiting for edges fails and alerts, leaving an hour to react. */
export const LAST_CHANCE = '11:00';

/**
 * A missing or BLOCKED month is reported as missed on day 1 (from EXPORT_DEADLINE) and day 2 only, covering a server
 * that was down during the window. Later the scheduler stays quiet: a month never exported shows as 404 on
 * GET /api/exports/:month and HR re-runs it (FR-4.6). A stale RUNNING run (an export that started and died) is
 * exempt: it is reported on any day, since that is never a first-deployment false alarm.
 */
export const MISSED_ALERT_LAST_DAY = 2;

/** Used when the configured time is not a zero-padded HH:MM. */
const DEFAULT_MONTHLY_AT = '06:00';
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

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
 * What the scheduler does now for the previous month (FR-4.5), in Vietnam time. `run` is that month's ExportRun; a
 * RUNNING run started before `staleBefore` is stale (crashed). Rules in order:
 * DONE or FAILED -> NONE. Day 1 before monthlyAt -> NONE. Day 1 from monthlyAt to EXPORT_DEADLINE -> RUN (a stale
 * RUNNING run is taken over by the store's claim). After that: a stale RUNNING run -> MISSED on any day; a fresh
 * RUNNING run -> NONE (a long retry may cross noon); a missing or BLOCKED run -> MISSED up to day
 * MISSED_ALERT_LAST_DAY, else NONE.
 */
export const exportDecision = (
  now: Date,
  monthlyAt: string,
  run: ExportRun | null,
  staleBefore: Date,
): ExportDecision => {
  const month = previousMonth(now);
  if (run?.status === 'DONE' || run?.status === 'FAILED') return { action: 'NONE' };

  const local = new Date(now.getTime() + VN_OFFSET_MS);
  const time = local.toISOString().slice(11, 16);
  if (local.getUTCDate() === 1) {
    if (time < monthlyAt) return { action: 'NONE' };
    if (time < EXPORT_DEADLINE) return { action: 'RUN', month, lastChance: time >= LAST_CHANCE };
  }
  if (run?.status === 'RUNNING') {
    return run.startedAt < staleBefore ? { action: 'MISSED', month } : { action: 'NONE' };
  }
  if (local.getUTCDate() > MISSED_ALERT_LAST_DAY) return { action: 'NONE' };
  return { action: 'MISSED', month };
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
export interface ExportSchedulerOptions {
  now?: () => Date;
  /** A RUNNING run older than this is stale. Default STALE_AFTER_MS. */
  staleAfterMs?: number;
  log?: (message: string) => void;
}

export class ExportScheduler {
  private now: () => Date;
  private staleAfterMs: number;
  private log: (message: string) => void;

  constructor(
    private config: Pick<ConfigReader, 'get'>,
    private runs: Pick<ExportRunStore, 'find'>,
    private exporter: ScheduledExport,
    options: ExportSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
    this.log = options.log ?? ((message) => console.error(message));
  }

  async tick(): Promise<void> {
    const now = this.now();
    let monthlyAt = (await this.config.get('export.monthlyAt')) ?? DEFAULT_MONTHLY_AT;
    if (!HH_MM.test(monthlyAt)) {
      this.log(`Invalid export.monthlyAt "${monthlyAt}", using ${DEFAULT_MONTHLY_AT}`);
      monthlyAt = DEFAULT_MONTHLY_AT;
    }
    const run = await this.runs.find(previousMonth(now));
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    const decision = exportDecision(now, monthlyAt, run, staleBefore);
    if (decision.action === 'RUN')
      await this.exporter.runScheduled(decision.month, decision.lastChance);
    else if (decision.action === 'MISSED') await this.exporter.recordMissed(decision.month);
  }
}
