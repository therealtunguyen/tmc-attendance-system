import { Router, type Request } from 'express';
import type { EdgeEvent, PushEventsRequest } from '../../shared/contracts/edge.js';
import { notImplemented } from '../../shared/errors.js';
import type { AttendanceService } from './attendance.service.js';

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** ISO 8601 with a date and time, e.g. 2026-11-07T07:58:00.000Z (contract: dates are ISO strings). */
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
  !Number.isNaN(Date.parse(value));

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
