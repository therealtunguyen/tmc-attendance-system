import { Router, type Request, type Response } from 'express';
import { QR_TOKEN_TTL_S } from '../../shared/contracts/qr-token.js';
import { notImplemented } from '../../shared/errors.js';
import type { UserRef } from '../iam/index.js';
import {
  DuplicateEmployeeCodeError,
  QrNotIssuableError,
  type EmployeeChanges,
  type EmployeeQrService,
  type NewEmployee,
} from './employee-qr.service.js';

const required = ['code', 'firstName', 'lastName', 'email', 'factoryId'] as const;
const editable = ['firstName', 'lastName', 'email', 'factoryId', 'teamId'] as const;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Returns an error message, or null when the fields that are present are valid. */
const invalid = (body: Record<string, unknown>): string | null => {
  for (const key of editable) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === 'teamId' && value === null) continue;
    if (!isText(value)) return `${key} must be a non-empty string`;
  }
  if ('email' in body && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((body.email as string).trim())) {
    return 'email is not valid';
  }
  return null;
};

const trimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

const pick = (body: Record<string, unknown>): EmployeeChanges =>
  Object.fromEntries(editable.filter((key) => key in body).map((key) => [key, trimmed(body[key])]));

/** The JSON body as a plain object, or null for an array or other non-object. */
const bodyOf = (req: Request): Record<string, unknown> | null => {
  const body: unknown = req.body ?? {};
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
};

/** Set by the IAM auth middleware (FR-5.1). Until that lands, writes are audited as 'anonymous'. */
const actorOf = (res: Response) => (res.locals.user as UserRef | undefined)?.id ?? 'anonymous';

export const employeeQrRoutes = (eqr: EmployeeQrService) =>
  Router()
    // TODO(#44): RBAC guard
    // ?scope=<factoryId or teamId>. TODO(#44): once RBAC lands, scope comes from the signed-in user, not the query.
    .get('/employees', async (req, res) => {
      const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
      if (scope === '') return void res.status(400).json({ error: 'scope must not be empty' });
      res.json(await eqr.listProfiles(scope));
    })
    .get('/employees/:id', async (req, res) => {
      const employee = await eqr.getProfile(req.params.id);
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    .post('/employees', async (req, res) => {
      const body = bodyOf(req);
      if (!body) return void res.status(400).json({ error: 'body must be a JSON object' });
      const missing = required.find((key) => !isText(body[key]));
      const error = missing ? `${missing} is required` : invalid(body);
      if (error) return void res.status(400).json({ error });
      const data = { teamId: null, ...pick(body), code: trimmed(body.code) } as NewEmployee;
      try {
        res.status(201).json(await eqr.createEmployee(actorOf(res), data));
      } catch (e) {
        if (!(e instanceof DuplicateEmployeeCodeError)) throw e;
        res.status(409).json({ error: e.message });
      }
    })
    .patch('/employees/:id', async (req, res) => {
      const body = bodyOf(req);
      if (!body) return void res.status(400).json({ error: 'body must be a JSON object' });
      if ('code' in body) return void res.status(400).json({ error: 'code cannot change' });
      const error = invalid(body);
      if (error) return void res.status(400).json({ error });
      const changes = pick(body);
      if (Object.keys(changes).length === 0) {
        return void res.status(400).json({ error: 'no editable fields given' });
      }
      const employee = await eqr.updateEmployee(actorOf(res), req.params.id, changes);
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    // Soft delete: attendance history keeps pointing at the row (FR-1.5).
    .post('/employees/:id/deactivate', async (req, res) => {
      const employee = await eqr.deactivateEmployee(actorOf(res), req.params.id);
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    // The signed-in employee's own token (FR-1.2, ADR-10). The portal asks again before it expires.
    .post('/qr/token', async (_req, res) => {
      const user = res.locals.user as UserRef | undefined;
      if (!user) return void res.status(401).json({ error: 'Sign in first' });
      try {
        const token = await eqr.issueToken(user.id);
        res.set('Cache-Control', 'no-store').json({ token, ttlSeconds: QR_TOKEN_TTL_S });
      } catch (e) {
        if (!(e instanceof QrNotIssuableError)) throw e;
        res.status(403).json({ error: e.message, reason: e.reason });
      }
    })
    .get('/me/qr', notImplemented)
    .post('/employees/:id/qr/revoke', notImplemented)
    // Edge agent (ADR-9). Response: EdgeSnapshot.
    .get('/edge/snapshot', notImplemented);
