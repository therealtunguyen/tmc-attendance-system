import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Role, UserRef } from '../iam/index.js';
import {
  entrance,
  InMemoryGates,
  otherFactory,
  RecordingGateAudit,
  registryService,
} from './gate.fakes.js';
import { gateRoutes } from './gate.routes.js';
import {
  DuplicateTurnstileError,
  InactiveGateError,
  InvalidGateEdgeError,
  type GateService,
} from './gate.service.js';

let store: InMemoryGates;
let audit: RecordingGateAudit;
let gate: GateService;

beforeEach(() => {
  store = new InMemoryGates();
  audit = new RecordingGateAudit();
  gate = registryService(store, audit);
});

describe('GateService registry (FR-2.1)', () => {
  it('creates an active gate and records the actor and configuration snapshot', async () => {
    const created = await gate.createGate('adm-1', entrance);
    expect(created).toMatchObject({ ...entrance, active: true, id: expect.any(String) });
    expect(audit.entries).toEqual([
      {
        actorId: 'adm-1',
        action: 'GATE_CREATE',
        target: `gate:${created.id}`,
        at: expect.any(Date),
        before: null,
        after: { ...entrance, id: created.id, active: true },
      },
    ]);
  });

  it.each(['missing', 'edge-la'])(
    'refuses invalid edge %s before writing or auditing',
    async (edgeId) => {
      await expect(gate.createGate('adm', { ...entrance, edgeId })).rejects.toBeInstanceOf(
        InvalidGateEdgeError,
      );
      expect(store.rows.size).toBe(0);
      expect(audit.entries).toHaveLength(0);
    },
  );

  it('updates only the requested configuration and audits before/after', async () => {
    const created = await gate.createGate('adm', entrance);
    const changes = { name: 'New name', location: 'Side gate', direction: 'OUT' as const };
    expect(await gate.updateGate('adm-2', created.id, changes)).toMatchObject({
      ...entrance,
      ...changes,
      id: created.id,
    });
    expect(audit.entries[1]).toMatchObject({
      actorId: 'adm-2',
      action: 'GATE_UPDATE',
      target: `gate:${created.id}`,
      before: { name: entrance.name, location: entrance.location, direction: 'IN' },
      after: changes,
    });
  });

  it('a cross-factory edge reassignment leaves the original gate unchanged', async () => {
    const created = await gate.createGate('adm', entrance);
    await expect(gate.updateGate('adm', created.id, { edgeId: 'edge-la' })).rejects.toBeInstanceOf(
      InvalidGateEdgeError,
    );
    expect(await gate.getGate(created.id)).toEqual(created);
    expect(audit.entries).toHaveLength(1);
  });

  it('duplicate device IDs remain reserved after deactivation', async () => {
    const created = await gate.createGate('adm', entrance);
    await gate.deactivateGate('adm', created.id);
    await expect(
      gate.createGate('adm', { ...otherFactory, turnstileId: entrance.turnstileId }),
    ).rejects.toBeInstanceOf(DuplicateTurnstileError);
    expect(store.rows.size).toBe(1);
    expect(audit.entries).toHaveLength(2);
  });

  it('reactivates the same gate/device and audits the active transition once', async () => {
    const created = await gate.createGate('adm', entrance);
    await gate.deactivateGate('adm', created.id);
    await expect(
      gate.updateGate('adm', created.id, { name: 'Hidden edit' }),
    ).rejects.toBeInstanceOf(InactiveGateError);
    expect(await gate.updateGate('adm-2', created.id, { active: true })).toMatchObject({
      ...entrance,
      id: created.id,
      active: true,
    });
    expect(audit.entries[2]).toMatchObject({
      actorId: 'adm-2',
      action: 'GATE_UPDATE',
      before: { active: false },
      after: { active: true },
    });
    await gate.updateGate('adm-2', created.id, { active: true });
    expect(audit.entries).toHaveLength(3);
    expect(store.rows.size).toBe(1);
  });

  it('unchanged updates are no-ops and missing gates produce no audit entries', async () => {
    const created = await gate.createGate('adm', entrance);
    expect(await gate.updateGate('adm', created.id, { name: entrance.name })).toEqual(created);
    expect(await gate.updateGate('adm', 'unknown', { name: 'X' })).toBeNull();
    expect(await gate.deactivateGate('adm', 'unknown')).toBeNull();
    expect(audit.entries).toHaveLength(1);
  });

  it('concurrent and repeated deactivations retain the gate and audit the transition once', async () => {
    const { id } = await gate.createGate('adm', entrance);
    const results = await Promise.all([
      gate.deactivateGate('adm-1', id),
      gate.deactivateGate('adm-2', id),
    ]);
    expect(results.every((row) => row?.active === false)).toBe(true);
    expect(await gate.deactivateGate('adm-3', id)).toMatchObject({ id, active: false });
    expect(store.rows.size).toBe(1);
    expect(audit.entries.filter((entry) => entry.action === 'GATE_DEACTIVATE')).toHaveLength(1);
  });

  it('storage and audit failures propagate instead of reporting success', async () => {
    const down = new Error('database unavailable');
    vi.spyOn(store, 'create').mockRejectedValueOnce(down);
    await expect(gate.createGate('adm', entrance)).rejects.toBe(down);
    expect(audit.entries).toHaveLength(0);
    const auditDown = new Error('audit unavailable');
    vi.spyOn(audit, 'append').mockRejectedValueOnce(auditDown);
    await expect(gate.createGate('adm', entrance)).rejects.toBe(auditDown);
  });
});

const admin: UserRef = { id: 'adm-1', role: 'ADM' };
const scopedAdmin = (scopes: string[]): UserRef => ({ ...admin, scopes });
const app = (user: UserRef = admin) =>
  createApp([
    Router().use((_req, res, next) => {
      if (user) res.locals.user = user;
      next();
    }),
    gateRoutes(gate),
  ]);

describe('Gate CRUD routes', () => {
  it('restores a deactivated gate through PATCH active:true and keeps normal editing available', async () => {
    const { id } = await gate.createGate('adm', entrance);
    await request(app()).delete(`/api/gates/${id}`);
    expect(
      (await request(app()).patch(`/api/gates/${id}`).send({ name: 'Inactive edit' })).status,
    ).toBe(409);
    for (const active of [false, 'true', 1, null]) {
      expect((await request(app()).patch(`/api/gates/${id}`).send({ active })).status).toBe(400);
    }
    const restored = await request(app()).patch(`/api/gates/${id}`).send({ active: true });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ id, active: true, turnstileId: entrance.turnstileId });
    expect(
      (await request(app()).patch(`/api/gates/${id}`).send({ name: 'Restored gate' })).status,
    ).toBe(200);
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      'GATE_CREATE',
      'GATE_DEACTIVATE',
      'GATE_UPDATE',
      'GATE_UPDATE',
    ]);
  });

  it('reactivation keeps the same permission and factory-scope restrictions as any PATCH', async () => {
    const { id } = await gate.createGate('adm', entrance);
    await gate.deactivateGate('adm', id);
    expect(
      (
        await request(app({ id: 'guard', role: 'GRD' }))
          .patch(`/api/gates/${id}`)
          .send({ active: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app({ id: 'adm-la', role: 'ADM', scopes: ['long-an'] }))
          .patch(`/api/gates/${id}`)
          .send({ active: true })
      ).status,
    ).toBe(404);
    expect(await gate.getGate(id)).toMatchObject({ active: false });
    expect(audit.entries).toHaveLength(2);
  });
  it('supports create -> list/detail -> edit -> deactivate while retaining the registry row', async () => {
    const created = await request(app()).post('/api/gates').send(entrance);
    expect(created.status).toBe(201);
    const { id } = created.body;
    expect(created.headers.location).toBe(`/api/gates/${id}`);
    expect(created.body).toMatchObject({
      ...entrance,
      active: true,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect((await request(app()).get(`/api/gates/${id}`)).body).toEqual(created.body);
    expect((await request(app()).get('/api/gates')).body).toEqual([created.body]);
    const updated = await request(app())
      .patch(`/api/gates/${id}`)
      .send({ name: 'Exit', direction: 'OUT' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id,
      name: 'Exit',
      direction: 'OUT',
      factoryId: entrance.factoryId,
    });
    expect((await request(app()).delete(`/api/gates/${id}`)).status).toBe(204);
    expect((await request(app()).delete(`/api/gates/${id}`)).status).toBe(204);
    const retained = await request(app()).get(`/api/gates/${id}`);
    expect(retained.status).toBe(200);
    expect(retained.body).toMatchObject({ id, active: false });
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      'GATE_CREATE',
      'GATE_UPDATE',
      'GATE_DEACTIVATE',
    ]);
  });

  it('trims strings before validation and storage', async () => {
    const padded = Object.fromEntries(
      Object.entries(entrance).map(([key, value]) => [key, `  ${value}  `]),
    );
    const response = await request(app()).post('/api/gates').send(padded);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject(entrance);
  });

  it.each(Object.keys(entrance))('requires %s on create', async (field) => {
    const response = await request(app())
      .post('/api/gates')
      .send({ ...entrance, [field]: undefined });
    expect(response.status).toBe(400);
    expect(store.rows.size).toBe(0);
    expect(audit.entries).toHaveLength(0);
  });

  it.each([null, 7, false, '', ' \t\n ', [], {}])(
    'rejects invalid text values %j',
    async (value) => {
      const response = await request(app())
        .post('/api/gates')
        .send({ ...entrance, location: value });
      expect(response.status).toBe(400);
      expect(store.rows.size).toBe(0);
    },
  );

  it.each(['BOTH', 'in', 'ENTRY'])('rejects direction %s', async (direction) => {
    expect(
      (
        await request(app())
          .post('/api/gates')
          .send({ ...entrance, direction })
      ).status,
    ).toBe(400);
  });

  it.each(['id', 'active', 'createdAt', 'updatedAt', 'actorId', 'unexpected'])(
    'rejects managed/unknown field %s',
    async (field) => {
      expect(
        (
          await request(app())
            .post('/api/gates')
            .send({ ...entrance, [field]: 'injected' })
        ).status,
      ).toBe(400);
      const { id } = await gate.createGate('adm', entrance);
      expect(
        (
          await request(app())
            .patch(`/api/gates/${id}`)
            .send({ [field]: 'injected' })
        ).status,
      ).toBe(400);
    },
  );

  it('rejects arrays, empty PATCH, immutable factory and invalid edited values', async () => {
    expect((await request(app()).post('/api/gates').send([])).status).toBe(400);
    const { id } = await gate.createGate('adm', entrance);
    for (const body of [
      [],
      {},
      { factoryId: 'long-an' },
      { location: null },
      { direction: 'BOTH' },
    ]) {
      expect((await request(app()).patch(`/api/gates/${id}`).send(body)).status).toBe(400);
    }
    expect(await gate.getGate(id)).toMatchObject(entrance);
    expect(audit.entries).toHaveLength(1);
  });

  it('returns 400 for unknown/cross-factory edges and 409 for duplicate devices on create/update', async () => {
    for (const edgeId of ['unknown', 'edge-la']) {
      expect(
        (
          await request(app())
            .post('/api/gates')
            .send({ ...entrance, edgeId })
        ).status,
      ).toBe(400);
    }
    const first = await gate.createGate('adm', entrance);
    const second = await gate.createGate('adm', otherFactory);
    expect((await request(app()).post('/api/gates').send(entrance)).status).toBe(409);
    expect(
      (
        await request(app())
          .patch(`/api/gates/${second.id}`)
          .send({ turnstileId: first.turnstileId })
      ).status,
    ).toBe(409);
    expect(
      (await request(app()).patch(`/api/gates/${first.id}`).send({ edgeId: 'edge-la' })).status,
    ).toBe(400);
    expect(await gate.getGate(second.id)).toMatchObject(otherFactory);
    expect(audit.entries).toHaveLength(2);
  });

  it('lists all states by default and intersects factory, edge and active filters', async () => {
    const first = await gate.createGate('adm', entrance);
    await gate.createGate('adm', otherFactory);
    await gate.deactivateGate('adm', first.id);
    expect((await request(app()).get('/api/gates')).body).toHaveLength(2);
    const filtered = await request(app())
      .get('/api/gates')
      .query({ factoryId: 'binh-duong', edgeId: 'edge-bd', active: 'false' });
    expect(filtered.status).toBe(200);
    expect(filtered.body).toMatchObject([{ id: first.id, active: false }]);
    expect((await request(app()).get('/api/gates?active=true')).body).toHaveLength(1);
    expect((await request(app()).get('/api/gates?factoryId=long-an&edgeId=edge-bd')).body).toEqual(
      [],
    );
  });

  it.each([
    'factoryId=',
    'edgeId=',
    'active=1',
    'active=',
    'active=true&active=false',
    'factoryId=a&factoryId=b',
    'factoryId[x]=a',
    'unexpected=x',
  ])('rejects malformed query %s', async (query) => {
    expect((await request(app()).get(`/api/gates?${query}`)).status).toBe(400);
  });

  it('returns 404 for unknown gate IDs on read, update and delete', async () => {
    expect((await request(app()).get('/api/gates/unknown')).status).toBe(404);
    expect((await request(app()).patch('/api/gates/unknown').send({ name: 'X' })).status).toBe(404);
    expect((await request(app()).delete('/api/gates/unknown')).status).toBe(404);
    expect(audit.entries).toHaveLength(0);
  });

  it('a database error is a server error and creates no audit entry', async () => {
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await request(app()).post('/api/gates').send(entrance)).status).toBe(500);
    expect(audit.entries).toHaveLength(0);
  });
});

describe('Gate registry permissions and factory scope', () => {
  it('requires a signed-in user on every registry endpoint', async () => {
    const noSession = createApp([gateRoutes(gate)]);
    expect((await request(noSession).get('/api/gates')).status).toBe(401);
    expect((await request(noSession).get('/api/gates/x')).status).toBe(401);
    expect((await request(noSession).post('/api/gates').send(entrance)).status).toBe(401);
    expect((await request(noSession).patch('/api/gates/x').send({ name: 'X' })).status).toBe(401);
    expect((await request(noSession).delete('/api/gates/x')).status).toBe(401);
  });

  it.each(['EMP', 'HR', 'SUP', 'EXE'] as Role[])('denies registry access to %s', async (role) => {
    const client = app({ id: 'user', role });
    expect((await request(client).get('/api/gates')).status).toBe(403);
    expect((await request(client).get('/api/gates/x')).status).toBe(403);
    expect((await request(client).post('/api/gates').send(entrance)).status).toBe(403);
    expect((await request(client).patch('/api/gates/x').send({ name: 'X' })).status).toBe(403);
    expect((await request(client).delete('/api/gates/x')).status).toBe(403);
  });

  it('guards can read within their factory but cannot mutate', async () => {
    const own = await gate.createGate('adm', entrance);
    const other = await gate.createGate('adm', otherFactory);
    const client = app({ id: 'guard', role: 'GRD', scopes: ['binh-duong'] });
    expect((await request(client).get('/api/gates')).body).toMatchObject([{ id: own.id }]);
    expect((await request(client).get(`/api/gates/${own.id}`)).status).toBe(200);
    expect((await request(client).get(`/api/gates/${other.id}`)).status).toBe(404);
    expect((await request(client).post('/api/gates').send(entrance)).status).toBe(403);
    expect((await request(client).patch(`/api/gates/${own.id}`).send({ name: 'X' })).status).toBe(
      403,
    );
    expect((await request(client).delete(`/api/gates/${own.id}`)).status).toBe(403);
  });

  it('scoped ADM cannot create, read, edit or deactivate gates outside their factories', async () => {
    const own = await gate.createGate('adm', entrance);
    const other = await gate.createGate('adm', otherFactory);
    const client = app(scopedAdmin(['binh-duong']));
    expect((await request(client).get('/api/gates')).body).toMatchObject([{ id: own.id }]);
    expect((await request(client).get('/api/gates?factoryId=long-an')).status).toBe(403);
    expect((await request(client).get('/api/gates?edgeId=edge-la')).body).toEqual([]);
    const hidden = await request(client).get(`/api/gates/${other.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual((await request(client).get('/api/gates/missing')).body);
    expect(
      (
        await request(client)
          .post('/api/gates')
          .send({ ...otherFactory, turnstileId: 'new-device' })
      ).status,
    ).toBe(403);
    expect((await request(client).patch(`/api/gates/${other.id}`).send({ name: 'X' })).status).toBe(
      404,
    );
    expect((await request(client).delete(`/api/gates/${other.id}`)).status).toBe(404);
    expect(await gate.getGate(other.id)).toMatchObject({ ...otherFactory, active: true });
    expect(audit.entries).toHaveLength(2);
  });

  it('multi-factory and empty scopes remain distinct from unrestricted ADM', async () => {
    await gate.createGate('adm', entrance);
    await gate.createGate('adm', otherFactory);
    expect(
      (await request(app(scopedAdmin(['binh-duong', 'long-an']))).get('/api/gates')).body,
    ).toHaveLength(2);
    expect((await request(app(scopedAdmin([]))).get('/api/gates')).body).toEqual([]);
    expect(
      (
        await request(app(scopedAdmin([])))
          .post('/api/gates')
          .send(entrance)
      ).status,
    ).toBe(403);
    expect((await request(app()).get('/api/gates')).body).toHaveLength(2);
  });
});
