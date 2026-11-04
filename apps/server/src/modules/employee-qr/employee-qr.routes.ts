import { Router, type Response } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { UserRef } from '../iam/index.js';
import {
  DuplicateEmployeeCodeError,
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
  if ('email' in body && !String(body.email).includes('@')) return 'email is not valid';
  return null;
};

const pick = (body: Record<string, unknown>): EmployeeChanges =>
  Object.fromEntries(editable.filter((key) => key in body).map((key) => [key, body[key]]));

/** Set by the IAM auth middleware (FR-5.1). Until that lands, writes are audited as 'anonymous'. */
const actorOf = (res: Response) => (res.locals.user as UserRef | undefined)?.id ?? 'anonymous';

export const employeeQrRoutes = (eqr: EmployeeQrService) =>
  Router()
    // ?scope=<factoryId or teamId>
    .get('/employees', async (req, res) => {
      const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
      res.json(await eqr.listProfiles(scope));
    })
    .get('/employees/:id', async (req, res) => {
      const employee = await eqr.getProfile(req.params.id);
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    .post('/employees', async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const missing = required.find((key) => !isText(body[key]));
      const error = missing ? `${missing} is required` : invalid(body);
      if (error) return void res.status(400).json({ error });
      const data = { teamId: null, ...pick(body), code: body.code } as NewEmployee;
      try {
        res.status(201).json(await eqr.createEmployee(actorOf(res), data));
      } catch (e) {
        if (!(e instanceof DuplicateEmployeeCodeError)) throw e;
        res.status(409).json({ error: e.message });
      }
    })
    .patch('/employees/:id', async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if ('code' in body) return void res.status(400).json({ error: 'code cannot change' });
      const error = invalid(body);
      if (error) return void res.status(400).json({ error });
      const employee = await eqr.updateEmployee(actorOf(res), req.params.id, pick(body));
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    // Soft delete: attendance history keeps pointing at the row (FR-1.5).
    .post('/employees/:id/deactivate', async (req, res) => {
      const employee = await eqr.deactivateEmployee(actorOf(res), req.params.id);
      if (!employee) return void res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    })
    .get('/me/qr', notImplemented)
    .post('/employees/:id/qr/revoke', notImplemented)
    // Edge agent (ADR-9). Response: EdgeSnapshot.
    .get('/edge/snapshot', notImplemented);
