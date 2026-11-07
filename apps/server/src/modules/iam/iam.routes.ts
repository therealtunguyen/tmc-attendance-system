import { Router, type Request, type RequestHandler } from 'express';
import { createRateLimiter, type RateLimitOptions } from './iam.ratelimit.js';
import { requirePermission } from './iam.rbac.js';
import type {
  AuditFilter,
  AuditReader,
  Authenticator,
  ScopeResolver,
  UserRef,
} from './iam.service.js';

/** The bearer token of the request, or undefined when the header is missing or malformed. */
const bearer = (req: Request): string | undefined => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
  return match?.[1];
};

/**
 * Sets res.locals.user from a valid, fully authenticated session (FR-5.2). Never rejects:
 * routes decide through requirePermission, which answers 401 without a user.
 * A resolver, when given, expands the user's scopes down the org tree first (BR-15).
 */
export const authenticate =
  (auth: Authenticator, resolver?: ScopeResolver): RequestHandler =>
  async (req, res, next) => {
    const token = bearer(req);
    if (token) {
      const user = await auth.authenticate(token);
      if (user) res.locals.user = resolver ? await resolver.expandScopes(user) : user;
    }
    next();
  };

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

const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 256;

const passThrough: RequestHandler = (_req, _res, next) => next();

// Read-only on purpose: no route can change or delete an entry (FR-4.10).
/** `limits.login` / `limits.mfa` override the default 10 requests per minute per IP; false disables. */
export const iamRoutes = (
  iam: AuditReader & Authenticator,
  limits: { login?: RateLimitOptions | false; mfa?: RateLimitOptions | false } = {},
) => {
  const limiter = (options: RateLimitOptions | false | undefined) =>
    options === false ? passThrough : createRateLimiter(options);
  return Router()
    .post('/auth/login', limiter(limits.login), async (req, res) => {
      const { username, password } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return void res.status(400).json({ error: 'username and password are required' });
      }
      if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return void res.status(400).json({ error: 'username or password is too long' });
      }
      const result = await iam.login(username, password);
      if (result.ok) {
        const body = result.mfaRequired
          ? { token: result.token, mfaRequired: true }
          : { token: result.token, mfaRequired: false, expiresAt: result.expiresAt };
        return void res.set('Cache-Control', 'no-store').json(body);
      }
      if (result.reason === 'LOCKED') return void res.status(423).json({ error: 'Account locked' });
      if (result.reason === 'MFA_NOT_ENROLLED') {
        return void res.status(403).json({ error: 'MFA not enrolled' });
      }
      res.status(401).json({ error: 'Invalid username or password' });
    })
    .post('/auth/mfa', limiter(limits.mfa), async (req, res) => {
      const token = bearer(req);
      const { code } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof code !== 'string') return void res.status(400).json({ error: 'code is required' });
      const result = token ? await iam.verifyMfa(token, code) : null;
      if (!result?.ok) return void res.status(401).json({ error: 'Invalid or expired code' });
      res.json({ expiresAt: result.expiresAt });
    })
    .post('/auth/logout', async (req, res) => {
      const token = bearer(req);
      if (token) await iam.logout(token);
      res.status(204).end();
    })
    .get('/auth/me', requirePermission('self:read'), (_req, res) => {
      res.json(res.locals.user as UserRef);
    })
    .get('/audit', requirePermission('audit:read'), async (req, res) => {
      const filter = parseFilter(req);
      if (typeof filter === 'string') return void res.status(400).json({ error: filter });
      res.json(await iam.search(filter));
    })
    .get('/audit/verify', requirePermission('audit:read'), async (_req, res) => {
      res.json(await iam.verify());
    });
};
