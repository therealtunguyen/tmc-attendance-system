// Tests for periodic heartbeat to the server (#28, FR-2.6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import type { EdgeHeartbeat } from '../../../server/src/shared/contracts/edge.js';
import type { Db } from '../db.js';
import { sendHeartbeat, startHeartbeatLoop } from '../heartbeat.js';
import { scan } from '../scan.js';
import type { ServerClient } from '../server-client.js';
import { SnapshotManager } from '../snapshot.js';
import {
  createTempDb,
  generatePair,
  issueToken,
  makeLoadedSnapshots,
  makeSnapshot,
} from './helpers.js';

let db: Db;
let cleanup: () => void;
const { privateKey, publicKey } = generatePair();
const employee = { id: 'emp-hb', firstName: 'HB', deny: null as null };

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(() => {
  cleanup();
});

describe('heartbeat (#28)', () => {
  it('sends snapshotAt=null and outboxSize=0 when no snapshot or pending events exist', async () => {
    const received: EdgeHeartbeat[] = [];
    const client = {
      heartbeat: async (hb: EdgeHeartbeat) => {
        received.push(hb);
        return { ok: true as const, data: null };
      },
    } as unknown as ServerClient;

    const snapshots = new SnapshotManager(db, client, 'edge-bd');
    const fixedNow = new Date('2026-11-10T08:00:00.000Z');

    expect(await sendHeartbeat(client, snapshots, db, 'edge-bd', () => fixedNow)).toBe(true);
    expect(received).toEqual([
      {
        edgeId: 'edge-bd',
        sentAt: '2026-11-10T08:00:00.000Z',
        snapshotAt: null,
        outboxSize: 0,
      },
    ]);
  });

  it('includes snapshot.generatedAt and current outboxSize', async () => {
    const snapshot = makeSnapshot([employee], publicKey);
    const snapshots = makeLoadedSnapshots(db, snapshot);
    await scan(
      { gateId: 'g-1', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      new MockTurnstile('open'),
    );

    const received: EdgeHeartbeat[] = [];
    const client = {
      heartbeat: async (hb: EdgeHeartbeat) => {
        received.push(hb);
        return { ok: true as const, data: null };
      },
    } as unknown as ServerClient;

    await sendHeartbeat(client, snapshots, db, 'edge-bd');
    expect(received[0]).toMatchObject({
      edgeId: 'edge-bd',
      snapshotAt: snapshot.generatedAt,
      outboxSize: 1,
    });
  });

  it('returns false without throwing when the server is unreachable', async () => {
    const client = {
      heartbeat: async () => ({ ok: false as const, status: 0, error: 'ECONNREFUSED' }),
    } as unknown as ServerClient;
    const snapshots = new SnapshotManager(db, client, 'edge-bd');

    expect(await sendHeartbeat(client, snapshots, db, 'edge-bd')).toBe(false);
  });

  it('startHeartbeatLoop avoids overlapping calls when a ping is slow', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let totalCalls = 0;
    const client = {
      heartbeat: async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        totalCalls++;
        await new Promise((r) => setTimeout(r, 40));
        inFlight--;
        return { ok: true as const, data: null };
      },
    } as unknown as ServerClient;

    const snapshots = new SnapshotManager(db, client, 'edge-bd');
    const stop = startHeartbeatLoop(client, snapshots, db, 'edge-bd', 10);
    await new Promise((r) => setTimeout(r, 70));
    stop();

    expect(maxConcurrent).toBe(1);
    expect(totalCalls).toBeGreaterThanOrEqual(1);
  });
});
