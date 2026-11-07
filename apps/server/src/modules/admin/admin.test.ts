import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { AuditEntry, AuditLog, Role, UserRef } from '../iam/index.js';
import { InMemoryAdminStore } from './admin.fakes.js';
import { adminRoutes } from './admin.routes.js';
import {
  AdminService,
  DuplicateOrgUnitError,
  InvalidConfigError,
  InvalidOrgUnitError,
  OrgUnitNotFoundError,
  UnknownConfigKeyError,
} from './admin.service.js';

class RecordingAudit implements AuditLog {
  entries: AuditEntry[] = [];

  async append(entry: AuditEntry) {
    this.entries.push(entry);
  }

  async search() {
    return this.entries;
  }
}

let store: InMemoryAdminStore;
let audit: RecordingAudit;
let admin: AdminService;

beforeEach(() => {
  store = new InMemoryAdminStore();
  audit = new RecordingAudit();
  admin = new AdminService(store, audit);
});

const seed = async () => {
  await admin.createOrgUnit('adm', {
    id: 'bd',
    kind: 'FACTORY',
    name: 'Binh Duong',
    parentId: null,
  });
  await admin.createOrgUnit('adm', {
    id: 'bd-sew',
    kind: 'DEPARTMENT',
    name: 'Sewing',
    parentId: 'bd',
  });
  await admin.createOrgUnit('adm', {
    id: 'bd-line-1',
    kind: 'TEAM',
    name: 'Line 1',
    parentId: 'bd-sew',
  });
  await admin.createOrgUnit('adm', { id: 'la', kind: 'FACTORY', name: 'Long An', parentId: null });
  await admin.createOrgUnit('adm', {
    id: 'la-cut',
    kind: 'DEPARTMENT',
    name: 'Cutting',
    parentId: 'la',
  });
  await admin.createOrgUnit('adm', {
    id: 'la-line-1',
    kind: 'TEAM',
    name: 'Line 1',
    parentId: 'la-cut',
  });
  audit.entries = [];
};

describe('AdminService: org units', () => {
  it('creates a unit and audits it with the after value (FR-4.9)', async () => {
    const unit = await admin.createOrgUnit('adm-1', {
      id: 'bd',
      kind: 'FACTORY',
      name: ' Binh Duong ',
      parentId: null,
    });
    expect(unit).toEqual({
      id: 'bd',
      kind: 'FACTORY',
      name: 'Binh Duong',
      parentId: null,
      supervisorIds: [],
    });
    expect(audit.entries).toEqual([
      {
        actorId: 'adm-1',
        action: 'ORG_UNIT_CREATE',
        target: 'org:bd',
        at: expect.any(Date),
        before: undefined,
        after: unit,
      },
    ]);
  });

  it('rejects a bad slug, kind, name, parent and duplicate without auditing', async () => {
    await seed();
    const make = (o: object) =>
      admin.createOrgUnit('adm', { id: 'x1', kind: 'FACTORY', name: 'X', parentId: null, ...o });
    await expect(make({ id: 'Bad Id' })).rejects.toBeInstanceOf(InvalidOrgUnitError);
    await expect(make({ id: 'a' })).rejects.toBeInstanceOf(InvalidOrgUnitError);
    await expect(make({ kind: 'PLANT' })).rejects.toBeInstanceOf(InvalidOrgUnitError);
    await expect(make({ name: '  ' })).rejects.toBeInstanceOf(InvalidOrgUnitError);
    await expect(make({ parentId: 'bd' })).rejects.toBeInstanceOf(InvalidOrgUnitError);
    await expect(make({ id: 'bd' })).rejects.toBeInstanceOf(DuplicateOrgUnitError);
    expect(audit.entries).toEqual([]);
  });

  it('renames with before and after, and 404s on an unknown ID', async () => {
    await seed();
    await admin.renameOrgUnit('hr-1', 'bd', 'Binh Duong 2');
    expect(audit.entries[0]).toMatchObject({
      action: 'ORG_UNIT_RENAME',
      target: 'org:bd',
      before: { name: 'Binh Duong' },
      after: { name: 'Binh Duong 2' },
    });
    await expect(admin.renameOrgUnit('hr-1', 'nope', 'X')).rejects.toBeInstanceOf(
      OrgUnitNotFoundError,
    );
    await expect(admin.renameOrgUnit('hr-1', 'bd', ' ')).rejects.toBeInstanceOf(
      InvalidOrgUnitError,
    );
  });

  it('sets supervisors on a TEAM only, deduplicated, with before and after', async () => {
    await seed();
    await admin.setSupervisors('hr-1', 'bd-line-1', ['u1', 'u2', 'u1']);
    await admin.setSupervisors('hr-1', 'bd-line-1', ['u2']);
    expect(audit.entries.map((e) => [e.action, e.before, e.after])).toEqual([
      ['TEAM_SUPERVISORS_SET', { supervisorIds: [] }, { supervisorIds: ['u1', 'u2'] }],
      ['TEAM_SUPERVISORS_SET', { supervisorIds: ['u1', 'u2'] }, { supervisorIds: ['u2'] }],
    ]);
    await expect(admin.setSupervisors('hr-1', 'bd', ['u1'])).rejects.toBeInstanceOf(
      InvalidOrgUnitError,
    );
    await expect(admin.setSupervisors('hr-1', 'nope', ['u1'])).rejects.toBeInstanceOf(
      OrgUnitNotFoundError,
    );
  });

  it('caches the tree and invalidates it on writes', async () => {
    await seed();
    store.listCalls = 0;
    await admin.orgUnits();
    await admin.orgUnits();
    expect(store.listCalls).toBe(1);
    await admin.renameOrgUnit('hr', 'bd', 'Renamed');
    expect((await admin.orgUnits()).find((u) => u.id === 'bd')?.name).toBe('Renamed');
    expect(store.listCalls).toBe(2);
    await admin.setSupervisors('hr', 'bd-line-1', ['u1']);
    expect((await admin.expandScopes({ id: 'u1', role: 'SUP' })).scopes).toEqual(['bd-line-1']);
  });

  it('does not let callers mutate the cache', async () => {
    await seed();
    (await admin.orgUnits())[0]!.name = 'hacked';
    expect((await admin.orgUnits())[0]!.name).not.toBe('hacked');
  });
});

describe('AdminService: config', () => {
  it('returns defaults, then the stored value, typed and as a string', async () => {
    expect(await admin.get('qr.ttlSeconds')).toBe('60');
    expect(await admin.config('qr.ttlSeconds')).toBe(60);
    expect(await admin.get('nope')).toBeUndefined();
    await admin.setConfig('adm-1', 'qr.ttlSeconds', ' 90 ');
    expect(await admin.get('qr.ttlSeconds')).toBe('90');
    expect(await admin.config('qr.ttlSeconds')).toBe(90);
    expect(store.config.get('qr.ttlSeconds')).toEqual({ value: '90', updatedBy: 'adm-1' });
  });

  it('audits CONFIG_CHANGE with before (the default at first) and after', async () => {
    await admin.setConfig('adm-1', 'qr.ttlSeconds', '90');
    await admin.setConfig('adm-1', 'qr.ttlSeconds', '120');
    expect(audit.entries.map((e) => [e.action, e.target, e.before, e.after])).toEqual([
      ['CONFIG_CHANGE', 'config:qr.ttlSeconds', { value: '60' }, { value: '90' }],
      ['CONFIG_CHANGE', 'config:qr.ttlSeconds', { value: '90' }, { value: '120' }],
    ]);
  });

  it('rejects unknown keys and invalid values without auditing or storing', async () => {
    await expect(admin.setConfig('a', 'nope', '1')).rejects.toBeInstanceOf(UnknownConfigKeyError);
    await expect(admin.setConfig('a', 'qr.ttlSeconds', '5')).rejects.toBeInstanceOf(
      InvalidConfigError,
    );
    await expect(admin.setConfig('a', 'export.monthlyAt', '12:00')).rejects.toBeInstanceOf(
      InvalidConfigError,
    );
    expect(audit.entries).toEqual([]);
    expect(store.config.size).toBe(0);
  });

  it('allConfig lists every key with default and whether it is set', async () => {
    await admin.setConfig('a', 'qr.ttlSeconds', '90');
    const all = await admin.allConfig();
    expect(all).toHaveLength(8);
    expect(all.find((e) => e.key === 'qr.ttlSeconds')).toMatchObject({
      value: '90',
      default: '60',
      set: true,
    });
    expect(all.find((e) => e.key === 'export.monthlyAt')).toMatchObject({
      value: '06:00',
      set: false,
    });
  });
});

describe('AdminService.expandScopes (BR-15)', () => {
  beforeEach(async () => {
    await seed();
    await admin.setSupervisors('hr', 'bd-line-1', ['sup-1']);
  });

  it('gives a factory-scoped HR its departments and teams, not other factories', async () => {
    const user = await admin.expandScopes({ id: 'h', role: 'HR', scopes: ['bd'] });
    expect([...user.scopes!].sort()).toEqual(['bd', 'bd-line-1', 'bd-sew']);
  });

  it('gives a SUP the teams they supervise, plus any explicit scopes expanded', async () => {
    expect((await admin.expandScopes({ id: 'sup-1', role: 'SUP' })).scopes).toEqual(['bd-line-1']);
    const both = await admin.expandScopes({ id: 'sup-1', role: 'SUP', scopes: ['la'] });
    expect([...both.scopes!].sort()).toEqual(['bd-line-1', 'la', 'la-cut', 'la-line-1']);
    expect((await admin.expandScopes({ id: 'sup-9', role: 'SUP' })).scopes).toEqual([]);
  });

  it('leaves users without scopes unchanged', async () => {
    const hr: UserRef = { id: 'h', role: 'HR' };
    expect(await admin.expandScopes(hr)).toBe(hr);
    expect((await admin.expandScopes({ id: 'h', role: 'HR', scopes: [] })).scopes).toEqual([]);
  });
});

describe('admin routes', () => {
  const as = (role: Role, scopes?: string[], id = `${role}-1`) =>
    createApp([
      Router().use(async (_req, res, next) => {
        res.locals.user = await admin.expandScopes({ id, role, scopes });
        next();
      }),
      adminRoutes(admin),
    ]);
  const anon = () => createApp([adminRoutes(admin)]);
  const factory = { id: 'bd', kind: 'FACTORY', name: 'Binh Duong', parentId: null };

  it('401 without a session', async () => {
    expect((await request(anon()).get('/api/org-units')).status).toBe(401);
    expect((await request(anon()).get('/api/config')).status).toBe(401);
  });

  it('EXE gets 403 on org, HR gets 403 on config, SUP can read org but not manage it', async () => {
    expect((await request(as('EXE')).get('/api/org-units')).status).toBe(403);
    expect((await request(as('EXE')).post('/api/org-units').send(factory)).status).toBe(403);
    expect((await request(as('HR')).get('/api/config')).status).toBe(403);
    expect(
      (await request(as('HR')).put('/api/config/qr.ttlSeconds').send({ value: '90' })).status,
    ).toBe(403);
    expect((await request(as('SUP')).get('/api/org-units')).status).toBe(200);
    expect((await request(as('SUP')).post('/api/org-units').send(factory)).status).toBe(403);
    expect((await request(as('SUP')).get('/api/config')).status).toBe(403);
  });

  it('ADM and HR create a tree; GET lists it', async () => {
    expect((await request(as('ADM')).post('/api/org-units').send(factory)).status).toBe(201);
    const dept = await request(as('HR'))
      .post('/api/org-units')
      .send({ id: 'bd-sew', kind: 'DEPARTMENT', name: 'Sewing', parentId: 'bd' });
    expect(dept.status).toBe(201);
    const list = await request(as('ADM')).get('/api/org-units');
    expect(list.body.map((u: { id: string }) => u.id)).toEqual(['bd', 'bd-sew']);
  });

  it('400 for bad bodies and hierarchy, 404 unknown unit, 409 duplicate', async () => {
    await seed();
    const post = (body: unknown) =>
      request(as('ADM'))
        .post('/api/org-units')
        .send(body as object);
    expect((await post({ id: 'x1' })).status).toBe(400);
    expect((await post({ ...factory, id: 'Bad Slug' })).status).toBe(400);
    expect((await post({ ...factory, kind: 'PLANT', id: 'x1' })).status).toBe(400);
    expect((await post({ id: 'x1', kind: 'TEAM', name: 'T', parentId: 'bd' })).status).toBe(400);
    expect((await post({ ...factory, parentId: 7 })).status).toBe(400);
    expect((await request(as('ADM')).post('/api/org-units').send([1])).status).toBe(400);
    expect((await post(factory)).status).toBe(409);
    expect((await request(as('ADM')).patch('/api/org-units/bd').send({})).status).toBe(400);
    expect((await request(as('ADM')).patch('/api/org-units/nope').send({ name: 'X' })).status).toBe(
      404,
    );
    const sup = (id: string, body: unknown) =>
      request(as('ADM'))
        .put(`/api/org-units/${id}/supervisors`)
        .send(body as object);
    expect((await sup('bd-line-1', { userIds: 'u1' })).status).toBe(400);
    expect((await sup('bd', { userIds: ['u1'] })).status).toBe(400);
    expect((await sup('nope', { userIds: ['u1'] })).status).toBe(404);
  });

  it('PATCH renames and PUT supervisors sets them', async () => {
    await seed();
    const renamed = await request(as('HR')).patch('/api/org-units/bd').send({ name: 'BD' });
    expect(renamed.body).toMatchObject({ id: 'bd', name: 'BD' });
    const sup = await request(as('HR'))
      .put('/api/org-units/bd-line-1/supervisors')
      .send({ userIds: ['u1'] });
    expect(sup.body).toMatchObject({ supervisorIds: ['u1'] });
  });

  it('a factory-scoped HR manages units inside its factory but not outside (403)', async () => {
    await seed();
    const hr = () => as('HR', ['bd'], 'hr-bd');
    const team = { id: 'bd-line-2', kind: 'TEAM', name: 'Line 2', parentId: 'bd-sew' };
    expect((await request(hr()).post('/api/org-units').send(team)).status).toBe(201);
    expect(
      (await request(hr()).patch('/api/org-units/bd-line-2').send({ name: 'L2' })).status,
    ).toBe(200);
    expect(
      (await request(hr()).put('/api/org-units/bd-line-2/supervisors').send({ userIds: [] }))
        .status,
    ).toBe(200);
    const other = { ...team, id: 'la-line-2', parentId: 'la-cut' };
    expect((await request(hr()).post('/api/org-units').send(other)).status).toBe(403);
    expect(
      (
        await request(hr())
          .post('/api/org-units')
          .send({ ...factory, id: 'new-f' })
      ).status,
    ).toBe(403);
    expect((await request(hr()).patch('/api/org-units/la').send({ name: 'X' })).status).toBe(403);
    const list = await request(hr()).get('/api/org-units');
    expect(list.body.map((u: { id: string }) => u.id).sort()).toEqual([
      'bd',
      'bd-line-1',
      'bd-line-2',
      'bd-sew',
    ]);
  });

  it('a SUP sees only the teams they supervise', async () => {
    await seed();
    await admin.setSupervisors('hr', 'bd-line-1', ['sup-1']);
    const list = await request(as('SUP', undefined, 'sup-1')).get('/api/org-units');
    expect(list.body.map((u: { id: string }) => u.id)).toEqual(['bd-line-1']);
  });

  it('GET /config lists every key; PUT validates (400), rejects unknown keys (404), and audits', async () => {
    const list = await request(as('ADM')).get('/api/config');
    expect(list.body).toHaveLength(8);
    expect(list.body[0]).toMatchObject({
      key: 'qr.ttlSeconds',
      value: '60',
      default: '60',
      set: false,
    });
    expect(list.body[0].description).toEqual(expect.any(String));
    const put = (key: string, body: unknown) =>
      request(as('ADM'))
        .put(`/api/config/${key}`)
        .send(body as object);
    expect((await put('qr.ttlSeconds', { value: '90' })).body).toMatchObject({
      value: '90',
      set: true,
    });
    expect((await put('qr.ttlSeconds', { value: '5' })).status).toBe(400);
    expect((await put('qr.ttlSeconds', { value: 90 })).status).toBe(400);
    expect((await put('export.monthlyAt', { value: '12:00' })).status).toBe(400);
    expect((await put('nope', { value: '1' })).status).toBe(404);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ actorId: 'ADM-1', action: 'CONFIG_CHANGE' });
  });
});
