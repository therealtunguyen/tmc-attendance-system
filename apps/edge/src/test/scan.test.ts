// Tests for the local-first scan flow (#24, ADR-9).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import type { TurnstileClient } from '../../../server/src/adapters/tcs/turnstile-client.js';
import { signQrToken } from '../../../server/src/shared/contracts/qr-token.js';
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

  it('commits a PENDING event before the TCS call and updates it after', async () => {
    const snapshot = makeSnapshot([employee], publicKey);
    const snapshots = makeLoadedSnapshots(db, snapshot);
    const token = issueToken(employee.id, privateKey);

    await scan({ gateId: 'gate-1', token }, db, snapshots, new MockTurnstile('slow', 50));

    const unpushed = db.unpushedEvents();
    expect(unpushed).toHaveLength(1);
    expect(unpushed[0]).toMatchObject({
      gateId: 'gate-1',
      employeeId: employee.id,
      outcome: 'DENIED',
      denyReason: null,
    });
  });
});

describe('scan — verified denials stored without calling TCS (#24)', () => {
  it('stores REVOKED denial with employeeId, jti, denyReason and returns firstName without calling TCS', async () => {
    const revokedEmployee = { id: 'emp-rev', firstName: 'Rev', deny: 'REVOKED' as const };
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([revokedEmployee], publicKey));
    const token = issueToken(revokedEmployee.id, privateKey);
    const openSpy = vi.fn<TurnstileClient['open']>(async () => 'OPENED');

    const result = await scan({ gateId: 'gate-1', token }, db, snapshots, { open: openSpy });

    expect(openSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'DENIED',
      reason: 'REVOKED',
      firstName: 'Rev',
    });
    const events = db.unpushedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: result.eventId,
      gateId: 'gate-1',
      employeeId: 'emp-rev',
      outcome: 'DENIED',
      denyReason: 'REVOKED',
    });
    expect(events[0]?.jti).toBeTruthy();
  });

  it('stores INACTIVE denial with employeeId, jti, denyReason and returns firstName without calling TCS', async () => {
    const inactiveEmployee = { id: 'emp-off', firstName: 'Off', deny: 'INACTIVE' as const };
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([inactiveEmployee], publicKey));
    const token = issueToken(inactiveEmployee.id, privateKey);
    const openSpy = vi.fn<TurnstileClient['open']>(async () => 'OPENED');

    const result = await scan({ gateId: 'gate-1', token }, db, snapshots, { open: openSpy });

    expect(openSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'DENIED',
      reason: 'INACTIVE',
      firstName: 'Off',
    });
    const events = db.unpushedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      employeeId: 'emp-off',
      outcome: 'DENIED',
      denyReason: 'INACTIVE',
    });
  });

  it('stores UNKNOWN denial with verified sub as employeeId, jti, denyReason and no firstName', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken('emp-unknown', privateKey);
    const openSpy = vi.fn<TurnstileClient['open']>(async () => 'OPENED');

    const result = await scan({ gateId: 'gate-1', token }, db, snapshots, { open: openSpy });

    expect(openSpy).not.toHaveBeenCalled();
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') {
      expect(result.reason).toBe('UNKNOWN');
      expect(result.firstName).toBeUndefined();
    }
    const events = db.unpushedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      employeeId: 'emp-unknown',
      outcome: 'DENIED',
      denyReason: 'UNKNOWN',
    });
  });
});

describe('scan — unverified / no-snapshot denials not stored (FR-3.1 exception)', () => {
  it('denies NO_SNAPSHOT when no snapshot is loaded without storing an event', async () => {
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
    if (result.outcome === 'DENIED') {
      expect(result.reason).toBe('NO_SNAPSHOT');
      expect(result.firstName).toBeUndefined();
    }
    expect(db.unpushedEvents()).toHaveLength(0);
  });

  it('denies INVALID_SIGNATURE for a junk token without storing an event', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const result = await scan(
      { gateId: 'g', token: 'not.a.token' },
      db,
      snapshots,
      new MockTurnstile('open'),
    );
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') {
      expect(result.reason).toBe('INVALID_SIGNATURE');
      expect(result.firstName).toBeUndefined();
    }
    expect(db.unpushedEvents()).toHaveLength(0);
  });

  it('denies EXPIRED for an expired token without storing an event', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const expiredAt = Math.floor(Date.now() / 1000) - 120;
    const token = signQrToken(
      { sub: employee.id, exp: expiredAt, jti: 'expired-jti' },
      'k1',
      privateKey,
    );
    const result = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') {
      expect(result.reason).toBe('EXPIRED');
      expect(result.firstName).toBeUndefined();
    }
    expect(db.unpushedEvents()).toHaveLength(0);
  });

  it('denies TCS_UNAVAILABLE when TCS returns ERROR and still includes firstName', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);
    const result = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('fail'));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') {
      expect(result.reason).toBe('TCS_UNAVAILABLE');
      expect(result.firstName).toBe('Lan');
    }
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
