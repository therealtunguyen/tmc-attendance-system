// Tests for the local-first scan flow (#24, ADR-9).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import { scan } from '../scan.js';
import {
  createTempDb,
  generatePair,
  issueToken,
  makeLoadedSnapshots,
  makeSnapshot,
} from './helpers.js';
import type { ServerClient } from '../server-client.js';
import type { Db } from '../db.js';

let db: Db;
let cleanup: () => void;

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(() => {
  cleanup();
});

const { privateKey, publicKey } = generatePair();
const employee = { id: 'emp-1', firstName: 'Lan', deny: null as null };

describe('scan — happy path (#24)', () => {
  it('grants when token is valid, employee is active, TCS opens', async () => {
    const snapshot = makeSnapshot([employee], publicKey);
    const snapshots = makeLoadedSnapshots(db, snapshot);
    const token = issueToken(employee.id, privateKey);

    const result = await scan(
      { gateId: 'gate-1', token },
      db,
      snapshots,
      new MockTurnstile('open'),
    );

    expect(result.outcome).toBe('GRANTED');
    if (result.outcome === 'GRANTED') {
      expect(result.firstName).toBe('Lan');
      expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('commits a PENDING event before the TCS call', async () => {
    const snapshot = makeSnapshot([employee], publicKey);
    const snapshots = makeLoadedSnapshots(db, snapshot);
    const token = issueToken(employee.id, privateKey);

    // Use 'slow' mode: TCS never answers within timeout, so outcome = DENIED.
    // But the event must already be committed.
    await scan({ gateId: 'gate-1', token }, db, snapshots, new MockTurnstile('slow', 50));

    // The event should exist in the outbox (unpushed).
    const unpushed = db.unpushedEvents();
    expect(unpushed.length).toBeGreaterThanOrEqual(1);
    // It should have been updated to DENIED after the TCS call.
    const ev = unpushed.find((e) => e.gateId === 'gate-1');
    expect(ev?.outcome).toBe('DENIED');
  });
});

describe('scan — deny cases (#24)', () => {
  it('denies NO_SNAPSHOT when no snapshot is loaded', async () => {
    const fakeClient = {
      getSnapshot: async () => ({ ok: false as const, status: 0, error: '' }),
      pushEvents: async () => ({ ok: false as const, status: 0, error: '' }),
      heartbeat: async () => ({ ok: false as const, status: 0, error: '' }),
    } as unknown as ServerClient;
    const { SnapshotManager } = await import('../snapshot.js');
    const emptySnapshots = new SnapshotManager(db, fakeClient, 'test');
    const result = await scan(
      { gateId: 'g', token: 'bad' },
      db,
      emptySnapshots,
      new MockTurnstile('open'),
    );
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toBe('NO_SNAPSHOT');
  });

  it('denies INVALID_SIGNATURE for a junk token', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const result = await scan(
      { gateId: 'g', token: 'not.a.token' },
      db,
      snapshots,
      new MockTurnstile('open'),
    );
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toBe('INVALID_SIGNATURE');
  });

  it('denies REVOKED for a revoked employee', async () => {
    const revokedEmployee = { id: 'emp-rev', firstName: 'Rev', deny: 'REVOKED' as const };
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([revokedEmployee], publicKey));
    const token = issueToken(revokedEmployee.id, privateKey);
    const result = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toBe('REVOKED');
  });

  it('denies TCS_UNAVAILABLE when TCS returns ERROR', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);
    const result = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('fail'));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toBe('TCS_UNAVAILABLE');
  });

  it('marks the event stale when the snapshot is older than 5 min (#26)', async () => {
    const snapshot = makeSnapshot([employee], publicKey);
    // Inject a snapshot that was fetched 6 minutes ago.
    db.setKv('snapshot', JSON.stringify(snapshot));
    db.setKv('snapshot_at', String(Date.now() - 6 * 60 * 1000));
    const { SnapshotManager } = await import('../snapshot.js');
    const fakeClient = {
      getSnapshot: async () => ({ ok: false as const, status: 0, error: '' }),
      pushEvents: async () => ({ ok: false as const, status: 0, error: '' }),
      heartbeat: async () => ({ ok: false as const, status: 0, error: '' }),
    } as unknown as ServerClient;
    const snapshots = new SnapshotManager(db, fakeClient, 'test');
    snapshots.load();

    const token = issueToken(employee.id, privateKey);
    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));

    const events = db.unpushedEvents();
    expect(events[0]?.stale).toBe(1);
  });
});
