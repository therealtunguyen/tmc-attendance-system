import { Router, type Request, type Response } from 'express';
import { notImplemented } from '../../shared/errors.js';
import type { AuditFilter, AuditReader, UserRef } from './iam.service.js';

const text = ['actorId', 'action', 'target'] as const;

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/** Returns a filter, or an error message when a query parameter is malformed. */
const parseFilter = (req: Request): AuditFilter | string => {
  const filter: AuditFilter = {};
  for (const key of text) {
    const value = first(req.query[key]);
    if (value === undefined) continue;
    if (typeof value !== 'string' || value === '') return `${key} must not be empty`;
    filter[key] = value;
  }
  for (const key of ['from', 'to'] as const) {
    const value = first(req.query[key]);
    if (value === undefined) continue;
    const date = typeof value === 'string' && value !== '' ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return `${key} must be an ISO date`;
    filter[key] = date;
  }
  const limit = first(req.query.limit);
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^[1-9]\d*$/.test(limit)) {
      return 'limit must be a positive integer';
    }
    filter.limit = Number(limit);
  }
  return filter;
};

/** Only ADM may read the log (FR-4.10). Returns false after sending the error. */
const allowed = (res: Response): boolean => {
  const user = res.locals.user as UserRef | undefined;
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return false;
  }
  if (user.role !== 'ADM') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
};

// Read-only on purpose: no route can change or delete an entry (FR-4.10).
export const iamRoutes = (iam: AuditReader) =>
  Router()
    .post('/auth/login', notImplemented)
    // TODO(#44): replace with requirePermission('audit:read')
    .get('/audit', async (req, res) => {
      if (!allowed(res)) return;
      const filter = parseFilter(req);
      if (typeof filter === 'string') return void res.status(400).json({ error: filter });
      res.json(await iam.search(filter));
    })
    // TODO(#44): replace with requirePermission('audit:read')
    .get('/audit/verify', async (_req, res) => {
      if (!allowed(res)) return;
      res.json(await iam.verify());
    });
