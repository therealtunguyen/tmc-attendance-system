import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { QR_TOKEN_TTL_S, signQrToken, verifyQrToken } from '../../shared/contracts/qr-token.js';
import type { Scope } from '../../shared/types.js';
import type { AuditEntry, AuditLog } from '../iam/index.js';
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
  /** Stands in for the IAM auth middleware (FR-5.1). */
  const signedInAs = (id?: string, role = 'EMP') =>
    Router().use((_req, res, next) => {
      if (id) res.locals.user = { id, role };
      next();
    });
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

  it('403 for a signed-in user who is not an employee', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    expect((await request(app(id, 'HR')).post('/api/qr/token')).status).toBe(403);
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

describe('employee routes: who, edge cases, failures (#15)', () => {
  const signedIn = (user?: { id: string; role: string }) =>
    createApp([
      Router().use((_req, res, next) => {
        if (user) res.locals.user = user;
        next();
      }),
      employeeQrRoutes(eqr),
    ]);

  it('audits the signed-in user as the actor of every write', async () => {
    const hr = signedIn({ id: 'hr-7', role: 'HR' });
    const { body } = await request(hr).post('/api/employees').send(lan);
    await request(hr).patch(`/api/employees/${body.id}`).send({ lastName: 'Tran' });
    await request(hr).post(`/api/employees/${body.id}/deactivate`);
    expect(audit.entries.map((e) => [e.actorId, e.action, e.target])).toEqual([
      ['hr-7', 'EMPLOYEE_CREATE', `employee:${body.id}`],
      ['hr-7', 'EMPLOYEE_UPDATE', `employee:${body.id}`],
      ['hr-7', 'EMPLOYEE_DEACTIVATE', `employee:${body.id}`],
    ]);
  });

  it('GET /api/employees without a scope lists everyone', async () => {
    await eqr.createEmployee('hr-1', lan);
    await eqr.createEmployee('hr-1', { ...lan, code: 'LA-0001', factoryId: 'long-an' });
    expect((await request(signedIn()).get('/api/employees')).body).toHaveLength(2);
  });

  it('accepts teamId null on create and clears it on PATCH', async () => {
    const created = await request(signedIn())
      .post('/api/employees')
      .send({ ...lan, teamId: null });
    expect(created.body).toMatchObject({ teamId: null });
    const { id } = await eqr.createEmployee('hr-1', { ...lan, code: 'BD-0002' });
    const cleared = await request(signedIn()).patch(`/api/employees/${id}`).send({ teamId: null });
    expect(cleared.body).toMatchObject({ teamId: null });
  });

  it('rejects a blank or non-string value on PATCH (400) and changes nothing', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    for (const body of [{ firstName: '  ' }, { email: 5 }, { teamId: '' }, { email: 'bad' }]) {
      expect((await request(signedIn()).patch(`/api/employees/${id}`).send(body)).status).toBe(400);
    }
    expect(await eqr.getProfile(id)).toMatchObject({ firstName: 'Lan', email: 'lan@tmc.vn' });
  });

  it('deactivating twice is a 200 both times', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    for (let i = 0; i < 2; i++) {
      const res = await request(signedIn()).post(`/api/employees/${id}/deactivate`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ active: false, qrRevoked: true });
    }
  });

  it('a storage failure is a 500, not a duplicate, and is not audited', async () => {
    store.create = async () => {
      throw new Error('db down');
    };
    expect((await request(signedIn()).post('/api/employees').send(lan)).status).toBe(500);
    expect(audit.entries).toEqual([]);
  });
});

const k3 = pair();
/** A second rotation, k2 -> k3: k1 is no longer trusted anywhere. */
const keysK3: QrKeyConfig = {
  kid: 'k3',
  privateKey: k3.privateKey,
  previousKid: 'k2',
  previousPublicKey: k2.publicKey,
};

const claimsOf = (token: string): unknown =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

describe('QR token lifecycle (#22)', () => {
  const at = (keys: QrKeyConfig, seconds = 0) =>
    new EmployeeQrService(store, audit, keys, () => new Date(NOW.getTime() + seconds * 1000));

  describe('expired', () => {
    it('admits a token up to TTL + 10 s after it was issued, then denies it', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const token = await at(keysK1).issueToken(id);
      expect(await at(keysK1, 70).validate(token)).toMatchObject({ ok: true });
      expect(await at(keysK1, 71).validate(token)).toEqual({ ok: false, reason: 'EXPIRED' });
    });

    it('denies a token whose exp is too far ahead (verifier clock behind)', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const token = await at(keysK1).issueToken(id);
      expect(await at(keysK1, -10).validate(token)).toMatchObject({ ok: true });
      expect(await at(keysK1, -11).validate(token)).toEqual({ ok: false, reason: 'EXPIRED' });
    });

    it('rounds a fractional clock down, so exp is a whole number of seconds', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const clock = () => new Date(NOW.getTime() + 999);
      const token = await new EmployeeQrService(store, audit, keysK1, clock).issueToken(id);
      expect(claimsOf(token)).toMatchObject({ exp: nowS + QR_TOKEN_TTL_S });
    });
  });

  describe('bad signature', () => {
    it('denies a token whose sub was changed to another real employee', async () => {
      const me = await eqr.createEmployee('hr-1', lan);
      const victim = await eqr.createEmployee('hr-1', { ...lan, code: 'BD-0002' });
      const [h, c, s] = (await at(keysK1).issueToken(me.id)).split('.');
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      const swapped = Buffer.from(JSON.stringify({ ...claims, sub: victim.id })).toString(
        'base64url',
      );
      expect(await at(keysK1).validate(`${h}.${swapped}.${s}`)).toEqual({
        ok: false,
        reason: 'INVALID_SIGNATURE',
      });
    });

    it.each([undefined, null, 42, '', 'not-a-token'])('denies %j as a token', async (token) => {
      expect(await at(keysK1).validate(token as never)).toEqual({
        ok: false,
        reason: 'INVALID_SIGNATURE',
      });
    });
  });

  describe('old kid', () => {
    it('admits the previous key but not one rotated out two rotations ago', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const fromK1 = await at(keysK1).issueToken(id);
      const fromK2 = await at(keysK2).issueToken(id);
      expect(await at(keysK3).validate(fromK2)).toMatchObject({ ok: true });
      expect(await at(keysK3).validate(fromK1)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
    });

    it('denies a kid the verifier has not learned yet', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const fromK2 = await at(keysK2).issueToken(id);
      expect(await at(keysK1).validate(fromK2)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
    });

    it('verifies with the SPKI strings the edge gets, not only the server key objects', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const token = await at(keysK2).issueToken(id);
      const fromSnapshot = Object.fromEntries(
        new QrKeyring(keysK2)
          .edgePublicKeys()
          .map(({ kid, spki }) => [
            kid,
            createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }),
          ]),
      );
      expect(verifyQrToken(token, fromSnapshot, nowS)).toMatchObject({ ok: true, kid: 'k2' });
    });
  });

  describe('revoked employee', () => {
    it('denies a live token right after deactivation through the API', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const token = await at(keysK1).issueToken(id);
      const off = await request(createApp([employeeQrRoutes(eqr)])).post(
        `/api/employees/${id}/deactivate`,
      );
      expect(off.status).toBe(200);
      expect(await at(keysK1).validate(token)).toMatchObject({ ok: false, reason: 'INACTIVE' });
    });

    it('keeps the jti on a revoked deny, so the attempt can be recorded', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const token = await at(keysK1).issueToken(id);
      store.rows.get(id)!.qrRevoked = true;
      const { jti } = claimsOf(token) as { jti: string };
      expect(await at(keysK1).validate(token)).toEqual({ ok: false, reason: 'REVOKED', jti });
    });

    it('never gives a token to a revoked employee', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      store.rows.get(id)!.qrRevoked = true;
      await expect(at(keysK1).issueToken(id)).rejects.toMatchObject({ reason: 'REVOKED' });
    });
  });

  describe('fails closed', () => {
    it('rejects, never admits, when the employee lookup fails', async () => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      const token = await at(keysK1).issueToken(id);
      store.find = async () => {
        throw new Error('db down');
      };
      await expect(at(keysK1).validate(token)).rejects.toThrow('db down');
      await expect(at(keysK1).issueToken(id)).rejects.toThrow('db down');
    });

    it.each([
      ['missing', { ...keysK1, privateKey: '' }],
      ['garbage', { ...keysK1, privateKey: 'bm90LWEta2V5' }],
    ])('reports %s keys as QrNotConfiguredError', async (_name, keys) => {
      const { id } = await eqr.createEmployee('hr-1', lan);
      await expect(at(keys).validate('x.y.z')).rejects.toBeInstanceOf(QrNotConfiguredError);
      await expect(at(keys).issueToken(id)).rejects.toBeInstanceOf(QrNotConfiguredError);
    });

    it('POST /api/qr/token is a 500, not a 403, when storage fails', async () => {
      const withUser = Router().use((_req, res, next) => {
        res.locals.user = { id: 'e-1', role: 'EMP' };
        next();
      });
      store.find = async () => {
        throw new Error('db down');
      };
      const app = createApp([withUser, employeeQrRoutes(at(keysK1))]);
      expect((await request(app).post('/api/qr/token')).status).toBe(500);
    });
  });

  it('puts only sub, exp and jti in the token: no personal data (NFR-4)', async () => {
    const { id } = await eqr.createEmployee('hr-1', lan);
    const token = await at(keysK1).issueToken(id);
    expect(Object.keys(claimsOf(token) as object).sort()).toEqual(['exp', 'jti', 'sub']);
    expect(Buffer.from(token.split('.')[1], 'base64url').toString()).not.toContain('Lan');
  });
});
