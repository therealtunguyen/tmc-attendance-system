import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Scope } from '../../shared/types.js';
import type { AuditEntry, AuditLog } from '../iam/index.js';
import { employeeQrRoutes } from './employee-qr.routes.js';
import {
  DuplicateEmployeeCodeError,
  EmployeeQrService,
  type Employee,
  type EmployeeChanges,
  type EmployeeStore,
  type NewEmployee,
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
