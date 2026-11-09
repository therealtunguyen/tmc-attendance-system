// State of one month's HRS export (FR-4.5, FR-4.6) and the rule for who may start it. Pure.

export type ExportStatus = 'RUNNING' | 'BLOCKED' | 'DONE' | 'FAILED';
export type ExportTrigger = 'SCHEDULE' | 'MANUAL';

export interface ExportRun {
  /** YYYY-MM */
  month: string;
  status: ExportStatus;
  trigger: ExportTrigger;
  attempts: number;
  lastError: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ExportResult {
  status: 'DONE' | 'FAILED' | 'BLOCKED';
  attempts: number;
  lastError: string | null;
  at: Date;
}

/**
 * A RUNNING run older than this is treated as crashed (server stopped mid-run): the store lets it be taken
 * over and the scheduler alerts about it. Longer than one run with all retries (about 21 min plus the read).
 */
export const STALE_AFTER_MS = 2 * 3_600_000;

/**
 * Finished states a trigger may start again. The schedule only resumes a BLOCKED month (waiting for edges);
 * a DONE or FAILED month is re-run by HR only (FR-4.6), so a failure alerts once instead of every tick.
 */
export const RESTARTABLE: Record<ExportTrigger, readonly ExportStatus[]> = {
  SCHEDULE: ['BLOCKED'],
  MANUAL: ['BLOCKED', 'FAILED', 'DONE'],
};

/** Whether `trigger` may claim the month now. A RUNNING run older than staleBefore is taken over (a crashed server). */
export const canClaim = (
  run: ExportRun | null,
  trigger: ExportTrigger,
  staleBefore: Date,
): boolean => {
  if (run === null) return true;
  if (run.status === 'RUNNING') return run.startedAt < staleBefore;
  return RESTARTABLE[trigger].includes(run.status);
};

export interface ExportRunStore {
  find(month: string): Promise<ExportRun | null>;
  /**
   * Atomically marks the month RUNNING (attempts 0, lastError null, startedAt = at, finishedAt null, this trigger)
   * when canClaim allows it. Two racing claims: one wins. Null when not allowed.
   */
  claim(
    month: string,
    trigger: ExportTrigger,
    at: Date,
    staleBefore: Date,
  ): Promise<ExportRun | null>;
  /** Stores the outcome of the run (finishedAt = result.at). Returns the updated run. */
  finish(month: string, result: ExportResult): Promise<ExportRun>;
}
