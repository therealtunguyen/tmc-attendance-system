import { Router, type Request, type Response } from 'express';
import {
  MAX_EDGE_BATCH,
  type EdgeEvent,
  type PushEventsRequest,
} from '../../shared/contracts/edge.js';
import { isRestricted, requirePermission, type UserRef } from '../iam/index.js';
import { parseRecordId } from './attendance.daily.js';
import {
  InvalidCorrectionError,
  RecordNotFoundError,
  type AttendanceService,
} from './attendance.service.js';

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * ISO 8601 date and time with an explicit offset, e.g. 2026-11-07T00:58:00.000Z or
 * 2026-11-07T07:58:00+07:00. Without the offset the server would read it in its own time zone,
 * a silent shift of hours, so it is refused. A date that does not exist (02-31) is refused too,
 * where Date.parse would roll it over into the next month.
 */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_TIME.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
};

const METHODS = ['QR', 'MANUAL'];
const OUTCOMES = ['PENDING', 'GRANTED', 'DENIED'];

/** Returns why one EdgeEvent breaks the contract, or null when it is valid. */
const invalidEvent = (e: unknown): string | null => {
  if (!isObject(e)) return 'must be an object';
  if (!isText(e.eventId)) return '.eventId must be a non-empty string';
  if (!isText(e.gateId)) return '.gateId must be a non-empty string';
  if (e.employeeId !== null && !isText(e.employeeId)) {
    return '.employeeId must be a non-empty string or null';
  }
  if (!METHODS.includes(e.method as string)) return '.method must be QR or MANUAL';
  if (!OUTCOMES.includes(e.outcome as string)) {
    return '.outcome must be PENDING, GRANTED or DENIED';
  }
  if (!isIsoDate(e.occurredAt)) return '.occurredAt must be an ISO date';
  if (e.jti !== null && !isText(e.jti)) return '.jti must be a non-empty string or null';
  if (typeof e.stale !== 'boolean') return '.stale must be a boolean';
  return null;
};

/** The whole batch is checked first, so a bad event stores nothing (the edge must fix it). */
const parseBatch = (req: Request): PushEventsRequest | string => {
  const body: unknown = req.body ?? {};
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isText(body.edgeId)) return 'edgeId must be a non-empty string';
  if (!Array.isArray(body.events)) return 'events must be an array';
  if (body.events.length > MAX_EDGE_BATCH) {
    return `events must hold at most ${MAX_EDGE_BATCH} events; split the outbox into batches`;
  }
  for (const [i, e] of body.events.entries()) {
    const error = invalidEvent(e);
    if (error) return `events[${i}]${error.startsWith('.') ? '' : ' '}${error}`;
  }
  return { edgeId: body.edgeId, events: body.events as EdgeEvent[] };
};

/** A user limited to some factories or teams only reaches employees in them (BR-15). */
const reachable = async (attendance: AttendanceService, res: Response, employeeId: string) => {
  const user = res.locals.user as UserRef;
  return !isRestricted(user) || attendance.inScopes(employeeId, user.scopes ?? []);
};

export const attendanceRoutes = (attendance: AttendanceService) =>
  Router()
    // Own history only (FR-1.6): the employee comes from the verified session, never a request field.
    .get('/me/attendance', requirePermission('self:read'), async (_req, res) => {
      const { employeeId } = res.locals.user as UserRef;
      if (!employeeId) {
        return void res
          .status(403)
          .json({ error: 'No employee record linked to this account', reason: 'NO_EMPLOYEE' });
      }
      res.set('Cache-Control', 'no-store').json({ records: await attendance.history(employeeId) });
    })
    // HR opens an employee's daily records to correct them (UC-8 step 1).
    .get('/attendance/records', requirePermission('attendance:correct'), async (req, res) => {
      const { employeeId, from, to } = req.query;
      if (!isText(employeeId)) {
        return void res.status(400).json({ error: 'employeeId is required' });
      }
      if (!isIsoDate(from) || !isIsoDate(to)) {
        return void res.status(400).json({ error: 'from and to must be ISO dates with an offset' });
      }
      if (Date.parse(from) > Date.parse(to)) {
        return void res.status(400).json({ error: 'from must not be after to' });
      }
      // Out of scope looks the same as no records, so existence does not leak.
      const records = (await reachable(attendance, res, employeeId))
        ? await attendance.employeeRecords(employeeId, {
            from: new Date(from),
            to: new Date(to),
          })
        : [];
      res.set('Cache-Control', 'no-store').json({ records });
    })
    // The original value of every change stays readable (FR-3.6).
    .get(
      '/attendance/:recordId/corrections',
      requirePermission('attendance:correct'),
      async (req, res) => {
        const recordId = req.params.recordId as string;
        const key = parseRecordId(recordId);
        if (!key || !(await reachable(attendance, res, key.employeeId))) {
          return void res.status(404).json({ error: 'Daily record not found' });
        }
        res
          .set('Cache-Control', 'no-store')
          .json({ corrections: await attendance.recordCorrections(recordId) });
      },
    )
    // Only HR, with a reason; the original is kept and the change is audited (FR-3.6, UC-8).
    .post(
      '/attendance/:recordId/corrections',
      requirePermission('attendance:correct'),
      async (req, res) => {
        const recordId = req.params.recordId as string;
        const key = parseRecordId(recordId);
        if (!key || !(await reachable(attendance, res, key.employeeId))) {
          return void res.status(404).json({ error: 'Daily record not found' });
        }
        const { field, value, reason } = (req.body ?? {}) as Record<string, unknown>;
        if (field !== 'FIRST_IN' && field !== 'LAST_OUT') {
          return void res.status(400).json({ error: 'field must be FIRST_IN or LAST_OUT' });
        }
        if (!isIsoDate(value)) {
          return void res.status(400).json({ error: 'value must be an ISO date with an offset' });
        }
        if (typeof reason !== 'string') {
          return void res.status(400).json({ error: 'reason is required' });
        }
        try {
          const record = await attendance.correct((res.locals.user as UserRef).id, recordId, {
            field,
            value: new Date(value),
            reason,
          });
          res.status(201).set('Cache-Control', 'no-store').json(record);
        } catch (e) {
          if (e instanceof RecordNotFoundError) {
            return void res.status(404).json({ error: 'Daily record not found' });
          }
          if (!(e instanceof InvalidCorrectionError)) throw e;
          res.status(400).json({ error: e.message });
        }
      },
    )
    // Edge outbox (ADR-9). Body: PushEventsRequest. Response: PushEventsResponse.
    // TODO(#44): authenticate the edge agent.
    .post('/edge/events', async (req, res) => {
      const batch = parseBatch(req);
      if (typeof batch === 'string') return void res.status(400).json({ error: batch });
      res.json(await attendance.ingest(batch));
    });
