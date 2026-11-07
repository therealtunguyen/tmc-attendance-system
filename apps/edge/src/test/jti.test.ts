// Tests for the jti replay guard (#25, ADR-10).
// A jti seen within the token TTL must be rejected; after the TTL it may be reused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import { signQrToken } from '../../../server/src/shared/contracts/qr-token.js';
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
const employee = { id: 'emp-jti', firstName: 'Jti', deny: null as null };

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(() => {
  cleanup();
});

describe('jti replay guard (#25)', () => {
  it('admits the same token once and denies it on the second scan', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);
    const turnstile = new MockTurnstile('open');

    const first = await scan({ gateId: 'g', token }, db, snapshots, turnstile);
    expect(first.outcome).toBe('GRANTED');

    const second = await scan({ gateId: 'g', token }, db, snapshots, turnstile);
    expect(second.outcome).toBe('DENIED');
    if (second.outcome === 'DENIED') expect(second.reason).toBe('REPLAYED');
  });

  it('allows the same jti after the TTL has elapsed', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    // Issue a token that is at the edge of expiry (within tolerance).
    const token = signQrToken(
      { sub: employee.id, exp: nowS + 10, jti: 'old-jti' },
      'k1',
      privateKey,
    );
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const turnstile = new MockTurnstile('open');

    // First scan: admitted.
    const first = await scan({ gateId: 'g', token }, db, snapshots, turnstile);
    expect(first.outcome).toBe('GRANTED');

    // Manually prune jti_seen as if the TTL has elapsed.
    // JTI_TTL_MS = (60 + 10 + 30) * 1000 = 100_000 ms.  We call pruneJti with a threshold
    // that is *after* the entry we just inserted, simulating time passing.
    db.pruneJti(Date.now() + 1); // prune everything (threshold is in the future)

    // Second scan with the same jti: now allowed again because the entry was pruned.
    const second = await scan({ gateId: 'g', token }, db, snapshots, turnstile);
    expect(second.outcome).toBe('GRANTED');
  });

  it('two different tokens have independent jtis', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const t1 = issueToken(employee.id, privateKey);
    const t2 = issueToken(employee.id, privateKey);
    expect(t1).not.toBe(t2);

    const r1 = await scan({ gateId: 'g', token: t1 }, db, snapshots, new MockTurnstile('open'));
    const r2 = await scan({ gateId: 'g', token: t2 }, db, snapshots, new MockTurnstile('open'));
    expect(r1.outcome).toBe('GRANTED');
    expect(r2.outcome).toBe('GRANTED');
  });
});
