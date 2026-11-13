// Tests for TCS timeout behaviour (#30, ADR-3).
// When TCS times out or errors, the gate must deny (fail closed, FR-2.3).
// The event must still be committed to SQLite and pushed via the outbox.
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
import type { Db } from '../db.js';

let db: Db;
let cleanup: () => void;
const { privateKey, publicKey } = generatePair();
const employee = { id: 'emp-tcs', firstName: 'TCS', deny: null as null };

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(() => {
  cleanup();
});

describe('TCS timeout → deny (#30, ADR-3)', () => {
  it('denies when TCS times out (slow mode)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);

    // MockTurnstile 'slow' waits out the timeout and returns TIMEOUT.
    const result = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('slow', 10));

    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toBe('TCS_UNAVAILABLE');
  });

  it('the event is committed to SQLite even when TCS times out', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);

    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('slow', 10));

    // Event must be in the outbox (pushed_at = NULL) with outcome DENIED.
    const events = db.unpushedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('DENIED');
  });

  it('denies when TCS returns ERROR', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);

    const result = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('fail'));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toBe('TCS_UNAVAILABLE');
  });

  it('the event is still pushed via the outbox after a TCS failure', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);

    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('fail'));

    // Event should be unpushed — the outbox loop will push it.
    expect(db.unpushedEvents()).toHaveLength(1);
    expect(db.unpushedEvents()[0]?.outcome).toBe('DENIED');
  });

  it('a TCS failure releases the jti: the same QR can be rescanned (#113 B2)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);

    const first = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('fail'));
    expect(first.outcome).toBe('DENIED');
    const second = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    expect(second.outcome).toBe('GRANTED');
    // A token that did open is still burned.
    const third = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    expect(third).toMatchObject({ outcome: 'DENIED', reason: 'REPLAYED' });
  });

  it('a TCS timeout also releases the jti (#113 B2)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);

    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('slow', 10));
    const again = await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    expect(again.outcome).toBe('GRANTED');
  });
});
