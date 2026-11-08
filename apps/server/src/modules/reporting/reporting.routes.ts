import { Router } from 'express';
import type { Request, Response } from 'express';
import { notImplemented } from '../../shared/errors.js';
import { requirePermission } from '../iam/index.js';
import type { UserRef } from '../iam/index.js';
import { REPORT_BY } from './reporting.aggregate.js';
import type { DepartmentRow, EmployeeRow, FactoryRow, ReportBy } from './reporting.aggregate.js';
import { toCsv } from './reporting.csv.js';
import type { CsvColumn } from './reporting.csv.js';
import { parseMonth } from './reporting.month.js';
import {
  EdgesNotSyncedError,
  ExportBusyError,
  InvalidExportMonthError,
} from './reporting.service.js';
import type { ExportRerun } from './reporting.service.js';
import { AccessLogGateNotFoundError } from './reporting.access.js';
import type { AccessLogReader, AccessLogRequest, AccessOutcome } from './reporting.access.js';
import { ReportForbiddenError, UnknownScopeError } from './reporting.reports.js';
import type { MonthlyReport, MonthlyReports, ReportQuery } from './reporting.reports.js';

export interface ReportingRouteDeps {
  reports: MonthlyReports;
  exports: ExportRerun;
  /** Left out until Attendance can list scans; the route then answers 501. */
  accessLog?: AccessLogReader;
  /** Clock for the "not in the future" month check. */
  now?: () => Date;
}

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_RANGE_MS = 31 * 24 * 3_600_000;
const OUTCOMES: readonly string[] = ['GRANTED', 'DENIED', 'PENDING'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** An ISO 8601 date-time with an offset, e.g. 2026-11-01T00:00:00+07:00; null if it is not one. */
const parseIsoDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_TIME.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return null;
  const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  return new Date(value);
};

/** Columns are the JSON field names, in order, so CSV and JSON match (FR-4.2). */
const columnsOf = <T>(keys: readonly (keyof T & string)[]): CsvColumn<T>[] =>
  keys.map((key) => ({ header: key, value: (row: T) => row[key] as string | number | null }));

const EMPLOYEE_COLUMNS = columnsOf<EmployeeRow>([
  'employeeId',
  'code',
  'firstName',
  'lastName',
  'factoryId',
  'departmentId',
  'teamId',
  'daysPresent',
  'hours',
  'missingPunchDays',
]);
const DEPARTMENT_COLUMNS = columnsOf<DepartmentRow>([
  'factoryId',
  'departmentId',
  'departmentName',
  'employees',
  'daysPresent',
  'hours',
  'missingPunchDays',
]);
const FACTORY_COLUMNS = columnsOf<FactoryRow>([
  'factoryId',
  'factoryName',
  'employees',
  'daysPresent',
  'hours',
  'missingPunchDays',
]);

const csvOf = (report: MonthlyReport): string => {
  switch (report.by) {
    case 'employee':
      return toCsv(EMPLOYEE_COLUMNS, report.rows);
    case 'department':
      return toCsv(DEPARTMENT_COLUMNS, report.rows);
    case 'factory':
      return toCsv(FACTORY_COLUMNS, report.rows);
  }
};

export const reportingRoutes = ({
  reports,
  exports,
  accessLog,
  now = () => new Date(),
}: ReportingRouteDeps) => {
  /** Parses the query and runs the report; answers the error itself and returns null. */
  const run = async (req: Request, res: Response): Promise<MonthlyReport | null> => {
    const month = parseMonth(req.query.month, now());
    if (typeof month === 'string') {
      res.status(400).json({ error: month });
      return null;
    }

    const rawBy = req.query.by ?? 'employee';
    if (typeof rawBy !== 'string' || !(REPORT_BY as readonly string[]).includes(rawBy)) {
      res.status(400).json({ error: 'by must be employee, department or factory' });
      return null;
    }
    const rawScope = req.query.scope;
    if (rawScope !== undefined && (typeof rawScope !== 'string' || rawScope === '')) {
      res.status(400).json({ error: 'scope must be a single org unit id' });
      return null;
    }
    const query: ReportQuery = { month, by: rawBy as ReportBy, scope: rawScope };

    try {
      return await reports.monthly(res.locals.user as UserRef, query);
    } catch (err) {
      if (err instanceof ReportForbiddenError) {
        res.status(403).json({ error: 'Forbidden' });
        return null;
      }
      if (err instanceof UnknownScopeError) {
        res.status(400).json({ error: 'Unknown scope' });
        return null;
      }
      throw err;
    }
  };

  /** Parses the access-log query; the message is the 400 answer. */
  const parseAccessLog = (req: Request): AccessLogRequest | string => {
    const from = parseIsoDate(req.query.from);
    const to = parseIsoDate(req.query.to);
    if (!from || !to) return 'from and to must be ISO date-times with an offset';
    if (to <= from) return 'to must be after from';
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      return 'from and to must be at most 31 days apart';
    }
    const { gateId, outcome, limit: rawLimit } = req.query;
    if (gateId !== undefined && (typeof gateId !== 'string' || gateId === '')) {
      return 'gateId must be a single gate id';
    }
    if (outcome !== undefined && (typeof outcome !== 'string' || !OUTCOMES.includes(outcome))) {
      return 'outcome must be GRANTED, DENIED or PENDING';
    }
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 0;
      if (limit < 1 || limit > MAX_LIMIT) return 'limit must be an integer from 1 to 500';
    }
    return {
      range: { from, to },
      ...(gateId !== undefined && { gateId }),
      ...(outcome !== undefined && { outcome: outcome as AccessOutcome }),
      limit,
    };
  };

  return Router()
    .get('/reports/monthly', requirePermission('report:read'), async (req, res) => {
      const report = await run(req, res);
      if (report) res.json(report);
    })
    .get('/reports/monthly.csv', requirePermission('report:read'), async (req, res) => {
      const report = await run(req, res);
      if (!report) return;
      res
        .set('Content-Type', 'text/csv; charset=utf-8')
        .set(
          'Content-Disposition',
          `attachment; filename="report-${report.by}-${report.month}.csv"`,
        )
        // The BOM makes Excel read Vietnamese names as UTF-8.
        .send(`\uFEFF${csvOf(report)}`);
    })
    .get(
      '/access-log',
      ...(accessLog
        ? [
            requirePermission('gate:monitor'),
            async (req: Request, res: Response) => {
              const query = parseAccessLog(req);
              if (typeof query === 'string') {
                res.status(400).json({ error: query });
                return;
              }
              try {
                res.json({ rows: await accessLog.list(res.locals.user as UserRef, query) });
              } catch (err) {
                if (!(err instanceof AccessLogGateNotFoundError)) throw err;
                res.status(404).json({ error: 'Gate not found' });
              }
            },
          ]
        : [notImplemented]),
    )
    .get('/exports/:month', requirePermission('export:hr'), async (req, res) => {
      const month = parseMonth(req.params.month, now());
      if (typeof month === 'string') {
        res.status(400).json({ error: month });
        return;
      }
      const run = await exports.status(month.month);
      if (!run) {
        res.status(404).json({ error: 'No export for this month' });
        return;
      }
      res.json(run);
    })
    .post('/exports/:month/rerun', requirePermission('export:hr'), async (req, res) => {
      const ignore = req.body?.ignoreUnsyncedEdges;
      if (ignore !== undefined && typeof ignore !== 'boolean') {
        res.status(400).json({ error: 'ignoreUnsyncedEdges must be a boolean' });
        return;
      }
      try {
        const { run } = await exports.rerun(
          (res.locals.user as UserRef).id,
          String(req.params.month),
          { ignoreUnsyncedEdges: ignore ?? false },
        );
        res.status(202).json(run);
      } catch (err) {
        if (err instanceof InvalidExportMonthError) {
          res.status(400).json({ error: err.message });
        } else if (err instanceof EdgesNotSyncedError) {
          res.status(409).json({
            error: err.message,
            edges: err.edges.map(({ edgeId, factoryId, lastSyncAt }) => ({
              edgeId,
              factoryId,
              lastSyncAt,
            })),
          });
        } else if (err instanceof ExportBusyError) {
          res.status(409).json({ error: err.message });
        } else {
          throw err;
        }
      }
    });
};
