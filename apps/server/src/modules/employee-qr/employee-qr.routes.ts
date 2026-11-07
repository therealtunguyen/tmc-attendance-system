import { Router, type Request, type Response } from 'express';
import { QR_TOKEN_TTL_S } from '../../shared/contracts/qr-token.js';
import { notImplemented } from '../../shared/errors.js';
import {
  canSeeEmployee,
  inScope,
  isRestricted,
  requirePermission,
  type UserRef,
} from '../iam/index.js';
import {
  DuplicateEmployeeCodeError,
  QrNotConfiguredError,
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

/** Route param; typed here because Express loses the path inference once a guard is added. */
const idOf = (req: Request) => req.params.id as string;

/** The signed-in user; requirePermission has already rejected requests without one. */
const userOf = (res: Response) => res.locals.user as UserRef;

export const employeeQrRoutes = (eqr: EmployeeQrService) =>
  Router()
    // ?scope=<factoryId or teamId>. Unrestricted users may omit it; restricted ones are held to their own scopes (BR-15).
    .get('/employees', requirePermission('employee:read'), async (req, res) => {
      const user = userOf(res);
      let scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
      if (scope === '') return void res.status(400).json({ error: 'scope must not be empty' });
      if (isRestricted(user)) {
        if (scope === undefined && user.scopes?.length === 1) scope = user.scopes[0];
        if (scope === undefined) return void res.status(400).json({ error: 'scope is required' });
        if (!inScope(user, scope)) return void res.status(403).json({ error: 'Forbidden' });
      }
      res.json(await eqr.listProfiles(scope));
    })
    .get('/employees/:id', requirePermission('employee:read'), async (req, res) => {
      const employee = await eqr.getProfile(idOf(req));
      // Out of scope looks the same as missing, so existence does not leak.
      if (!employee || !canSeeEmployee(userOf(res), employee)) {
        return void res.status(404).json({ error: 'Employee not found' });
      }
      res.json(employee);
    })
    .post('/employees', requirePermission('employee:manage'), async (req, res) => {
      const body = bodyOf(req);
      if (!body) return void res.status(400).json({ error: 'body must be a JSON object' });
      const missing = required.find((key) => !isText(body[key]));
      const error = missing ? `${missing} is required` : invalid(body);
      if (error) return void res.status(400).json({ error });
      if (!inScope(userOf(res), trimmed(body.factoryId) as string)) {
        return void res.status(403).json({ error: 'Forbidden' });
      }
      if (body.teamId && !inScope(userOf(res), trimmed(body.teamId) as string)) {
        return void res.status(403).json({ error: 'Forbidden' });
      }
      const data = { teamId: null, ...pick(body), code: trimmed(body.code) } as NewEmployee;
      try {
        res.status(201).json(await eqr.createEmployee(userOf(res).id, data));
      } catch (e) {
        if (!(e instanceof DuplicateEmployeeCodeError)) throw e;
        res.status(409).json({ error: e.message });
      }
    })
    .patch('/employees/:id', requirePermission('employee:manage'), async (req, res) => {
      const body = bodyOf(req);
      if (!body) return void res.status(400).json({ error: 'body must be a JSON object' });
      if ('code' in body) return void res.status(400).json({ error: 'code cannot change' });
      const error = invalid(body);
      if (error) return void res.status(400).json({ error });
      const changes = pick(body);
      if (Object.keys(changes).length === 0) {
        return void res.status(400).json({ error: 'no editable fields given' });
      }
      const current = await eqr.getProfile(idOf(req));
      if (!current || !canSeeEmployee(userOf(res), current)) {
        return void res.status(404).json({ error: 'Employee not found' });
      }
      // Moving an employee out of the user's scope is as forbidden as creating one there.
      // Scopes are expanded down the org tree, so a factory scope covers its teams (BR-15).
      if (changes.factoryId !== undefined && !inScope(userOf(res), changes.factoryId)) {
        return void res.status(403).json({ error: 'Forbidden' });
      }
      if (changes.teamId && !inScope(userOf(res), changes.teamId)) {
        return void res.status(403).json({ error: 'Forbidden' });
      }
      const employee = await eqr.updateEmployee(userOf(res).id, idOf(req), changes);
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    // Soft delete: attendance history keeps pointing at the row (FR-1.5).
    .post('/employees/:id/deactivate', requirePermission('employee:manage'), async (req, res) => {
      const current = await eqr.getProfile(idOf(req));
      if (!current || !canSeeEmployee(userOf(res), current)) {
        return void res.status(404).json({ error: 'Employee not found' });
      }
      const employee = await eqr.deactivateEmployee(userOf(res).id, idOf(req));
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    // The signed-in employee's own token (FR-1.2, ADR-10). The portal asks again before it expires.
    // Every role views its own QR (self:read). Identity comes from the verified session (#43), never a request field.
    .post('/qr/token', requirePermission('self:read'), async (_req, res) => {
      const { employeeId } = userOf(res);
      if (!employeeId) {
        return void res.status(403).json({ error: 'No employee record linked to this account' });
      }
      try {
        const token = await eqr.issueToken(employeeId);
        res.set('Cache-Control', 'no-store').json({ token, ttlSeconds: QR_TOKEN_TTL_S });
      } catch (e) {
        if (e instanceof QrNotConfiguredError) {
          return void res.status(503).json({ error: 'QR signing not configured' });
        }
        if (!(e instanceof QrNotIssuableError)) throw e;
        res.status(403).json({ error: e.message, reason: e.reason });
      }
    })
    .get('/me/qr', notImplemented)
    .post('/employees/:id/qr/revoke', notImplemented)
    // Edge agent (ADR-9). Response: EdgeSnapshot.
    .get('/edge/snapshot', notImplemented);
