import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  canSeeEmployee,
  check,
  hasPermission,
  inScope,
  requirePermission,
  type Permission,
} from './iam.rbac.js';
import type { Role, UserRef } from './iam.service.js';

const roles: Role[] = ['EMP', 'SUP', 'HR', 'GRD', 'ADM', 'EXE'];

/** Allowed roles per permission, from the matrix (FR-5.3). */
const matrix: Record<Permission, Role[]> = {
  'self:read': roles,
  'employee:read': ['HR', 'ADM'],
  'employee:manage': ['HR', 'ADM'],
  'qr:revoke': ['HR', 'ADM'],
  'attendance:read:team': ['SUP', 'HR'],
  'attendance:correct': ['HR', 'SUP'],
  'attendance:request-correction': ['EMP', 'SUP'],
  'export:hr': ['HR'],
  'report:read': ['HR', 'SUP', 'EXE'],
  'dashboard:read': ['SUP', 'HR', 'GRD', 'EXE'],
  'gate:monitor': ['GRD'],
  'gate:override': ['GRD'],
  'gate:emergency': ['GRD', 'ADM'],
  'gate:manage': ['ADM'],
  'user:manage': ['ADM'],
  'audit:read': ['ADM'],
  'notice:publish': ['HR', 'ADM'],
};

describe('role-permission matrix', () => {
  const cases = Object.entries(matrix).flatMap(([permission, allowed]) =>
    roles.map((role) => [role, permission as Permission, allowed.includes(role)] as const),
  );

  it.each(cases)('%s %s -> %s', (role, permission, expected) => {
    expect(hasPermission(role, permission)).toBe(expected);
  });

  it('keeps ADM out of attendance data and audit writes (separation of duties)', () => {
    expect(hasPermission('ADM', 'attendance:correct')).toBe(false);
    expect(hasPermission('ADM', 'attendance:request-correction')).toBe(false);
    expect(hasPermission('ADM', 'audit:read')).toBe(true);
  });

  it('EXE cannot read employees; GRD alone overrides gates', () => {
    expect(hasPermission('EXE', 'employee:read')).toBe(false);
    expect(roles.filter((r) => hasPermission(r, 'gate:override'))).toEqual(['GRD']);
  });

  it('unknown role returns false for any permission', () => {
    expect(hasPermission('FOO' as Role, 'self:read')).toBe(false);
  });
});

describe('scope (BR-15)', () => {
  const sup = (scopes?: string[]): UserRef => ({ id: 's', role: 'SUP', scopes });
  const hr = (scopes?: string[]): UserRef => ({ id: 'h', role: 'HR', scopes });

  it('denies a SUP without scopes any scoped check, but not an unscoped one', () => {
    for (const user of [sup(), sup([])]) {
      expect(check(user, 'attendance:read:team', 'bd-line-1')).toBe(false);
      expect(check(user, 'attendance:read:team')).toBe(true);
    }
  });

  it('allows a SUP only their own team', () => {
    const user = sup(['bd-line-1']);
    expect(check(user, 'attendance:read:team', 'bd-line-1')).toBe(true);
    expect(check(user, 'attendance:read:team', 'bd-line-2')).toBe(false);
  });

  it('allows unscoped HR any scope, and scoped HR only their factory', () => {
    expect(inScope(hr(), 'anything')).toBe(true);
    expect(check(hr(['binh-duong']), 'employee:manage', 'binh-duong')).toBe(true);
    expect(check(hr(['binh-duong']), 'employee:manage', 'long-an')).toBe(false);
  });

  it('checks the permission even when the scope fits', () => {
    expect(check({ id: 'e', role: 'EMP' }, 'employee:manage', 'x')).toBe(false);
    expect(check(hr(), 'audit:read', 'x')).toBe(false);
  });

  it('canSeeEmployee matches by factory or by team', () => {
    const lan = { factoryId: 'binh-duong', teamId: 'bd-line-1' };
    expect(canSeeEmployee(hr(), lan)).toBe(true);
    expect(canSeeEmployee(hr(['binh-duong']), lan)).toBe(true);
    expect(canSeeEmployee(hr(['long-an']), lan)).toBe(false);
    expect(canSeeEmployee(sup(['bd-line-1']), lan)).toBe(true);
    expect(canSeeEmployee(sup(['bd-line-2']), lan)).toBe(false);
    expect(canSeeEmployee(sup(), lan)).toBe(false);
    expect(canSeeEmployee(sup(['bd-line-1']), { ...lan, teamId: null })).toBe(false);
  });
});

describe('requirePermission', () => {
  const app = (user?: UserRef) =>
    express()
      .use((_req, res, next) => {
        if (user) res.locals.user = user;
        next();
      })
      .get('/x', requirePermission('audit:read'), (_req, res) => void res.json({ ok: true }));

  it('401 without a user, 403 without the permission, else next()', async () => {
    const no = await request(app()).get('/x');
    expect([no.status, no.body]).toEqual([401, { error: 'Not signed in' }]);
    const hr = await request(app({ id: 'h', role: 'HR' })).get('/x');
    expect([hr.status, hr.body]).toEqual([403, { error: 'Forbidden' }]);
    const adm = await request(app({ id: 'a', role: 'ADM' })).get('/x');
    expect([adm.status, adm.body]).toEqual([200, { ok: true }]);
  });

  it('calls next directly when allowed', () => {
    const next = vi.fn();
    const res = { locals: { user: { id: 'a', role: 'ADM' } } };
    requirePermission('audit:read')({} as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('403 for unknown role', async () => {
    const unknown = await request(app({ id: 'u', role: 'FOO' as Role })).get('/x');
    expect([unknown.status, unknown.body]).toEqual([403, { error: 'Forbidden' }]);
  });
});
