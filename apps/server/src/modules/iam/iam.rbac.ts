import type { RequestHandler } from 'express';
import type { Scope } from '../../shared/types.js';
import type { Role, UserRef } from './iam.service.js';

export type Permission =
  | 'self:read'
  | 'employee:read'
  | 'employee:manage'
  | 'qr:revoke'
  | 'attendance:read:team'
  | 'attendance:correct'
  | 'attendance:request-correction'
  | 'export:hr'
  | 'report:read'
  | 'dashboard:read'
  | 'gate:monitor'
  | 'gate:override'
  | 'gate:emergency'
  | 'gate:manage'
  | 'user:manage'
  | 'audit:read'
  | 'notice:publish'
  | 'org:read'
  | 'org:manage'
  | 'config:read'
  | 'config:manage';

/**
 * Role-permission matrix (FR-5.3, report Illustration 7). Roles not listed have nothing: deny by default.
 * ADM deliberately lacks attendance:correct and any audit write (separation of duties).
 * SUP rows are limited to the supervisor's own team by scope, see inScope.
 */
export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  EMP: ['self:read', 'attendance:request-correction'],
  // No employee:read: profiles (with email) are HR/ADM only (FR-1.1, NFR-4); SUP sees the team via attendance:read:team.
  SUP: [
    'self:read',
    'attendance:read:team',
    'attendance:request-correction',
    'report:read',
    'dashboard:read',
    'org:read',
  ],
  HR: [
    'self:read',
    'employee:read',
    'employee:manage',
    'qr:revoke',
    'attendance:read:team',
    'attendance:correct',
    'export:hr',
    'report:read',
    'dashboard:read',
    // HR owns the employee-facing data-protection notice (NFR-20); ADM operates it.
    'notice:publish',
    'org:read',
    'org:manage',
  ],
  GRD: ['self:read', 'dashboard:read', 'gate:monitor', 'gate:override', 'gate:emergency'],
  ADM: [
    'self:read',
    'employee:read',
    'employee:manage',
    'qr:revoke',
    'gate:emergency',
    'gate:manage',
    'user:manage',
    'audit:read',
    'notice:publish',
    'org:read',
    'org:manage',
    'config:read',
    'config:manage',
  ],
  EXE: ['self:read', 'report:read', 'dashboard:read'],
};

export const hasPermission = (role: Role, permission: Permission): boolean =>
  PERMISSIONS[role]?.includes(permission) ?? false;

/** Limited to some scopes. SUP is always team-scoped, so without scopes it has no team (BR-15). */
export const isRestricted = (user: UserRef): boolean =>
  user.role === 'SUP' || user.scopes !== undefined;

/** True if the user is unrestricted, else the scope is one of theirs. */
export const inScope = (user: UserRef, scope: Scope): boolean =>
  !isRestricted(user) || (user.scopes?.includes(scope) ?? false);

/**
 * Function and data scope together (BR-15). With scope undefined only the function is checked:
 * a handler that returns data must still filter by scope.
 */
export const check = (user: UserRef, permission: Permission, scope?: Scope): boolean =>
  hasPermission(user.role, permission) && (scope === undefined || inScope(user, scope));

/** Whether the user's scopes cover this employee's factory or team (BR-15). */
export const canSeeEmployee = (
  user: UserRef,
  employee: { factoryId: Scope; teamId: Scope | null },
): boolean =>
  !isRestricted(user) ||
  inScope(user, employee.factoryId) ||
  (employee.teamId !== null && inScope(user, employee.teamId));

/** Deny by default on every route: 401 without a session user, 403 without the permission. */
export const requirePermission =
  (permission: Permission): RequestHandler =>
  (_req, res, next) => {
    const user = res.locals.user as UserRef | undefined;
    if (!user) return void res.status(401).json({ error: 'Not signed in' });
    if (!hasPermission(user.role, permission)) {
      return void res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
