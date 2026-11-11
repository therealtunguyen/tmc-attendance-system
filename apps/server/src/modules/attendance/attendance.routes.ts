import { Router, type Request } from 'express';
import {
  DENY_REASONS,
  MAX_EDGE_BATCH,
  type EdgeDenyReason,
  type EdgeEvent,
  type PushEventsRequest,
} from '../../shared/contracts/edge.js';
import { notImplemented } from '../../shared/errors.js';
import { requirePermission, type UserRef } from '../iam/index.js';
import type { AttendanceService } from './attendance.service.js';

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
  if (e.denyReason !== undefined && e.denyReason !== null) {
    if (!DENY_REASONS.includes(e.denyReason as EdgeDenyReason)) {
      return `.denyReason must be one of ${DENY_REASONS.join(', ')} or null`;
    }
    if (e.outcome !== 'DENIED') return '.denyReason is only allowed with outcome DENIED';
  }
  if (!isIsoDate(e.occurredAt)) return '.occurredAt must be an ISO date';
  if (e.jti !== null && !isText(e.jti)) return '.jti must be a non-empty string or null';
  if (typeof e.stale !== 'boolean') return '.stale must be a boolean';
  return null;
};

/** The whole batch is checked first, so a bad event stores nothing (the edge must fix it). */
const parseBatch = (req: Request, edgeId: string): PushEventsRequest | string => {
  const body: unknown = req.body ?? {};
  if (!isObject(body)) return 'body must be a JSON object';
  if (!Array.isArray(body.events)) return 'events must be an array';
  if (body.events.length > MAX_EDGE_BATCH) {
    return `events must hold at most ${MAX_EDGE_BATCH} events; split the outbox into batches`;
  }
  for (const [i, e] of body.events.entries()) {
    const error = invalidEvent(e);
    if (error) return `events[${i}]${error.startsWith('.') ? '' : ' '}${error}`;
  }
  // edgeId comes from the authenticated token (#69), never from body.edgeId.
  return { edgeId, events: body.events as EdgeEvent[] };
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
    .post('/attendance/:recordId/corrections', notImplemented)
    // Edge outbox (ADR-9). Authenticated by authenticateEdge (#69), mounted on /api/edge.
    .post('/edge/events', async (req, res) => {
      const edgeId = res.locals.edgeId as string | undefined;
      if (!edgeId) return void res.status(401).json({ error: 'Edge authentication required' });
      const batch = parseBatch(req, edgeId);
      if (typeof batch === 'string') return void res.status(400).json({ error: batch });
      res.json(await attendance.ingest(batch));
    });
