// Monthly HRS export: claim, edge-sync check, send with retry, audit, alert (FR-4.5, FR-4.6, ADR-9).
import type { HrsClient } from '../../adapters/hrs/hrs-client.js';
import type { DateRange } from '../../shared/types.js';
import type { AuditLog } from '../iam/index.js';
import { unsyncedEdges } from './reporting.edges.js';
import type { EdgeSync, EdgeSyncStatus } from './reporting.edges.js';
import { parseMonth } from './reporting.month.js';
import type { Notifier } from './reporting.notifier.js';
import { STALE_AFTER_MS } from './reporting.runs.js';
import type { ExportResult, ExportRun, ExportRunStore, ExportTrigger } from './reporting.runs.js';
import { previousMonth } from './reporting.schedule.js';
import { hrsRows } from './reporting.source.js';
import type { MonthSource } from './reporting.source.js';

const DAY_MS = 24 * 3_600_000;
const SYSTEM_ACTOR = 'system';
const MAX_ERROR_LENGTH = 500;

/** The month is malformed, in the future or still in progress. */
export class InvalidExportMonthError extends Error {}
/** An export of this month is already running (or the run cannot be restarted). */
export class ExportBusyError extends Error {}
/** An edge has not synced since the month ended, so its offline scans may be missing (ADR-9). */
export class EdgesNotSyncedError extends Error {
  constructor(readonly edges: EdgeSync[]) {
    super('Edges have not synced since the month ended');
  }
}

/** What the scheduler needs (FR-4.5). */
export interface ScheduledExport {
  /** Claims the month for the schedule and runs it; null when it could not be claimed. */
  runScheduled(month: string, lastChance: boolean): Promise<ExportRun | null>;
  /** The window passed with no export: records FAILED and alerts. Null when it could not be claimed. */
  recordMissed(month: string): Promise<ExportRun | null>;
}

/** What HR uses (FR-4.6). */
export interface ExportRerun {
  /**
   * Starts a re-run of a finished month and returns at once with the RUNNING run; `finished` settles when it is
   * done (it never rejects). Throws InvalidExportMonthError, EdgesNotSyncedError or ExportBusyError.
   */
  rerun(
    actorId: string,
    month: string,
    options: { ignoreUnsyncedEdges: boolean },
  ): Promise<{ run: ExportRun; finished: Promise<ExportRun> }>;
  status(month: string): Promise<ExportRun | null>;
}

/** What the server shutdown needs: abort the retry sleeps and wait for the runs in flight. */
export interface ExportLifecycle {
  stop(): Promise<void>;
}

export interface ExportOptions {
  /** Waits between attempts; 1 + length attempts in all. Default [60_000, 300_000, 900_000]. */
  retryDelaysMs?: readonly number[];
  /** A RUNNING run older than this is taken over (a crashed server). Default 2 h. */
  staleAfterMs?: number;
  /** Waits between attempts; must reject once the signal aborts (shutdown). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

const abortError = (): Error => new DOMException('The export was interrupted', 'AbortError');

/** setTimeout that rejects, and clears its timer, as soon as the signal aborts. */
const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);

const describeEdges = (edges: readonly EdgeSync[]): string =>
  edges
    .map(
      (e) =>
        `${e.edgeId} (${e.factoryId}, ${
          e.lastSyncAt ? `last sync ${e.lastSyncAt.toISOString()}` : 'never synced'
        })`,
    )
    .join(', ');

/** Monthly HRS export with retry, edge-sync check and alerts (FR-4.5, FR-4.6, ADR-9). */
export class HrExportService implements ScheduledExport, ExportRerun, ExportLifecycle {
  private retryDelaysMs: readonly number[];
  private staleAfterMs: number;
  private sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private abort = new AbortController();
  private inFlight = new Set<Promise<unknown>>();
  private stopped = false;
  private now: () => Date;
  private log: (message: string, error?: unknown) => void;

  constructor(
    private runs: ExportRunStore,
    private source: MonthSource,
    private hrs: HrsClient,
    private edges: EdgeSyncStatus,
    private notifier: Notifier,
    private audit: AuditLog,
    options: ExportOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? [60_000, 300_000, 900_000];
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((m, e) => console.error(m, e));
  }

  status(month: string): Promise<ExportRun | null> {
    return this.runs.find(month);
  }

  /** Shutdown: stops sending (retry sleeps end at once), then waits for every run in flight to store its outcome. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    const forget = () => void this.inFlight.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  async rerun(
    actorId: string,
    month: string,
    { ignoreUnsyncedEdges }: { ignoreUnsyncedEdges: boolean },
  ) {
    if (this.stopped) throw new ExportBusyError('The server is shutting down');
    const now = this.now();
    const parsed = parseMonth(month, now);
    if (typeof parsed === 'string') throw new InvalidExportMonthError(parsed);
    // A month in progress cannot be exported: only months up to the previous one.
    if (month > previousMonth(now)) {
      throw new InvalidExportMonthError('month must be before the current month');
    }
    if (!ignoreUnsyncedEdges) {
      const unsynced = unsyncedEdges(await this.edges.edgeSyncs(), this.monthEnd(parsed.range));
      if (unsynced.length > 0) throw new EdgesNotSyncedError(unsynced);
    }
    const previous = await this.runs.find(month);
    const run = await this.claim(month, 'MANUAL', now);
    if (!run) throw new ExportBusyError('An export of this month is already running');
    try {
      await this.audit.append({
        actorId,
        action: 'EXPORT_RERUN',
        target: `export:${month}`,
        at: now,
        after: { ignoreUnsyncedEdges },
      });
    } catch (error) {
      // Put back what the claim overwrote: HRS may already have this month (a DONE run must not turn FAILED).
      const outcome =
        previous && previous.status !== 'RUNNING'
          ? {
              status: previous.status,
              attempts: previous.attempts,
              lastError: previous.lastError,
              at: previous.finishedAt ?? this.now(),
            }
          : {
              status: 'FAILED' as const,
              attempts: 0,
              lastError: messageOf(error),
              at: this.now(),
            };
      await this.settle(run, outcome).catch((e) => this.log('Could not release the export run', e));
      throw error;
    }
    return { run, finished: this.track(this.send(month, parsed.range, actorId, run)) };
  }

  runScheduled(month: string, lastChance: boolean): Promise<ExportRun | null> {
    if (this.stopped) return Promise.resolve(null);
    return this.track(this.doRunScheduled(month, lastChance));
  }

  private async doRunScheduled(month: string, lastChance: boolean): Promise<ExportRun | null> {
    const run = await this.claim(month, 'SCHEDULE', this.now());
    if (!run) return null;
    const parsed = parseMonth(month, this.now());
    try {
      if (typeof parsed === 'string') throw new InvalidExportMonthError(parsed);
      const unsynced = unsyncedEdges(await this.edges.edgeSyncs(), this.monthEnd(parsed.range));
      if (unsynced.length > 0) {
        const list = describeEdges(unsynced);
        const error = `Waiting for edge sync: ${list}`;
        if (!lastChance) {
          return (
            await this.settle(run, {
              status: 'BLOCKED',
              attempts: 0,
              lastError: error.slice(0, MAX_ERROR_LENGTH),
              at: this.now(),
            })
          ).run;
        }
        return await this.fail(
          month,
          SYSTEM_ACTOR,
          0,
          error,
          `HRS export of ${month} failed: edges not synced since the month ended: ${list}. Re-run once they sync, or with ignoreUnsyncedEdges.`,
          run,
        );
      }
      await this.audit.append({
        actorId: SYSTEM_ACTOR,
        action: 'EXPORT_RUN',
        target: `export:${month}`,
        at: this.now(),
      });
    } catch (error) {
      return this.failUnexpected(month, SYSTEM_ACTOR, 0, error, run);
    }
    return this.send(month, parsed.range, SYSTEM_ACTOR, run);
  }

  recordMissed(month: string): Promise<ExportRun | null> {
    if (this.stopped) return Promise.resolve(null);
    return this.track(this.doRecordMissed(month));
  }

  private async doRecordMissed(month: string): Promise<ExportRun | null> {
    // The claim wipes lastError, so read what the previous run said first (it names the unsynced edges).
    const previous = await this.runs.find(month);
    const run = await this.claim(month, 'SCHEDULE', this.now());
    if (!run) return null;
    const rerunHint = `Re-run it with POST /api/exports/${month}/rerun.`;
    if (previous?.status === 'RUNNING') {
      const since = previous.startedAt.toISOString();
      return this.fail(
        month,
        SYSTEM_ACTOR,
        0,
        `Started at ${since} and never finished (the server stopped during the run)`,
        `HRS export of ${month} did not finish: it started at ${since} and the server stopped before it ended. ${rerunHint}`,
        run,
      );
    }
    if (previous?.status === 'BLOCKED' && previous.lastError) {
      return this.fail(
        month,
        SYSTEM_ACTOR,
        0,
        `Missed the export window (day 1 before 12:00). ${previous.lastError}`,
        `HRS export of ${month} did not run in its window (day 1 before 12:00): ${previous.lastError}. ${rerunHint}`,
        run,
      );
    }
    return this.fail(
      month,
      SYSTEM_ACTOR,
      0,
      'Missed the export window (day 1 before 12:00)',
      `HRS export of ${month} did not run in its window (day 1 before 12:00). ${rerunHint}`,
      run,
    );
  }

  private monthEnd(range: DateRange): Date {
    return new Date(range.to.getTime() + DAY_MS);
  }

  private claim(month: string, trigger: ExportTrigger, now: Date): Promise<ExportRun | null> {
    return this.runs.claim(month, trigger, now, new Date(now.getTime() - this.staleAfterMs));
  }

  /** Sends the batch with retries. Never rejects: every failure ends as a stored FAILED run. */
  private async send(
    month: string,
    range: DateRange,
    actorId: string,
    claimed: ExportRun,
  ): Promise<ExportRun> {
    let attempts = 0;
    try {
      const data = await this.source.company(range);
      const batch = { month, rows: hrsRows(data.employees, data.records) };
      if (batch.rows.length === 0) {
        const error = `No attendance records for ${month}; nothing was sent to HRS`;
        return await this.fail(month, actorId, 0, error, this.failedText(month, 0, error), claimed);
      }
      const maxAttempts = 1 + this.retryDelaysMs.length;
      let lastError: string | null = null;
      while (attempts < maxAttempts) {
        if (this.abort.signal.aborted)
          return await this.interrupted(month, actorId, attempts, claimed);
        attempts++;
        let answer: Awaited<ReturnType<HrsClient['send']>>;
        try {
          answer = await this.hrs.send(batch);
        } catch (error) {
          lastError = messageOf(error);
          if (attempts < maxAttempts) {
            try {
              await this.sleep(this.retryDelaysMs[attempts - 1]!, this.abort.signal);
            } catch (sleepError) {
              if (this.abort.signal.aborted) {
                return await this.interrupted(month, actorId, attempts, claimed);
              }
              throw sleepError;
            }
          }
          continue;
        }
        if (answer === 'ACCEPTED') {
          const { run: done, stored } = await this.settle(claimed, {
            status: 'DONE',
            attempts,
            lastError: null,
            at: this.now(),
          });
          // A newer run owns the record now; HRS accepts a repeated batch (ADR-5).
          if (!stored) return done;
          // HRS has the data, so the run stays DONE: a failed audit write is logged, not reported as a failed export.
          await this.audit
            .append({
              actorId,
              action: 'EXPORT_DONE',
              target: `export:${month}`,
              at: this.now(),
              after: { attempts, rows: batch.rows.length },
            })
            .catch((e) => this.log(`Could not audit the done ${month} export`, e));
          return done;
        }
        // Retrying would send the same data to the same answer.
        lastError = 'HRS rejected the batch';
        break;
      }
      return await this.fail(
        month,
        actorId,
        attempts,
        lastError ?? 'unknown error',
        this.failedText(month, attempts, lastError ?? 'unknown error'),
        claimed,
      );
    } catch (error) {
      return this.failUnexpected(month, actorId, attempts, error, claimed);
    }
  }

  /**
   * Shutdown reached the send loop. A scheduled run goes back to BLOCKED (the schedule resumes it in the window and
   * alerts it as missed afterwards); a manual run fails with one alert, since HR started it and must hear about it.
   */
  private async interrupted(
    month: string,
    actorId: string,
    attempts: number,
    claimed: ExportRun,
  ): Promise<ExportRun> {
    const error = `Interrupted by shutdown after ${attempts} attempt(s)`;
    if (claimed.trigger === 'SCHEDULE') {
      return (
        await this.settle(claimed, {
          status: 'BLOCKED',
          attempts,
          lastError: error,
          at: this.now(),
        })
      ).run;
    }
    return this.fail(
      month,
      actorId,
      attempts,
      error,
      `HRS export of ${month} did not finish: the server shut down after ${attempts} attempt(s). Re-run it with POST /api/exports/${month}/rerun.`,
      claimed,
    );
  }

  private failedText(month: string, attempts: number, error: string): string {
    return `HRS export of ${month} failed after ${attempts} attempt(s): ${error}. Re-run it with POST /api/exports/${month}/rerun.`;
  }

  /** An error outside the HRS call itself (source read, store, audit): store FAILED if possible and alert. */
  private async failUnexpected(
    month: string,
    actorId: string,
    attempts: number,
    error: unknown,
    lastKnown: ExportRun,
  ): Promise<ExportRun> {
    // If storing FAILED fails too, the run stays RUNNING; the scheduler treats a stale RUNNING run as missed and alerts.
    this.log(`Export of ${month} hit an unexpected error`, error);
    const text = messageOf(error);
    try {
      return await this.fail(
        month,
        actorId,
        attempts,
        text,
        this.failedText(month, attempts, text),
        lastKnown,
      );
    } catch (e) {
      this.log(`Could not store the failure of the ${month} export`, e);
      return lastKnown;
    }
  }

  /**
   * Stores the outcome only while the row is still the run `claimed`. When a newer run took it over, the outcome is
   * dropped (logged) and the current run is returned with stored false.
   */
  private async settle(
    claimed: ExportRun,
    result: ExportResult,
  ): Promise<{ run: ExportRun; stored: boolean }> {
    const run = await this.runs.finish(claimed.month, claimed.startedAt, result);
    if (run) return { run, stored: true };
    this.log(`Export of ${claimed.month} was taken over by a newer run; this outcome is dropped`);
    return { run: (await this.runs.find(claimed.month)) ?? claimed, stored: false };
  }

  /** Stores FAILED, then audits and alerts once. A failing audit or alert is logged: the run is already stored. */
  private async fail(
    month: string,
    actorId: string,
    attempts: number,
    error: string,
    alertText: string,
    claimed: ExportRun,
  ): Promise<ExportRun> {
    const lastError = error.slice(0, MAX_ERROR_LENGTH);
    const { run, stored } = await this.settle(claimed, {
      status: 'FAILED',
      attempts,
      lastError,
      at: this.now(),
    });
    // A newer run took the month over: its outcome is the one to audit and alert.
    if (!stored) return run;
    await this.audit
      .append({
        actorId,
        action: 'EXPORT_FAILED',
        target: `export:${month}`,
        at: this.now(),
        after: { attempts, error: lastError },
      })
      .catch((e) => this.log(`Could not audit the failed ${month} export`, e));
    await this.notifier
      .alert('EXPORT_FAILED', alertText)
      .catch((e) => this.log(`Could not send the failed ${month} export alert`, e));
    return run;
  }
}
