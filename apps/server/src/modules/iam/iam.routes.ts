import { Router, type Request, type RequestHandler } from 'express';
import { createRateLimiter, type RateLimitOptions } from './iam.ratelimit.js';
import { requirePermission } from './iam.rbac.js';
import {
  NoticeError,
  type AuditFilter,
  type AuditReader,
  type Authenticator,
  type Notice,
  type ScopeResolver,
  type UserRef,
} from './iam.service.js';

/** What the routes and the guard need from the service. */
export interface NoticeApi {
  currentNotice(): Promise<Notice | null>;
  publishNotice(actorId: string, text: string): Promise<Notice>;
  acknowledgeNotice(userId: string, version: number): Promise<void>;
  noticePending(userId: string): Promise<number | null>;
}

/** The bearer token of the request, or undefined when the header is missing or malformed. */
const bearer = (req: Request): string | undefined => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
  return match?.[1];
};

/**
 * Sets res.locals.user from a valid, fully authenticated session (FR-5.2). Never answers 401 or 403
 * itself: routes decide through requirePermission, which answers 401 without a user.
 * Store errors from the authenticator or resolver propagate to the error handler.
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

/** Reachable before the notice is acknowledged; paths are relative to the /api mount (NFR-20). */
const NOTICE_EXEMPT = new Set([
  '/auth/login',
  '/auth/mfa',
  '/auth/logout',
  '/auth/me',
  '/privacy-notice',
  '/privacy-notice/ack',
  // Gate access and attendance are needed to perform the labour contract (Decree 13/2023 Art. 17):
  // the QR token and the live QR page the email link opens.
  // When gate monitor/override/emergency routes land, exempt them by permission rather than by
  // path, so that an unacknowledged notice never blocks an emergency action.
  '/qr/token',
  '/me/qr',
]);

/**
 * Blocks a signed-in user until they acknowledge the current privacy notice (NFR-20). Mount after
 * authenticate, which runs under the same /api mount, so req.path has no /api prefix. Requests
 * without a user (kiosks, edge devices) pass; routes decide 401 themselves.
 */
export const requireNoticeAck =
  (notices: Pick<NoticeApi, 'noticePending'>): RequestHandler =>
  async (req, res, next) => {
    const user = res.locals.user as UserRef | undefined;
    if (!user || NOTICE_EXEMPT.has(req.path.replace(/(?<=.)\/$/, ''))) return void next();
    const version = await notices.noticePending(user.id);
    if (version === null) return void next();
    res
      .status(403)
      .json({ error: 'Privacy notice must be acknowledged', code: 'NOTICE_REQUIRED', version });
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
  iam: AuditReader & Authenticator & NoticeApi,
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
    .get('/auth/me', requirePermission('self:read'), async (_req, res) => {
      const user = res.locals.user as UserRef;
      res.json({ ...user, noticePending: await iam.noticePending(user.id) });
    })
    .get('/privacy-notice', requirePermission('self:read'), async (_req, res) => {
      const notice = await iam.currentNotice();
      if (!notice) return void res.status(404).json({ error: 'No privacy notice published' });
      res.json(notice);
    })
    .post('/privacy-notice/ack', requirePermission('self:read'), async (req, res) => {
      const { version } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof version !== 'number' || !Number.isInteger(version)) {
        return void res.status(400).json({ error: 'version must be an integer' });
      }
      try {
        await iam.acknowledgeNotice((res.locals.user as UserRef).id, version);
      } catch (err) {
        if (!(err instanceof NoticeError)) throw err;
        if (err.code === 'NO_NOTICE') return void res.status(404).json({ error: err.message });
        return void res
          .status(409)
          .json({ error: err.message, currentVersion: err.currentVersion });
      }
      res.status(204).end();
    })
    .put('/privacy-notice', requirePermission('notice:publish'), async (req, res) => {
      const { text } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof text !== 'string') return void res.status(400).json({ error: 'text is required' });
      try {
        res.status(201).json(await iam.publishNotice((res.locals.user as UserRef).id, text));
      } catch (err) {
        if (err instanceof NoticeError && err.code === 'INVALID_TEXT') {
          return void res.status(400).json({ error: err.message });
        }
        throw err;
      }
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
