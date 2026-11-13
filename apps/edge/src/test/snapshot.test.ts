// Tests for snapshot pulling, persistence, and stale detection (#26).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_STALE_AFTER_MS } from '../../../server/src/shared/contracts/edge.js';
import type { Db } from '../db.js';
import type { ServerClient } from '../server-client.js';
import { SnapshotManager } from '../snapshot.js';
import { createTempDb, generatePair, makeSnapshot } from './helpers.js';

let db: Db;
let cleanup: () => void;
const { publicKey } = generatePair();
const employee = { id: 'emp-snap', firstName: 'Snap', deny: null as null };

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(() => {
  cleanup();
});

describe('SnapshotManager (#26)', () => {
  it('pulls snapshot, persists it to SQLite, and reloads across restart', async () => {
    const snapshot = makeSnapshot([employee], publicKey);
    const client = {
      getSnapshot: async () => ({ ok: true as const, data: snapshot }),
    } as unknown as ServerClient;

    const mgr1 = new SnapshotManager(db, client, 'edge-bd');
    expect(mgr1.isStale()).toBe(true);

    await mgr1.pull();
    expect(mgr1.isStale()).toBe(false);
    expect(mgr1.findEmployee(employee.id)).toEqual(employee);

    // Simulate restart with a fresh SnapshotManager reading from SQLite.
    const mgr2 = new SnapshotManager(db, client, 'edge-bd');
    mgr2.load();
    expect(mgr2.isStale()).toBe(false);
    expect(mgr2.findEmployee(employee.id)).toEqual(employee);
  });

  it('keeps the previous snapshot and becomes stale after SNAPSHOT_STALE_AFTER_MS if pulls fail', async () => {
    const snapshot = makeSnapshot([employee], publicKey);
    db.setKv('snapshot', JSON.stringify(snapshot));
    db.setKv('snapshot_at', String(Date.now() - SNAPSHOT_STALE_AFTER_MS - 1_000));

    const failingClient = {
      getSnapshot: async () => ({ ok: false as const, status: 503, error: 'down' }),
    } as unknown as ServerClient;

    const mgr = new SnapshotManager(db, failingClient, 'edge-bd');
    mgr.load();
    await mgr.pull();

    expect(mgr.get()?.snapshot).toEqual(snapshot);
    expect(mgr.isStale()).toBe(true);
  });

  it('load() restores the persisted snapshot before any pull', () => {
    const snapshot = makeSnapshot([employee], publicKey);
    db.setKv('snapshot', JSON.stringify(snapshot));
    db.setKv('snapshot_at', String(Date.now()));
    const mgr = new SnapshotManager(db, {} as unknown as ServerClient, 'edge-bd');
    expect(mgr.get()).toBeNull();
    mgr.load();
    expect(mgr.get()?.snapshot).toEqual(snapshot);
    expect(mgr.isStale()).toBe(false);
  });
});

describe('SnapshotManager.startLoop retry (#109)', () => {
  const snapshot = makeSnapshot([employee], publicKey);
  const fail = { ok: false as const, status: 0, error: 'down' };
  const okResult = { ok: true as const, data: snapshot };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const make = (impl: () => Promise<unknown>) => {
    const getSnapshot = vi.fn(impl);
    const mgr = new SnapshotManager(db, { getSnapshot } as unknown as ServerClient, 'edge-bd');
    return { mgr, getSnapshot };
  };

  it('retries with backoff 2/4/8 s when empty, then resumes the normal interval', async () => {
    let n = 0;
    const { mgr, getSnapshot } = make(async () => (++n <= 3 ? fail : okResult));
    const stop = mgr.startLoop(60_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getSnapshot).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(mgr.get()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot).toHaveBeenCalledTimes(4);
    expect(mgr.get()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(getSnapshot).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot).toHaveBeenCalledTimes(5);
    stop();
  });

  it('caps the backoff at intervalMs', async () => {
    const times: number[] = [];
    const { mgr } = make(async () => {
      times.push(Date.now());
      return fail;
    });
    const t0 = Date.now();
    const stop = mgr.startLoop(10_000);
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 10_000 + 10_000);
    // delays between pulls: 2, 4, 8, 10, 10
    expect(times.map((t) => (t - t0) / 1000)).toEqual([0, 2, 6, 14, 24, 34]);
    stop();
  });

  it('keeps the normal interval after a failure when the snapshot is still fresh', async () => {
    db.setKv('snapshot', JSON.stringify(snapshot));
    db.setKv('snapshot_at', String(Date.now()));
    const { mgr, getSnapshot } = make(async () => fail);
    mgr.load();
    const stop = mgr.startLoop(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    stop();
  });

  it('survives a thrown error and retries', async () => {
    let n = 0;
    const { mgr, getSnapshot } = make(async () => {
      if (++n === 1) throw new Error('boom');
      return okResult;
    });
    const stop = mgr.startLoop(60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(mgr.get()).not.toBeNull();
    stop();
  });

  it('never runs two pulls concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const { mgr, getSnapshot } = make(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25_000));
      active--;
      return fail;
    });
    const stop = mgr.startLoop(10_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maxActive).toBe(1);
    expect(getSnapshot.mock.calls.length).toBeGreaterThan(1);
    stop();
  });

  it('stop() prevents further pulls, including when stopped mid-pull', async () => {
    const { mgr, getSnapshot } = make(async () => fail);
    const stop = mgr.startLoop(60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    let release!: () => void;
    const slow = make(
      () =>
        new Promise((r) => {
          release = () => r(fail);
        }),
    );
    const stop2 = slow.mgr.startLoop(60_000);
    await vi.advanceTimersByTimeAsync(0);
    stop2();
    release();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(slow.getSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
