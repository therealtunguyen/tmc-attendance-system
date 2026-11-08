import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../shared/prisma.js';
import { entrance } from './gate.fakes.js';
import { GateRepo } from './gate.repo.js';
import { DuplicateTurnstileError, InvalidGateEdgeError } from './gate.service.js';

const repoWith = (gate: Record<string, unknown>, edge: Record<string, unknown> = {}) =>
  new GateRepo({ gate, edge } as unknown as PrismaClient);

describe('GateRepo storage errors', () => {
  it.each([
    ['P2002', { target: ['turnstileId'] }, DuplicateTurnstileError],
    ['P2002', { target: 'Gate_turnstileId_key' }, DuplicateTurnstileError],
    [
      'P2002',
      { driverAdapterError: { cause: { constraint: { index: 'Gate_turnstileId_key' } } } },
      DuplicateTurnstileError,
    ],
    ['P2003', { target: ['edgeId', 'factoryId'] }, InvalidGateEdgeError],
    ['P2003', { field_name: 'Gate_edgeId_factoryId_fkey (index)' }, InvalidGateEdgeError],
    [
      'P2003',
      { driverAdapterError: { cause: { constraint: { index: 'Gate_edgeId_factoryId_fkey' } } } },
      InvalidGateEdgeError,
    ],
  ] as const)(
    'maps %s for its known constraint on both create and update',
    async (code, meta, expected) => {
      const failing = vi.fn().mockRejectedValue({ code, meta });
      const repo = repoWith({ create: failing, update: failing });
      await expect(repo.create(entrance)).rejects.toBeInstanceOf(expected);
      await expect(repo.update('gate', { edgeId: 'missing' })).rejects.toBeInstanceOf(expected);
    },
  );

  it.each([
    { code: 'P2002', meta: { target: ['id'] } },
    { code: 'P2002', meta: { target: ['turnstileId', 'factoryId'] } },
    { code: 'P2003', meta: { field_name: 'Gate_future_fkey' } },
    {
      code: 'P2003',
      meta: { driverAdapterError: { cause: { constraint: { index: 'Gate_future_fkey' } } } },
    },
    { code: 'P2002' },
    { code: 'P2003' },
  ])('preserves unrelated or unidentified constraint errors: %j', async (error) => {
    const failing = vi.fn().mockRejectedValue(error);
    const repo = repoWith({ create: failing, update: failing });
    await expect(repo.create(entrance)).rejects.toBe(error);
    await expect(repo.update('gate', { name: 'X' })).rejects.toBe(error);
  });

  it('returns null for a gate removed during an update', async () => {
    const repo = repoWith({ update: vi.fn().mockRejectedValue({ code: 'P2025' }) });
    expect(await repo.update('missing', { name: 'New name' })).toBeNull();
  });

  it('preserves unexpected database failures', async () => {
    const down = new Error('connection failed');
    const failing = vi.fn().mockRejectedValue(down);
    const repo = repoWith({ create: failing, update: failing, updateManyAndReturn: failing });
    await expect(repo.create(entrance)).rejects.toBe(down);
    await expect(repo.update('gate', { name: 'X' })).rejects.toBe(down);
    await expect(repo.deactivate('gate')).rejects.toBe(down);
  });
});

describe('GateRepo scope and deactivation guarantees', () => {
  it('intersects an explicit factory filter with allowed factories; an empty scope stays empty', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = repoWith({ findMany });
    await repo.list({ factoryId: 'long-an', edgeId: 'edge-la', active: false }, ['binh-duong']);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          factoryId: 'long-an',
          edgeId: 'edge-la',
          active: false,
          AND: [{ factoryId: { in: ['binh-duong'] } }],
        },
      }),
    );
    await repo.list({}, []);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { AND: [{ factoryId: { in: [] } }] } }),
    );
  });

  it('only returns a row when active -> inactive was actually applied', async () => {
    const row = { id: 'gate', active: false };
    const updateManyAndReturn = vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    const repo = repoWith({ updateManyAndReturn });
    expect(await repo.deactivate('gate')).toBe(row);
    expect(await repo.deactivate('gate')).toBeNull();
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'gate', active: true },
      data: { active: false },
    });
  });

  it('records the heartbeat and the sync in one parameterised UPDATE (FR-4.5)', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const repo = new GateRepo({ $executeRaw: executeRaw } as unknown as PrismaClient);
    const receivedAt = new Date('2026-11-07T01:00:00Z');
    expect(await repo.recordHeartbeat('edge-bd', receivedAt, true)).toBe(true);
    const [strings, ...values] = executeRaw.mock.calls[0]!;
    const sql = (strings as string[]).join('?');
    expect(sql).toContain('"lastSyncAt"');
    expect(sql).toContain('CASE WHEN');
    expect(values).toContain(true);
    expect(values).toContain(receivedAt);
    expect(values).toContain('edge-bd');
    executeRaw.mockResolvedValue(0);
    expect(await repo.recordHeartbeat('missing', receivedAt, false)).toBe(false);
    expect(executeRaw.mock.calls[1]!.slice(1)).toContain(false);
  });

  it('maps edges to EdgeSync ordered by id', async () => {
    const lastSyncAt = new Date('2026-11-07T01:00:00Z');
    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: 'edge-bd', factoryId: 'binh-duong', lastSyncAt }]);
    const repo = repoWith({}, { findMany });
    expect(await repo.edgeSyncs()).toEqual([
      { edgeId: 'edge-bd', factoryId: 'binh-duong', lastSyncAt },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      select: { id: true, factoryId: true, lastSyncAt: true },
      orderBy: { id: 'asc' },
    });
  });
});
