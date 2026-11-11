import { Router, type Request, type RequestHandler, type Response } from 'express';
import { notImplemented } from '../../shared/errors.js';
import { parseHeartbeat, UnknownEdgeError } from './gate.heartbeat.js';
import {
  hasPermission,
  inScope,
  isRestricted,
  requirePermission,
  type UserRef,
} from '../iam/index.js';
import {
  DuplicateTurnstileError,
  InactiveGateError,
  InvalidGateEdgeError,
  OverrideError,
  type GateChanges,
  type GateFilters,
  type GateService,
  type NewGate,
} from './gate.service.js';

const required = ['name', 'factoryId', 'edgeId', 'location', 'direction', 'turnstileId'] as const;
const editable = ['name', 'edgeId', 'location', 'direction', 'turnstileId', 'active'] as const;

/** Strict field selection prevents identity, scope and lifecycle fields being overwritten. */
function parseBody(body: unknown, create: true): NewGate | string;
function parseBody(body: unknown, create: false): GateChanges | string;
function parseBody(body: unknown, create: boolean): NewGate | GateChanges | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  const input = body as Record<string, unknown>;
  const allowed: readonly string[] = create ? required : editable;
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) return `${unknown} is not allowed`;
  if (!create && Object.keys(input).length === 0) return 'no editable fields given';
  const result: Record<string, string | true> = {};
  for (const key of allowed) {
    if (!create && !(key in input)) continue;
    const value = input[key];
    if (key === 'active') {
      if (value !== true) return 'active can only be true; use DELETE to deactivate';
      result.active = true;
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      return `${key} must be a non-empty string`;
    }
    const trimmed = value.trim();
    if (key === 'direction' && trimmed !== 'IN' && trimmed !== 'OUT') {
      return 'direction must be IN or OUT';
    }
    result[key] = trimmed;
  }
  return result as GateChanges;
}

const parseFilters = (req: Request): GateFilters | string => {
  const filters: GateFilters = {};
  for (const key of Object.keys(req.query)) {
    if (!['factoryId', 'edgeId', 'active'].includes(key)) return `unknown filter ${key}`;
  }
  for (const key of ['factoryId', 'edgeId'] as const) {
    const value = req.query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      return `${key} must be a non-empty string`;
    }
    filters[key] = value.trim();
  }
  const active = req.query.active;
  if (active !== undefined) {
    if (active !== 'true' && active !== 'false') return 'active must be true or false';
    filters.active = active === 'true';
  }
  return filters;
};

const userOf = (res: Response) => res.locals.user as UserRef;
const idOf = (req: Request) => req.params.gateId as string;

/** ADM manages the registry; GRD reads it for gate monitoring. */
const requireGateRead: RequestHandler = (_req, res, next) => {
  const user = res.locals.user as UserRef | undefined;
  if (!user) return void res.status(401).json({ error: 'Not signed in' });
  if (!hasPermission(user.role, 'gate:manage') && !hasPermission(user.role, 'gate:monitor')) {
    return void res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

/** Translate only known domain errors; storage/audit failures remain server errors. */
const domainError = (error: unknown, res: Response) => {
  if (error instanceof DuplicateTurnstileError || error instanceof InactiveGateError) {
    res.status(409).json({ error: error.message });
  } else if (error instanceof InvalidGateEdgeError) {
    res.status(400).json({ error: error.message });
  } else {
    throw error;
  }
};

export const gateRoutes = (gate: GateService) =>
  Router()
    // @deprecated (#29): POST /kiosk/scan has moved to the edge agent (apps/edge).
    // This stub remains for backward-compat while kiosks are migrated to call the edge directly.
    .post('/kiosk/scan', notImplemented)
    .post('/kiosk/heartbeat', notImplemented)
    .get('/gates', requireGateRead, async (req, res) => {
      const filters = parseFilters(req);
      if (typeof filters === 'string') return void res.status(400).json({ error: filters });
      const user = userOf(res);
      if (filters.factoryId !== undefined && !inScope(user, filters.factoryId)) {
        return void res.status(403).json({ error: 'Forbidden' });
      }
      res
        .set('Cache-Control', 'no-store')
        .json(await gate.listGates(filters, isRestricted(user) ? (user.scopes ?? []) : undefined));
    })
    .get('/gates/:gateId', requireGateRead, async (req, res) => {
      const current = await gate.getGate(idOf(req));
      if (!current || !inScope(userOf(res), current.factoryId)) {
        return void res.status(404).json({ error: 'Gate not found' });
      }
      res.set('Cache-Control', 'no-store').json(current);
    })
    .post('/gates', requirePermission('gate:manage'), async (req, res) => {
      const data = parseBody(req.body, true);
      if (typeof data === 'string') return void res.status(400).json({ error: data });
      const user = userOf(res);
      if (!inScope(user, data.factoryId)) {
        return void res.status(403).json({ error: 'Forbidden' });
      }
      try {
        const created = await gate.createGate(user.id, data);
        res
          .location(`/api/gates/${encodeURIComponent(created.id)}`)
          .status(201)
          .json(created);
      } catch (error) {
        domainError(error, res);
      }
    })
    .patch('/gates/:gateId', requirePermission('gate:manage'), async (req, res) => {
      const changes = parseBody(req.body, false);
      if (typeof changes === 'string') return void res.status(400).json({ error: changes });
      const user = userOf(res);
      const current = await gate.getGate(idOf(req));
      if (!current || !inScope(user, current.factoryId)) {
        return void res.status(404).json({ error: 'Gate not found' });
      }
      try {
        const updated = await gate.updateGate(user.id, current.id, changes);
        if (!updated) return void res.status(404).json({ error: 'Gate not found' });
        res.json(updated);
      } catch (error) {
        domainError(error, res);
      }
    })
    .delete('/gates/:gateId', requirePermission('gate:manage'), async (req, res) => {
      const user = userOf(res);
      const current = await gate.getGate(idOf(req));
      if (!current || !inScope(user, current.factoryId)) {
        return void res.status(404).json({ error: 'Gate not found' });
      }
      const deactivated = await gate.deactivateGate(user.id, current.id);
      if (!deactivated) return void res.status(404).json({ error: 'Gate not found' });
      res.sendStatus(204);
    })
    .post('/gates/:gateId/override', requirePermission('gate:override'), async (req, res) => {
      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return void res.status(400).json({ error: 'body must be a JSON object' });
      }
      const input = body as Record<string, unknown>;
      if (
        Object.keys(input).some(
          (key) => !['eventId', 'employeeId', 'reason', 'mode', 'occurredAt'].includes(key),
        ) ||
        ['eventId', 'employeeId', 'reason'].some(
          (key) => typeof input[key] !== 'string' || !input[key].trim(),
        ) ||
        !['OPEN', 'BACKFILL'].includes(input.mode as string)
      ) {
        return void res
          .status(400)
          .json({ error: 'Expected eventId, employeeId, reason and mode OPEN/BACKFILL' });
      }
      let occurredAt: Date | undefined;
      if (input.mode === 'BACKFILL') {
        if (
          typeof input.occurredAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt)
        ) {
          return void res
            .status(400)
            .json({ error: 'occurredAt must be an ISO timestamp with timezone' });
        }
        occurredAt = new Date(input.occurredAt);
        const [year, month, day] = input.occurredAt.slice(0, 10).split('-').map(Number) as [
          number,
          number,
          number,
        ];
        if (
          !Number.isFinite(occurredAt.getTime()) ||
          new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day
        ) {
          return void res.status(400).json({ error: 'Invalid occurredAt' });
        }
      } else if (input.occurredAt !== undefined) {
        return void res.status(400).json({ error: 'OPEN uses the server time' });
      }
      const current = await gate.getGate(idOf(req));
      const user = userOf(res);
      if (!current || !inScope(user, current.factoryId)) {
        return void res.status(404).json({ error: 'Gate not found' });
      }
      try {
        res.status(201).json(
          await gate.override(user.id, current.id, {
            eventId: (input.eventId as string).trim(),
            employeeId: (input.employeeId as string).trim(),
            reason: (input.reason as string).trim(),
            mode: input.mode as 'OPEN' | 'BACKFILL',
            occurredAt,
          }),
        );
      } catch (error) {
        if (!(error instanceof OverrideError)) throw error;
        res.status(error.status).json({ error: error.message });
      }
    })
    // Edge agent (ADR-9). Body: EdgeHeartbeat. Response: 204.
    // Authenticated by authenticateEdge (#69), mounted on /api/edge; edgeId comes from the token, never the body.
    .post('/edge/heartbeat', async (req, res) => {
      const edgeId = res.locals.edgeId as string | undefined;
      if (!edgeId) return void res.status(401).json({ error: 'Edge authentication required' });
      const hb = parseHeartbeat(req.body, edgeId);
      if (!hb) return void res.status(400).json({ error: 'Invalid edge heartbeat' });
      try {
        await gate.edgeHeartbeat(hb);
        res.sendStatus(204);
      } catch (error) {
        if (!(error instanceof UnknownEdgeError)) throw error;
        res.status(404).json({ error: error.message });
      }
    });
