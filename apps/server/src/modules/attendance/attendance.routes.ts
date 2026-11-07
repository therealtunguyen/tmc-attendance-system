import { Router, type Request } from 'express';
import {
  MAX_EDGE_BATCH,
  type EdgeEvent,
  type PushEventsRequest,
} from '../../shared/contracts/edge.js';
import { notImplemented } from '../../shared/errors.js';
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

export const attendanceRoutes = (attendance: AttendanceService) =>
  Router()
    .get('/me/attendance', notImplemented)
    .post('/attendance/:recordId/corrections', notImplemented)
    // Edge outbox (ADR-9). Body: PushEventsRequest. Response: PushEventsResponse.
    // TODO(#44): authenticate the edge agent.
    .post('/edge/events', async (req, res) => {
      const batch = parseBatch(req);
      if (typeof batch === 'string') return void res.status(400).json({ error: batch });
      res.json(await attendance.ingest(batch));
    });
