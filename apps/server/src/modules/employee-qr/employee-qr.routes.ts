import { Router, type Request, type RequestHandler, type Response } from 'express';
import { QR_TOKEN_TTL_S } from '../../shared/contracts/qr-token.js';
import {
  canSeeEmployee,
  createRateLimiter,
  inScope,
  isRestricted,
  requirePermission,
  type RateLimitOptions,
  type UserRef,
} from '../iam/index.js';
import {
  DuplicateEmployeeCodeError,
  QrNotConfiguredError,
  QrNotIssuableError,
  type EdgeGates,
  type EmployeeChanges,
  type EmployeeQrService,
  type NewEmployee,
} from './employee-qr.service.js';

/** Looks up the org tree for team checks; implemented by the admin module. */
export interface TeamDirectory {
  /** The factory a team belongs to; null for an unknown ID or one that is not a TEAM. */
  factoryOf(teamId: string): Promise<string | null>;
}

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

/** Answers with the signed-in employee's QR, or the reason there is none, which the portal shows. */
const ownQr =
  (issue: (employeeId: string) => Promise<object>): RequestHandler =>
  async (_req, res) => {
    const { employeeId } = userOf(res);
    if (!employeeId) {
      return void res
        .status(403)
        .json({ error: 'No employee record linked to this account', reason: 'NO_EMPLOYEE' });
    }
    try {
      res.set('Cache-Control', 'no-store').json(await issue(employeeId));
    } catch (e) {
      if (e instanceof QrNotConfiguredError) {
        return void res.status(503).json({ error: 'QR signing not configured' });
      }
      if (!(e instanceof QrNotIssuableError)) throw e;
      res.status(403).json({ error: e.message, reason: e.reason });
    }
  };

/** A 400 message when the team is unknown or sits in another factory, else null. */
const teamProblem = async (
  teams: TeamDirectory,
  teamId: string,
  factoryId: string,
): Promise<string | null> => {
  const owner = await teams.factoryOf(teamId);
  if (owner === null) return 'teamId is not a known team';
  return owner === factoryId ? null : 'teamId belongs to another factory';
};

/** /qr/token and /me/qr share one budget per user: 10 calls a minute by default (portal needs 2; a loop would flood the edge outbox); false disables. */
export const employeeQrRoutes = (
  eqr: EmployeeQrService,
  teams?: TeamDirectory,
  limits: { qrToken?: RateLimitOptions | false } = {},
  edgeGates?: EdgeGates,
) => {
  // One instance, so both token routes draw on the same per-user count. Per user, not per IP: a factory shares one IP.
  const qrLimit: RequestHandler =
    limits.qrToken === false
      ? (_req, _res, next) => next()
      : createRateLimiter({ key: (_req, res) => userOf(res).id, ...limits.qrToken });
  return (
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
        if (teams && typeof body.teamId === 'string') {
          const problem = await teamProblem(
            teams,
            trimmed(body.teamId) as string,
            trimmed(body.factoryId) as string,
          );
          if (problem) return void res.status(400).json({ error: problem });
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
        if (teams) {
          // A factory change alone must not leave the employee in a team of the old factory.
          const teamId = 'teamId' in changes ? changes.teamId : current.teamId;
          const factoryId = changes.factoryId ?? current.factoryId;
          if (teamId && (changes.factoryId !== undefined || 'teamId' in changes)) {
            const problem = await teamProblem(teams, teamId, factoryId);
            if (problem) return void res.status(400).json({ error: problem });
          }
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
      // Every role views its own QR (self:read). Identity comes from the verified session, never a request field.
      .post(
        '/qr/token',
        requirePermission('self:read'),
        qrLimit,
        ownQr(async (id) => ({ token: await eqr.issueToken(id), ttlSeconds: QR_TOKEN_TTL_S })),
      )
      // The portal's QR page (FR-1.3). A GET: issuing is stateless, it stores nothing.
      .get(
        '/me/qr',
        requirePermission('self:read'),
        qrLimit,
        ownQr((id) => eqr.liveQr(id)),
      )
      // Own profile only (FR-1.6): the employee comes from the verified session, never a request field.
      .get('/me/profile', requirePermission('self:read'), async (_req, res) => {
        const { employeeId } = userOf(res);
        if (!employeeId) {
          return void res
            .status(403)
            .json({ error: 'No employee record linked to this account', reason: 'NO_EMPLOYEE' });
        }
        const employee = await eqr.getProfile(employeeId);
        if (!employee) return void res.status(404).json({ error: 'Employee not found' });
        res.set('Cache-Control', 'no-store').json(employee);
      })
      .post('/employees/:id/qr/revoke', requirePermission('qr:revoke'), async (req, res) => {
        const current = await eqr.getProfile(idOf(req));
        if (!current || !canSeeEmployee(userOf(res), current)) {
          return void res.status(404).json({ error: 'Employee not found' });
        }
        const employee = await eqr.revokeQr(userOf(res).id, idOf(req));
        if (!employee) return void res.status(404).json({ error: 'Employee not found' });
        res.json(employee);
      })
      .post('/employees/:id/qr/reissue', requirePermission('qr:revoke'), async (req, res) => {
        const current = await eqr.getProfile(idOf(req));
        if (!current || !canSeeEmployee(userOf(res), current)) {
          return void res.status(404).json({ error: 'Employee not found' });
        }
        try {
          const employee = await eqr.reissueQr(userOf(res).id, idOf(req));
          if (!employee) return void res.status(404).json({ error: 'Employee not found' });
          res.json(employee);
        } catch (e) {
          if (!(e instanceof QrNotIssuableError)) throw e;
          res.status(409).json({ error: e.message, reason: e.reason });
        }
      })
      // Edge agent (ADR-9). Response: EdgeSnapshot. Authenticated by authenticateEdge (#69), mounted on /api/edge.
      .get('/edge/snapshot', async (_req, res) => {
        const edgeId = res.locals.edgeId as string | undefined;
        if (!edgeId) {
          return void res.status(401).json({ error: 'Edge authentication required' });
        }
        try {
          // Only this edge's gates (#113); the id comes from edge auth, never from the query.
          const gates = (await edgeGates?.gatesForEdge(edgeId)) ?? [];
          res.set('Cache-Control', 'no-store').json(await eqr.snapshot(gates));
        } catch (e) {
          if (!(e instanceof QrNotConfiguredError)) throw e;
          res.status(503).json({ error: 'QR signing not configured' });
        }
      })
  );
};
