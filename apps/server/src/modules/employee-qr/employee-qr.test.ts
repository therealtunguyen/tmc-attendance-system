import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { EdgeSnapshot } from '../../shared/contracts/edge.js';
import { QR_TOKEN_TTL_S, signQrToken, verifyQrToken } from '../../shared/contracts/qr-token.js';
import { checkQrToken } from '../../shared/contracts/qr-validation.js';
import type { Scope } from '../../shared/types.js';
import type { AuditEntry, AuditLog, UserRef } from '../iam/index.js';
import { QrKeyring } from './employee-qr.keys.js';
import { employeeQrRoutes } from './employee-qr.routes.js';
import {
  DuplicateEmployeeCodeError,
  EmployeeQrService,
  QrNotConfiguredError,
  QrNotIssuableError,
  type Employee,
  type EmployeeChanges,
  type EmployeeStore,
  type NewEmployee,
  type QrKeyConfig,
} from './employee-qr.service.js';

class InMemoryEmployees implements EmployeeStore {
  rows = new Map<string, Employee>();

  async create(data: NewEmployee) {
    if ([...this.rows.values()].some((e) => e.code === data.code)) {
      throw new DuplicateEmployeeCodeError(data.code);
    }
    const employee = { ...data, id: randomUUID(), active: true, qrRevoked: false };
    this.rows.set(employee.id, employee);
    return { ...employee };
  }

  async update(id: string, changes: EmployeeChanges) {
    return this.write(id, changes);
  }

  async find(id: string) {
    const employee = this.rows.get(id);
    return employee ? { ...employee } : null;
  }

  async list(scope?: Scope) {
    return [...this.rows.values()].filter(
      (e) => scope === undefined || e.factoryId === scope || e.teamId === scope,
    );
  }

  async deactivate(id: string) {
    const employee = this.rows.get(id);
    if (!employee || (!employee.active && employee.qrRevoked)) return null;
    return this.write(id, { active: false, qrRevoked: true });
  }

  private write(id: string, changes: Partial<Employee>) {
    const employee = this.rows.get(id);
    if (!employee) return null;
    Object.assign(employee, changes);
    return { ...employee };
  }
}

class RecordingAudit implements AuditLog {
  entries: AuditEntry[] = [];

  async append(entry: AuditEntry) {
    this.entries.push(entry);
  }

  async search() {
    return this.entries;
  }
}

const keys = { kid: '', privateKey: '', previousKid: '', previousPublicKey: '' };

const lan: NewEmployee = {
  code: 'BD-0001',
  firstName: 'Lan',
  lastName: 'Nguyen',
  email: 'lan@tmc.vn',
  factoryId: 'binh-duong',
  teamId: 'bd-line-1',
};

let store: InMemoryEmployees;
let audit: RecordingAudit;
let eqr: EmployeeQrService;

beforeEach(() => {
  store = new InMemoryEmployees();
  audit = new RecordingAudit();
  eqr = new EmployeeQrService(store, audit, keys);
});

describe('EmployeeQrService: employee CRUD (FR-1.1, FR-1.5)', () => {
  it('creates an active employee with a valid QR and audits who did it', async () => {
    const employee = await eqr.createEmployee('hr-1', lan);
    expect(employee).toMatchObject({ ...lan, active: true, qrRevoked: false });
    expect(audit.entries).toEqual([
      {
        actorId: 'hr-1',
        action: 'EMPLOYEE_CREATE',
        target: `employee:${employee.id}`,
        at: expect.any(Date),
      },
    ]);
  });

  it('rejects a duplicate employee code without auditing', async () => {
    await eqr.createEmployee('hr-1', lan);
    await expect(eqr.createEmployee('hr-1', lan)).rejects.toBeInstanceOf(
      DuplicateEmployeeCodeError,
    );
    expect(audit.entries).toHaveLength(1);
  });

  it('updates a profile and audits it; an unknown ID returns null and audits nothing', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    expect(await eqr.updateEmployee('hr-2', id, { teamId: null })).toMatchObject({ teamId: null });
    expect(await eqr.updateEmployee('hr-2', 'nope', { firstName: 'X' })).toBeNull();
    expect(audit.entries.map((e) => e.action)).toEqual(['EMPLOYEE_CREATE', 'EMPLOYEE_UPDATE']);
  });

  it('deactivating also revokes the QR (FR-1.5), and is audited once', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    expect(await eqr.deactivateEmployee('hr-1', id)).toMatchObject({
      active: false,
      qrRevoked: true,
    });
    expect(await eqr.deactivateEmployee('hr-1', id)).toMatchObject({ active: false });
    expect(audit.entries.map((e) => e.action)).toEqual(['EMPLOYEE_CREATE', 'EMPLOYEE_DEACTIVATE']);
    expect(await eqr.deactivateEmployee('hr-1', 'nope')).toBeNull();
  });

  it('deactivating an inactive employee whose QR is not revoked still revokes it', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    store.rows.get(id)!.active = false;
    expect(await eqr.deactivateEmployee('hr-1', id)).toMatchObject({ qrRevoked: true });
    expect(audit.entries.map((e) => e.action)).toContain('EMPLOYEE_DEACTIVATE');
  });

  it('two concurrent deactivations audit once', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const both = await Promise.all([
      eqr.deactivateEmployee('hr-1', id),
      eqr.deactivateEmployee('hr-2', id),
    ]);
    expect(both.every((e) => e?.active === false)).toBe(true);
    expect(audit.entries.filter((e) => e.action === 'EMPLOYEE_DEACTIVATE')).toHaveLength(1);
  });

  it('lists by factory or team', async () => {
    await eqr.createEmployee('hr-1', lan);
    await eqr.createEmployee('hr-1', {
      ...lan,
      code: 'LA-0001',
      factoryId: 'long-an',
      teamId: null,
    });
    expect(await eqr.listProfiles()).toHaveLength(2);
    expect((await eqr.listProfiles('long-an')).map((e) => e.code)).toEqual(['LA-0001']);
    expect((await eqr.listProfiles('bd-line-1')).map((e) => e.code)).toEqual(['BD-0001']);
  });

  it('gives other modules a summary without contact or org data (NFR-4)', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    expect(await eqr.find(id)).toEqual({ id, firstName: 'Lan', lastName: 'Nguyen', active: true });
    expect(await eqr.list('binh-duong')).toEqual([await eqr.find(id)]);
    expect(await eqr.find('nope')).toBeNull();
  });
});

/** Stands in for the IAM auth middleware (FR-5.1). */
const signedIn = (user?: UserRef) =>
  Router().use((_req, res, next) => {
    if (user) res.locals.user = user;
    next();
  });

describe('employee routes', () => {
  const hrUser: UserRef = { id: 'hr-9', role: 'HR' };
  const app = (user: UserRef | undefined = hrUser) =>
    createApp([signedIn(user), employeeQrRoutes(eqr)]);

  it('POST /api/employees creates (201), then 409 on the same code', async () => {
    const created = await request(app())
      .post('/api/employees')
      .send({ ...lan, teamId: undefined });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'BD-0001', teamId: null, active: true });
    const again = await request(app()).post('/api/employees').send(lan);
    expect(again.status).toBe(409);
  });

  it.each([
    ['a missing field', { ...lan, email: undefined }, 'email is required'],
    ['a blank field', { ...lan, firstName: '  ' }, 'firstName is required'],
    ['a bad email', { ...lan, email: 'lan' }, 'email is not valid'],
    ['a non-string teamId', { ...lan, teamId: 7 }, 'teamId must be a non-empty string'],
  ])('POST /api/employees rejects %s (400)', async (_name, body, error) => {
    const res = await request(app()).post('/api/employees').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
  });

  it('trims text fields before storing', async () => {
    const res = await request(app())
      .post('/api/employees')
      .send({ ...lan, code: ' BD-0001 ', email: ' lan@tmc.vn ', teamId: ' bd-line-1 ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'BD-0001', email: 'lan@tmc.vn', teamId: 'bd-line-1' });
    const patched = await request(app())
      .patch(`/api/employees/${res.body.id}`)
      .send({ lastName: ' Tran ' });
    expect(patched.body).toMatchObject({ lastName: 'Tran' });
  });

  it.each(['a@b', 'a b@c.d', '@c.d'])('rejects email %j (400)', async (email) => {
    expect(
      (
        await request(app())
          .post('/api/employees')
          .send({ ...lan, email })
      ).status,
    ).toBe(400);
  });

  it('rejects an array body and an empty PATCH without auditing (400)', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    expect((await request(app()).post('/api/employees').send([lan])).status).toBe(400);
    expect((await request(app()).patch(`/api/employees/${id}`).send([lan])).status).toBe(400);
    expect((await request(app()).patch(`/api/employees/${id}`).send({})).status).toBe(400);
    expect((await request(app()).patch(`/api/employees/${id}`).send({ junk: 1 })).status).toBe(400);
    expect(audit.entries).toHaveLength(1);
  });

  it('rejects an empty scope (400)', async () => {
    expect((await request(app()).get('/api/employees?scope=')).status).toBe(400);
  });

  it('GET, PATCH and deactivate one employee', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    expect((await request(app()).get(`/api/employees/${id}`)).body).toMatchObject({ id });
    expect((await request(app()).get('/api/employees?scope=long-an')).body).toEqual([]);

    const patched = await request(app()).patch(`/api/employees/${id}`).send({ lastName: 'Tran' });
    expect(patched.body).toMatchObject({ lastName: 'Tran', code: 'BD-0001' });
    const recode = await request(app()).patch(`/api/employees/${id}`).send({ code: 'X' });
    expect(recode.status).toBe(400);

    const off = await request(app()).post(`/api/employees/${id}/deactivate`);
    expect(off.body).toMatchObject({ active: false, qrRevoked: true });
    expect(audit.entries.at(-1)).toMatchObject({
      actorId: 'hr-9',
      action: 'EMPLOYEE_DEACTIVATE',
    });
  });

  it('returns 404 for an unknown employee', async () => {
    for (const res of [
      await request(app()).get('/api/employees/nope'),
      await request(app()).patch('/api/employees/nope').send({ lastName: 'X' }),
      await request(app()).post('/api/employees/nope/deactivate'),
    ]) {
      expect(res.status).toBe(404);
    }
  });
});

describe('employee routes: RBAC (FR-5.3, BR-15)', () => {
  const app = (user?: UserRef) => createApp([signedIn(user), employeeQrRoutes(eqr)]);
  const hrIn = (...scopes: string[]): UserRef => ({ id: 'hr-f', role: 'HR', scopes });
  const elsewhere = { ...lan, code: 'LA-1', factoryId: 'long-an', teamId: null };
  const seed = async () => ({
    mine: await eqr.createEmployee('hr-1', lan),
    other: await eqr.createEmployee('hr-1', elsewhere),
  });

  it('401 when nobody is signed in', async () => {
    expect((await request(app()).get('/api/employees')).status).toBe(401);
    expect((await request(app()).post('/api/employees').send(lan)).status).toBe(401);
  });

  it('403 for an employee on writes and lists', async () => {
    const emp: UserRef = { id: 'e-1', role: 'EMP' };
    expect((await request(app(emp)).post('/api/employees').send(lan)).status).toBe(403);
    expect((await request(app(emp)).get('/api/employees')).status).toBe(403);
    expect(store.rows.size).toBe(0);
  });

  it('403 for a supervisor: profiles are HR/ADM only', async () => {
    const { mine } = await seed();
    const sup: UserRef = { id: 'sup-1', role: 'SUP', scopes: ['bd-line-1'] };
    expect((await request(app(sup)).get('/api/employees')).status).toBe(403);
    expect((await request(app(sup)).get(`/api/employees/${mine.id}`)).status).toBe(403);
  });

  it('factory-scoped HR lists their factory, defaulting to the single scope', async () => {
    await seed();
    const user = hrIn('binh-duong');
    for (const url of ['/api/employees', '/api/employees?scope=binh-duong']) {
      const res = await request(app(user)).get(url);
      expect(res.body.map((e: Employee) => e.code)).toEqual(['BD-0001']);
    }
  });

  it('400 without a scope when HR has several; 403 for a factory outside theirs', async () => {
    await seed();
    const user = hrIn('binh-duong', 'long-an');
    const res = await request(app(user)).get('/api/employees');
    expect([res.status, res.body]).toEqual([400, { error: 'scope is required' }]);
    const ok = await request(app(user)).get('/api/employees?scope=long-an');
    expect(ok.body.map((e: Employee) => e.code)).toEqual(['LA-1']);
    expect(
      (await request(app(hrIn('binh-duong'))).get('/api/employees?scope=long-an')).status,
    ).toBe(403);
  });

  it('GET one employee: own factory 200, other factory 404 like a missing one', async () => {
    const { mine, other } = await seed();
    const user = hrIn('binh-duong');
    expect((await request(app(user)).get(`/api/employees/${mine.id}`)).status).toBe(200);
    expect((await request(app(user)).get(`/api/employees/${other.id}`)).status).toBe(404);
  });

  it('PATCH and deactivate in another factory are 404; create or move into one is 403', async () => {
    const { mine, other } = await seed();
    const user = hrIn('binh-duong');
    const patch = (id: string, body: object) =>
      request(app(user)).patch(`/api/employees/${id}`).send(body);
    expect((await patch(other.id, { lastName: 'X' })).status).toBe(404);
    expect((await request(app(user)).post(`/api/employees/${other.id}/deactivate`)).status).toBe(
      404,
    );
    expect(
      (
        await request(app(user))
          .post('/api/employees')
          .send({ ...elsewhere, code: 'LA-2' })
      ).status,
    ).toBe(403);
    expect((await patch(mine.id, { factoryId: 'long-an' })).status).toBe(403);
    expect(store.rows.get(mine.id)!.factoryId).toBe('binh-duong');
    expect(store.rows.get(other.id)).toMatchObject({ lastName: 'Nguyen', active: true });
    expect(
      (
        await request(app(user))
          .post('/api/employees')
          .send({ ...lan, code: 'BD-3' })
      ).status,
    ).toBe(201);
  });

  it('an unscoped HR may list everything without a scope', async () => {
    await seed();
    const res = await request(app({ id: 'hr-1', role: 'HR' })).get('/api/employees');
    expect(res.body).toHaveLength(2);
  });
});

/** A fresh Ed25519 pair as .env would hold it: private PKCS8 and public SPKI, base64 DER. */
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
};

const k1 = pair();
const priv1 = createPrivateKey({
  key: Buffer.from(k1.privateKey, 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const k2 = pair();
const keysK1: QrKeyConfig = {
  kid: 'k1',
  privateKey: k1.privateKey,
  previousKid: '',
  previousPublicKey: '',
};
/** After rotating k1 -> k2. */
const keysK2: QrKeyConfig = {
  kid: 'k2',
  privateKey: k2.privateKey,
  previousKid: 'k1',
  previousPublicKey: k1.publicKey,
};

const NOW = new Date('2026-11-05T07:00:00Z');
const nowS = NOW.getTime() / 1000;

describe('QrKeyring (ADR-10 key rotation)', () => {
  it('signs with the current key and trusts current + previous', () => {
    const ring = new QrKeyring(keysK2);
    expect(ring.kid).toBe('k2');
    expect(Object.keys(ring.publicKeys())).toEqual(['k2', 'k1']);
    expect(ring.edgePublicKeys()).toEqual([
      { kid: 'k2', spki: k2.publicKey },
      { kid: 'k1', spki: k1.publicKey },
    ]);
  });

  it('trusts only the current key when there was no rotation', () => {
    expect(new QrKeyring(keysK1).edgePublicKeys().map((k) => k.kid)).toEqual(['k1']);
  });

  it.each([
    ['no key', { ...keysK1, privateKey: '' }, 'not configured'],
    ['no kid', { ...keysK1, kid: '' }, 'not configured'],
    ['the same kid twice', { ...keysK2, previousKid: 'k2' }, 'must differ'],
    [
      'a non-Ed25519 key',
      {
        ...keysK1,
        privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .privateKey.export({ type: 'pkcs8', format: 'der' })
          .toString('base64'),
      },
      'Ed25519',
    ],
    [
      'a non-Ed25519 previous key',
      {
        ...keysK2,
        previousPublicKey: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .publicKey.export({ type: 'spki', format: 'der' })
          .toString('base64'),
      },
      'QR_PREVIOUS_PUBLIC_KEY must be an Ed25519',
    ],
    ['a previous kid without its key', { ...keysK2, previousPublicKey: '' }, 'both'],
    ['a previous key without its kid', { ...keysK2, previousKid: '' }, 'both'],
  ])('refuses %s', (_name, config, message) => {
    expect(() => new QrKeyring(config)).toThrow(message);
  });
});

describe('EmployeeQrService.issueToken (FR-1.2, ADR-10)', () => {
  const issuer = (keys: QrKeyConfig) => new EmployeeQrService(store, audit, keys, () => NOW);

  it('issues a token for the employee, signed with the current kid, valid for the TTL', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const token = await issuer(keysK1).issueToken(id);
    const result = verifyQrToken(token, new QrKeyring(keysK1).publicKeys(), nowS);
    expect(result).toEqual({
      ok: true,
      kid: 'k1',
      claims: { sub: id, exp: nowS + QR_TOKEN_TTL_S, jti: expect.any(String) },
    });
  });

  it('uses a new jti every time', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const svc = issuer(keysK1);
    const jtis = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = verifyQrToken(
        await svc.issueToken(id),
        new QrKeyring(keysK1).publicKeys(),
        nowS,
      );
      if (result.ok) jtis.add(result.claims.jti);
    }
    expect(jtis.size).toBe(5);
  });

  it('keeps tokens from before a rotation valid, and signs new ones with the new kid', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const before = await issuer(keysK1).issueToken(id);
    const after = await issuer(keysK2).issueToken(id);
    const trusted = new QrKeyring(keysK2).publicKeys();
    expect(verifyQrToken(before, trusted, nowS)).toMatchObject({ ok: true, kid: 'k1' });
    expect(verifyQrToken(after, trusted, nowS)).toMatchObject({ ok: true, kid: 'k2' });
  });

  const states: [QrNotIssuableError['reason'], Partial<Employee> | null][] = [
    ['UNKNOWN', null],
    ['INACTIVE', { active: false }],
    ['REVOKED', { qrRevoked: true }],
  ];

  it.each(states)('refuses an %s employee', async (reason, state) => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    if (state) Object.assign(store.rows.get(id)!, state);
    const target = state ? id : 'nope';
    const error = await issuer(keysK1)
      .issueToken(target)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QrNotIssuableError);
    expect(error).toMatchObject({ reason });
  });

  it('fails clearly when the keys are not configured', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    await expect(eqr.issueToken(id)).rejects.toThrow('QR signing key not configured');
  });
});

describe('POST /api/qr/token', () => {
  const signedInAs = (id?: string, role = 'EMP') =>
    signedIn(id ? ({ id, role } as UserRef) : undefined);
  const app = (id?: string, role?: string, keys = keysK1) =>
    createApp([
      signedInAs(id, role),
      employeeQrRoutes(new EmployeeQrService(store, audit, keys, () => NOW)),
    ]);

  it('returns a fresh token for the signed-in employee, not cached', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const res = await request(app(id)).post('/api/qr/token');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ token: expect.any(String), ttlSeconds: QR_TOKEN_TTL_S });
    expect(verifyQrToken(res.body.token, new QrKeyring(keysK1).publicKeys(), nowS)).toMatchObject({
      ok: true,
      claims: { sub: id },
    });
  });

  it('401 when not signed in, 403 with the reason when the employee may not get a QR', async () => {
    expect((await request(app()).post('/api/qr/token')).status).toBe(401);
    const { id } = await eqr.createEmployee('hr-1', lan);
    await eqr.deactivateEmployee('hr-1', id);
    const res = await request(app(id)).post('/api/qr/token');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ reason: 'INACTIVE' });
  });

  it('every role may view its own QR (self:read)', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    for (const role of ['EMP', 'SUP', 'HR', 'GRD', 'ADM', 'EXE']) {
      expect((await request(app(id, role)).post('/api/qr/token')).status).toBe(200);
    }
  });

  it('ignores an employeeId in the query or body: the token is for the session user', async () => {
    const me = await eqr.createEmployee('hr-1', lan);
    const other = await eqr.createEmployee('hr-1', { ...lan, code: 'E2' });
    const res = await request(app(me.id))
      .post(`/api/qr/token?employeeId=${other.id}`)
      .send({ employeeId: other.id });
    expect(res.status).toBe(200);
    expect(verifyQrToken(res.body.token, new QrKeyring(keysK1).publicKeys(), nowS)).toMatchObject({
      claims: { sub: me.id },
    });
  });

  it('503 without leaking the reason when the keys are misconfigured', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const res = await request(app(id, 'EMP', { ...keysK1, privateKey: '' })).post('/api/qr/token');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'QR signing not configured' });
  });
});

describe('EmployeeQrService.snapshot (ADR-9)', () => {
  const svc = (keys = keysK2) => new EmployeeQrService(store, audit, keys, () => NOW);

  it('gives the server time and the current and previous public keys', async () => {
    const snapshot = await svc().snapshot();
    expect(snapshot).toEqual({
      generatedAt: NOW.toISOString(),
      publicKeys: [
        { kid: 'k2', spki: k2.publicKey },
        { kid: 'k1', spki: k1.publicKey },
      ],
      employees: [],
    });
  });

  it('lists every employee with the reason a gate must deny them', async () => {
    const ok = await eqr.createEmployee('hr-1', lan);
    const rev = await eqr.createEmployee('hr-1', { ...lan, code: 'E2', firstName: 'Hoa' });
    const off = await eqr.createEmployee('hr-1', { ...lan, code: 'E3', firstName: 'Minh' });
    const idle = await eqr.createEmployee('hr-1', { ...lan, code: 'E4', firstName: 'Tu' });
    store.rows.get(rev.id)!.qrRevoked = true;
    await eqr.deactivateEmployee('hr-1', off.id);
    store.rows.get(idle.id)!.active = false;
    expect((await svc().snapshot()).employees).toEqual([
      { id: ok.id, firstName: 'Lan', deny: null },
      { id: rev.id, firstName: 'Hoa', deny: 'REVOKED' },
      { id: off.id, firstName: 'Minh', deny: 'INACTIVE' },
      { id: idle.id, firstName: 'Tu', deny: 'INACTIVE' },
    ]);
  });

  it('covers every factory: one snapshot for all edges', async () => {
    await eqr.createEmployee('hr-1', lan);
    await eqr.createEmployee('hr-1', { ...lan, code: 'LA-1', factoryId: 'long-an', teamId: null });
    expect((await svc().snapshot()).employees).toHaveLength(2);
  });

  it('holds only id, first name and deny state, no other personal data (NFR-4)', async () => {
    await eqr.createEmployee('hr-1', lan);
    const { employees } = await svc().snapshot();
    expect(Object.keys(employees[0]).sort()).toEqual(['deny', 'firstName', 'id']);
    const wire = JSON.stringify(employees);
    for (const value of [lan.lastName, lan.email, lan.code, lan.factoryId]) {
      expect(wire).not.toContain(value);
    }
  });

  it('never carries a private key', async () => {
    expect(JSON.stringify(await svc().snapshot())).not.toContain(k2.privateKey);
  });

  it('takes generatedAt before reading employees, so age is never understated', async () => {
    let t = NOW.getTime();
    const list = store.list.bind(store);
    store.list = async (scope) => {
      t += 5_000;
      return list(scope);
    };
    const snapshot = await new EmployeeQrService(
      store,
      audit,
      keysK1,
      () => new Date(t),
    ).snapshot();
    expect(snapshot.generatedAt).toBe(NOW.toISOString());
  });

  it('rejects when the keys are missing or storage fails, rather than a partial snapshot', async () => {
    await expect(svc({ ...keysK1, privateKey: '' }).snapshot()).rejects.toBeInstanceOf(
      QrNotConfiguredError,
    );
    store.list = async () => {
      throw new Error('db down');
    };
    await expect(svc().snapshot()).rejects.toThrow('db down');
  });

  it('is all an edge needs: the same decision as the server, from the JSON alone', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const token = await svc().issueToken(id);
    const decide = async () => {
      const wire = JSON.parse(JSON.stringify(await svc().snapshot())) as EdgeSnapshot;
      return checkQrToken(token, {
        publicKeys: Object.fromEntries(
          wire.publicKeys.map(({ kid, spki }) => [
            kid,
            createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }),
          ]),
        ),
        findEmployee: (sub) => wire.employees.find((e) => e.id === sub) ?? null,
        nowS,
      });
    };
    expect(await decide()).toMatchObject({ ok: true, employeeId: id, firstName: 'Lan' });
    store.rows.get(id)!.qrRevoked = true;
    expect(await decide()).toMatchObject({ ok: false, reason: 'REVOKED' });
  });
});

describe('GET /api/edge/snapshot', () => {
  const app = (keys = keysK1) =>
    createApp([employeeQrRoutes(new EmployeeQrService(store, audit, keys, () => NOW))]);

  it('needs no user session: the edge has none', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const res = await request(app()).get('/api/edge/snapshot?edgeId=edge-bd');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      generatedAt: NOW.toISOString(),
      publicKeys: [{ kid: 'k1', spki: k1.publicKey }],
      employees: [{ id, firstName: 'Lan', deny: null }],
    });
  });

  it('is never cached: a revocation must reach the edge on its next pull', async () => {
    const res = await request(app()).get('/api/edge/snapshot?edgeId=edge-bd');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('503 without details when the keys are misconfigured, so the edge keeps its last snapshot', async () => {
    const res = await request(app({ ...keysK1, privateKey: '' })).get('/api/edge/snapshot');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'QR signing not configured' });
  });

  it('500 when storage fails', async () => {
    store.list = async () => {
      throw new Error('db down');
    };
    expect((await request(app()).get('/api/edge/snapshot')).status).toBe(500);
  });
});

describe('EmployeeQrService.validate (FR-2.2)', () => {
  const svc = (keys: QrKeyConfig) => new EmployeeQrService(store, audit, keys, () => NOW);

  it('admits a token it issued, with the first name for the kiosk', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const token = await svc(keysK1).issueToken(id);
    expect(await svc(keysK1).validate(token)).toEqual({
      ok: true,
      employeeId: id,
      firstName: 'Lan',
      jti: expect.any(String),
    });
  });

  it('denies a token issued before the employee was deactivated or revoked', async () => {
    const off = await eqr.createEmployee('hr-1', lan);
    const rev = await eqr.createEmployee('hr-1', { ...lan, code: 'BD-0002' });
    const offToken = await svc(keysK1).issueToken(off.id);
    const revToken = await svc(keysK1).issueToken(rev.id);
    await eqr.deactivateEmployee('hr-1', off.id);
    store.rows.get(rev.id)!.qrRevoked = true;
    expect(await svc(keysK1).validate(offToken)).toMatchObject({ ok: false, reason: 'INACTIVE' });
    expect(await svc(keysK1).validate(revToken)).toMatchObject({ ok: false, reason: 'REVOKED' });
  });

  it('denies INACTIVE when the employee is both inactive and revoked', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const token = await svc(keysK1).issueToken(id);
    Object.assign(store.rows.get(id)!, { active: false, qrRevoked: true });
    expect(await svc(keysK1).validate(token)).toMatchObject({ ok: false, reason: 'INACTIVE' });
  });

  it('denies UNKNOWN for a deleted employee', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const token = await svc(keysK1).issueToken(id);
    store.rows.delete(id);
    expect(await svc(keysK1).validate(token)).toMatchObject({ ok: false, reason: 'UNKNOWN' });
  });

  it('denies INVALID_SIGNATURE for a token signed by a foreign key', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const foreign = generateKeyPairSync('ed25519').privateKey;
    const token = signQrToken({ sub: id, exp: nowS + 60, jti: 'j' }, 'k1', foreign);
    expect(await svc(keysK1).validate(token)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('accepts exp 10 s in the past and denies 11 s as EXPIRED', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const signed = (exp: number) => signQrToken({ sub: id, exp, jti: 'j' }, 'k1', priv1);
    expect(await svc(keysK1).validate(signed(nowS - 10))).toMatchObject({ ok: true });
    expect(await svc(keysK1).validate(signed(nowS - 11))).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('admits a token from the previous key after a rotation', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const token = await svc(keysK1).issueToken(id);
    expect(await svc(keysK2).validate(token)).toMatchObject({ ok: true, employeeId: id });
  });
});
