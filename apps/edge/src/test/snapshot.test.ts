// Tests for snapshot pulling, persistence, and stale detection (#26).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
