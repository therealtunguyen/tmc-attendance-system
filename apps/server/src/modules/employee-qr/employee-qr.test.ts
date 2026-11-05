import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { QR_TOKEN_TTL_S, verifyQrToken } from '../../shared/contracts/qr-token.js';
import type { Scope } from '../../shared/types.js';
import type { AuditEntry, AuditLog } from '../iam/index.js';
import { QrKeyring } from './employee-qr.keys.js';
import { employeeQrRoutes } from './employee-qr.routes.js';
import {
  DuplicateEmployeeCodeError,
  EmployeeQrService,
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

describe('employee routes', () => {
  const app = () => createApp([employeeQrRoutes(eqr)]);

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
      actorId: 'anonymous',
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

/** A fresh Ed25519 pair as .env would hold it: private PKCS8 and public SPKI, base64 DER. */
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
};

const k1 = pair();
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
  /** Stands in for the IAM auth middleware (FR-5.1). */
  const signedInAs = (id?: string) =>
    Router().use((_req, res, next) => {
      if (id) res.locals.user = { id, role: 'EMP' };
      next();
    });
  const app = (id?: string) =>
    createApp([
      signedInAs(id),
      employeeQrRoutes(new EmployeeQrService(store, audit, keysK1, () => NOW)),
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
});
