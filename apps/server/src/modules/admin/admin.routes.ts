import { Router, type Request, type Response } from 'express';
import { inScope, isRestricted, requirePermission, type UserRef } from '../iam/index.js';
import {
  ConfigNotWiredError,
  DuplicateOrgUnitError,
  InvalidConfigError,
  InvalidOrgUnitError,
  OrgUnitNotFoundError,
  UnknownConfigKeyError,
  type AdminService,
} from './admin.service.js';

const bodyOf = (req: Request): Record<string, unknown> | null => {
  const body: unknown = req.body ?? {};
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
};

const userOf = (res: Response) => res.locals.user as UserRef;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Maps the service's typed errors to 400, 404 and 409; anything else is a 500. */
const fail = (res: Response, e: unknown) => {
  if (e instanceof InvalidOrgUnitError || e instanceof InvalidConfigError) {
    return void res.status(400).json({ error: e.message });
  }
  if (e instanceof OrgUnitNotFoundError || e instanceof UnknownConfigKeyError) {
    return void res.status(404).json({ error: e.message });
  }
  if (e instanceof DuplicateOrgUnitError) return void res.status(409).json({ error: e.message });
  if (e instanceof ConfigNotWiredError) {
    return void res.status(409).json({ error: e.message, code: 'CONFIG_NOT_WIRED' });
  }
  throw e;
};

const forbidden = (res: Response) => void res.status(403).json({ error: 'Forbidden' });

export const adminRoutes = (admin: AdminService) =>
  Router()
    // A restricted user sees only the units within their (expanded) scopes (BR-15).
    .get('/org-units', requirePermission('org:read'), async (_req, res) => {
      const user = userOf(res);
      const units = await admin.orgUnits();
      res.json(isRestricted(user) ? units.filter((u) => inScope(user, u.id)) : units);
    })
    .post('/org-units', requirePermission('org:manage'), async (req, res) => {
      const body = bodyOf(req);
      if (!body) return void res.status(400).json({ error: 'body must be a JSON object' });
      const { id, kind, name, parentId = null } = body;
      if (!isText(id) || !isText(kind) || !isText(name)) {
        return void res.status(400).json({ error: 'id, kind and name are required' });
      }
      if (parentId !== null && !isText(parentId)) {
        return void res.status(400).json({ error: 'parentId must be a string or null' });
      }
      // A restricted user may only add below a unit they cover; a new factory has no parent to cover.
      if (!inScope(userOf(res), parentId ?? id)) return forbidden(res);
      try {
        res
          .status(201)
          .json(await admin.createOrgUnit(userOf(res).id, { id, kind, name, parentId }));
      } catch (e) {
        fail(res, e);
      }
    })
    .patch('/org-units/:id', requirePermission('org:manage'), async (req, res) => {
      const body = bodyOf(req);
      if (!body) return void res.status(400).json({ error: 'body must be a JSON object' });
      if (!isText(body.name)) return void res.status(400).json({ error: 'name is required' });
      const id = req.params.id as string;
      if (!inScope(userOf(res), id)) return forbidden(res);
      try {
        res.json(await admin.renameOrgUnit(userOf(res).id, id, body.name));
      } catch (e) {
        fail(res, e);
      }
    })
    .put('/org-units/:id/supervisors', requirePermission('org:manage'), async (req, res) => {
      const body = bodyOf(req);
      const userIds = body?.userIds;
      if (!Array.isArray(userIds) || !userIds.every(isText)) {
        return void res.status(400).json({ error: 'userIds must be an array of strings' });
      }
      const id = req.params.id as string;
      if (!inScope(userOf(res), id)) return forbidden(res);
      try {
        res.json(await admin.setSupervisors(userOf(res).id, id, userIds as string[]));
      } catch (e) {
        fail(res, e);
      }
    })
    .get('/config', requirePermission('config:read'), async (_req, res) => {
      res.json(await admin.allConfig());
    })
    .put('/config/:key', requirePermission('config:manage'), async (req, res) => {
      const body = bodyOf(req);
      if (typeof body?.value !== 'string') {
        return void res.status(400).json({ error: 'value must be a string' });
      }
      try {
        res.json(await admin.setConfig(userOf(res).id, req.params.key as string, body.value));
      } catch (e) {
        fail(res, e);
      }
    });
