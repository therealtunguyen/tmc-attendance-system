import { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { entrance, InMemoryGates, RecordingGateAudit, registryService } from './gate.fakes.js';
import { connectionStatus, startGateMonitor, UnknownEdgeError } from './gate.heartbeat.js';
import { gateRoutes } from './gate.routes.js';

const BASE = Date.UTC(2026, 10, 7, 1);
const hb = { edgeId: 'edge-bd', sentAt: '2099-01-01T00:00:00Z', snapshotAt: null, outboxSize: 0 };
let now: number;
let store: InMemoryGates;
const notify = vi.fn(async (_kind: string, _message: string) => {});
const service = () =>
  registryService(store, new RecordingGateAudit(), { now: () => new Date(now) }, { alert: notify });
beforeEach(() => {
  now = BASE;
  store = new InMemoryGates();
  notify.mockReset();
  notify.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('Gate heartbeat (FR-2.6)', () => {
  it.each([
    [null, 'OFFLINE'],
    [0, 'ONLINE'],
    [90_000, 'ONLINE'],
    [90_001, 'OFFLINE'],
  ] as const)('heartbeat age %s -> %s', (age, expected) => {
    expect(
      connectionStatus(age === null ? null : new Date(BASE - age), new Date(BASE), 90_000),
    ).toBe(expected);
  });

  it('uses server receipt time and exposes the derived state for all gates on an edge', async () => {
    const gate = service();
    const first = await gate.createGate('adm', entrance);
    await gate.createGate('adm', { ...entrance, name: 'Exit', turnstileId: 'second-device' });
    expect(await gate.getGate(first.id)).toMatchObject({
      status: 'OFFLINE',
      lastHeartbeatAt: null,
    });
    await gate.edgeHeartbeat(hb);
    expect((await gate.listGates()).every((item) => item.status === 'ONLINE')).toBe(true);
    expect(store.edges.get(hb.edgeId)!.lastHeartbeatAt).toEqual(new Date(BASE));
    now += 90_001;
    expect(await gate.getGate(first.id)).toMatchObject({ status: 'OFFLINE' });
  });

  it('alerts once for active gates and alerts again after recovery and another outage', async () => {
    const gate = service();
    await gate.createGate('adm', entrance);
    const disabled = await gate.createGate('adm', {
      ...entrance,
      name: 'Disabled',
      turnstileId: 'disabled-device',
    });
    await gate.deactivateGate('adm', disabled.id);
    await gate.edgeHeartbeat(hb);
    now += 90_001;
    await gate.checkOffline();
    await gate.checkOffline();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('GATE_OFFLINE');
    expect(notify.mock.calls[0]![1]).toContain('Main entrance');
    expect(notify.mock.calls[0]![1]).not.toContain('Disabled');
    await gate.edgeHeartbeat(hb);
    now += 90_001;
    await gate.checkOffline();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not alert never-connected edges or edges with only inactive gates', async () => {
    const gate = service();
    const created = await gate.createGate('adm', entrance);
    now += 1_000_000;
    await gate.checkOffline();
    await gate.edgeHeartbeat(hb);
    await gate.deactivateGate('adm', created.id);
    now += 90_001;
    await gate.checkOffline();
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps heartbeat state and monitoring when a gate is reactivated after DELETE', async () => {
    const gate = service();
    const { id } = await gate.createGate('adm', entrance);
    await gate.deactivateGate('adm', id);
    await gate.edgeHeartbeat(hb);
    now += 90_001;
    expect(await gate.updateGate('adm', id, { active: true })).toMatchObject({ active: true });
    expect(await gate.getGate(id)).toMatchObject({ status: 'OFFLINE' });
    await gate.checkOffline();
    expect(notify).toHaveBeenCalledTimes(1);
    await gate.edgeHeartbeat(hb);
    expect(await gate.getGate(id)).toMatchObject({ status: 'ONLINE' });
  });

  it('moves lastSyncAt only when the edge reports an empty outbox (FR-4.5)', async () => {
    const gate = service();
    await gate.edgeHeartbeat({ ...hb, outboxSize: 3 });
    expect(store.edges.get('edge-bd')).toMatchObject({
      lastHeartbeatAt: new Date(BASE),
      lastSyncAt: null,
    });
    now += 1_000;
    await gate.edgeHeartbeat(hb);
    expect(store.edges.get('edge-bd')!.lastSyncAt).toEqual(new Date(BASE + 1_000));
    now += 1_000;
    await gate.edgeHeartbeat({ ...hb, outboxSize: 3 });
    expect(store.edges.get('edge-bd')).toMatchObject({
      lastHeartbeatAt: new Date(BASE + 2_000),
      lastSyncAt: new Date(BASE + 1_000),
    });
  });

  it('dates the sync by the heartbeat send time, not receipt (FR-4.5)', async () => {
    now = Date.parse('2026-10-31T17:00:05Z');
    await service().edgeHeartbeat({ ...hb, sentAt: '2026-10-31T16:59:50Z' });
    expect(store.edges.get('edge-bd')).toMatchObject({
      lastHeartbeatAt: new Date('2026-10-31T17:00:05Z'),
      lastSyncAt: new Date('2026-10-31T16:59:50Z'),
    });
  });

  it('clamps a send time ahead of the server clock to the server time', async () => {
    await service().edgeHeartbeat({ ...hb, sentAt: new Date(BASE + 600_000).toISOString() });
    expect(store.edges.get('edge-bd')!.lastSyncAt).toEqual(new Date(BASE));
  });

  it('does not move lastSyncAt back on a later heartbeat with an older send time', async () => {
    const gate = service();
    await gate.edgeHeartbeat({ ...hb, sentAt: new Date(BASE).toISOString() });
    now += 5_000;
    await gate.edgeHeartbeat({ ...hb, sentAt: new Date(BASE - 60_000).toISOString() });
    expect(store.edges.get('edge-bd')).toMatchObject({
      lastHeartbeatAt: new Date(BASE + 5_000),
      lastSyncAt: new Date(BASE),
    });
  });

  it('lists the last sync of edges that serve an active gate only', async () => {
    const gate = service();
    await gate.createGate('adm', entrance);
    const closed = await gate.createGate('adm', {
      ...entrance,
      edgeId: 'edge-la',
      factoryId: 'long-an',
      turnstileId: 'la-device',
    });
    await gate.edgeHeartbeat(hb);
    await gate.edgeHeartbeat({ ...hb, edgeId: 'edge-la' });
    expect(await gate.edgeSyncs()).toEqual([
      { edgeId: 'edge-bd', factoryId: 'binh-duong', lastSyncAt: new Date(BASE) },
      { edgeId: 'edge-la', factoryId: 'long-an', lastSyncAt: new Date(BASE) },
    ]);
    await gate.deactivateGate('adm', closed.id);
    expect((await gate.edgeSyncs()).map((e) => e.edgeId)).toEqual(['edge-bd']);
  });

  it('lists an edge with an active gate even if it never synced', async () => {
    const gate = service();
    await gate.createGate('adm', entrance);
    expect(await gate.edgeSyncs()).toEqual([
      { edgeId: 'edge-bd', factoryId: 'binh-duong', lastSyncAt: null },
    ]);
  });

  it('lists no edge that has no gates', async () => {
    await service().edgeHeartbeat(hb);
    expect(await service().edgeSyncs()).toEqual([]);
  });

  it('rejects a heartbeat from an unknown edge', async () => {
    await expect(service().edgeHeartbeat({ ...hb, edgeId: 'nope' })).rejects.toBeInstanceOf(
      UnknownEdgeError,
    );
  });

  it('never moves lastHeartbeatAt or lastSyncAt back (fake mirrors the SQL)', async () => {
    await store.recordHeartbeat('edge-bd', new Date(BASE), new Date(BASE));
    await store.recordHeartbeat('edge-bd', new Date(BASE - 5_000), new Date(BASE - 5_000));
    expect(store.edges.get('edge-bd')).toMatchObject({
      lastHeartbeatAt: new Date(BASE),
      lastSyncAt: new Date(BASE),
    });
  });

  it('retries a failed notifier instead of marking the edge as alerted', async () => {
    const gate = service();
    await gate.createGate('adm', entrance);
    await gate.edgeHeartbeat(hb);
    now += 90_001;
    notify.mockRejectedValueOnce(new Error('notifier unavailable'));
    await expect(gate.checkOffline()).rejects.toThrow('Gate offline alert failed');
    await gate.checkOffline();
    await gate.checkOffline();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('validates heartbeat requests, uses edgeId from credential, and returns 404 for unknown edges', async () => {
    const edgeAs = (edgeId?: string) =>
      Router().use((_req, res, next) => {
        if (edgeId) res.locals.edgeId = edgeId;
        next();
      });
    const appFor = (edgeId?: string) => createApp([edgeAs(edgeId), gateRoutes(service())]);

    expect((await request(appFor(undefined)).post('/api/edge/heartbeat').send(hb)).status).toBe(
      401,
    );
    expect((await request(appFor('edge-bd')).post('/api/edge/heartbeat').send(hb)).status).toBe(
      204,
    );
    // Spoofed body.edgeId is ignored when authenticated as edge-bd.
    expect(
      (
        await request(appFor('edge-bd'))
          .post('/api/edge/heartbeat')
          .send({ ...hb, edgeId: 'missing' })
      ).status,
    ).toBe(204);
    expect((await request(appFor('missing')).post('/api/edge/heartbeat').send(hb)).status).toBe(
      404,
    );
    for (const body of [
      [],
      {},
      { ...hb, sentAt: 'invalid' },
      { ...hb, outboxSize: -1 },
      { ...hb, snapshotAt: undefined },
    ]) {
      expect((await request(appFor('edge-bd')).post('/api/edge/heartbeat').send(body)).status).toBe(
        400,
      );
    }
  });

  it('checks periodically without HTTP traffic and stops after cleanup', async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValue(undefined);
    const stop = startGateMonitor(check, 15_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(3);
    await stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(3);
  });
});
