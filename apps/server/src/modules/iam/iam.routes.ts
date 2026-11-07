import { Router, type Request } from 'express';
import { notImplemented } from '../../shared/errors.js';
import { requirePermission } from './iam.rbac.js';
import type { AuditFilter, AuditReader } from './iam.service.js';

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

// Read-only on purpose: no route can change or delete an entry (FR-4.10).
export const iamRoutes = (iam: AuditReader) =>
  Router()
    .post('/auth/login', notImplemented)
    .get('/audit', requirePermission('audit:read'), async (req, res) => {
      const filter = parseFilter(req);
      if (typeof filter === 'string') return void res.status(400).json({ error: filter });
      res.json(await iam.search(filter));
    })
    .get('/audit/verify', requirePermission('audit:read'), async (_req, res) => {
      res.json(await iam.verify());
    });
