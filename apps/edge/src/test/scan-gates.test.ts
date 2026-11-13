// Gate check against the snapshot's gate list (#113).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnstileClient } from '../../../server/src/adapters/tcs/turnstile-client.js';
import { scan } from '../scan.js';
import {
  createTempDb,
  generatePair,
  issueToken,
  makeLoadedSnapshots,
  makeSnapshot,
} from './helpers.js';
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
const gates = [
  { id: 'gate-uuid-1', turnstileId: 'TS-01', active: true },
  { id: 'gate-uuid-off', turnstileId: 'TS-02', active: false },
];
const spy = () => vi.fn<TurnstileClient['open']>(async () => 'OPENED');

describe('scan — gate check (#113)', () => {
  it('opens the turnstile with the gate turnstileId, not the gate UUID', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey, 'k1', gates));
    const open = spy();
    const result = await scan(
      { gateId: 'gate-uuid-1', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      { open },
    );
    expect(result.outcome).toBe('GRANTED');
    expect(open).toHaveBeenCalledExactlyOnceWith('TS-01');
  });

  it('denies an unknown gate with UNKNOWN_GATE, stores nothing and does not burn the jti', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey, 'k1', gates));
    const open = spy();
    const token = issueToken(employee.id, privateKey);

    const result = await scan({ gateId: 'nope', token }, db, snapshots, { open });
    expect(result).toMatchObject({ outcome: 'DENIED', reason: 'UNKNOWN_GATE' });
    expect(open).not.toHaveBeenCalled();
    expect(db.unpushedEvents()).toHaveLength(0);

    // The same QR still works at a valid gate.
    const retry = await scan({ gateId: 'gate-uuid-1', token }, db, snapshots, { open });
    expect(retry.outcome).toBe('GRANTED');
  });

  it('denies an inactive gate with GATE_INACTIVE, stores it as DENIED and keeps the jti unburned', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey, 'k1', gates));
    const open = spy();
    const token = issueToken(employee.id, privateKey);

    const result = await scan({ gateId: 'gate-uuid-off', token }, db, snapshots, { open });
    expect(result).toMatchObject({ outcome: 'DENIED', reason: 'GATE_INACTIVE', firstName: 'Lan' });
    expect(open).not.toHaveBeenCalled();
    const events = db.unpushedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      gateId: 'gate-uuid-off',
      employeeId: employee.id,
      outcome: 'DENIED',
      denyReason: 'GATE_INACTIVE',
      jti: null,
    });

    const retry = await scan({ gateId: 'gate-uuid-1', token }, db, snapshots, { open });
    expect(retry.outcome).toBe('GRANTED');
  });

  it('logs an inactive gate with an unverifiable token without storing it', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey, 'k1', gates));
    const result = await scan({ gateId: 'gate-uuid-off', token: 'garbage' }, db, snapshots, {
      open: spy(),
    });
    expect(result).toMatchObject({ outcome: 'DENIED', reason: 'GATE_INACTIVE' });
    expect(db.unpushedEvents()).toHaveLength(0);
  });

  it('legacy snapshot without gates: skips the check and opens with the gateId', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    expect(snapshots.get()?.snapshot).not.toHaveProperty('gates');
    const open = spy();
    const result = await scan(
      { gateId: 'gate-1', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      { open },
    );
    expect(result.outcome).toBe('GRANTED');
    expect(open).toHaveBeenCalledExactlyOnceWith('gate-1');
  });
});
