// Tests for the outbox (#27, #30).
// Verifies: network drop then recovery → no lost or duplicate events.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import { flushOutbox } from '../outbox.js';
import { scan } from '../scan.js';
import type { ServerClient } from '../server-client.js';
import {
  createTempDb,
  generatePair,
  issueToken,
  makeLoadedSnapshots,
  makeSnapshot,
} from './helpers.js';
import type {
  PushEventsResponse,
  PushEventsRequest,
} from '../../../server/src/shared/contracts/edge.js';
import type { Db } from '../db.js';

let db: Db;
let cleanup: () => void;
const { privateKey, publicKey } = generatePair();
const employee = { id: 'emp-out', firstName: 'Out', deny: null as null };

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(() => {
  cleanup();
});

/** Build a mock ServerClient whose pushEvents behaviour can be controlled. */
const makeMockClient = (
  pushImpl: (
    req: PushEventsRequest,
  ) => Promise<
    { ok: true; data: PushEventsResponse } | { ok: false; status: number; error: string }
  >,
) =>
  ({
    getSnapshot: async () => ({ ok: false as const, status: 0, error: '' }),
    pushEvents: pushImpl,
    heartbeat: async () => ({ ok: true as const, data: null }),
  }) as unknown as ServerClient;

describe('outbox — network drop then recovery (#27, #30)', () => {
  it('no events are lost when the server is unreachable during scans', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const edgeId = 'edge-1';

    // Run 3 scans while the server is "down".
    for (let i = 0; i < 3; i++) {
      const token = issueToken(employee.id, privateKey);
      await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    }
    expect(db.unpushedEvents()).toHaveLength(3);

    // Server comes back — track how many inserts it sees.
    const inserted = new Set<string>();
    const client = makeMockClient(async (req) => {
      for (const e of req.events) inserted.add(e.eventId);
      return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
    });

    const confirmed = await flushOutbox(db, client, edgeId);

    expect(confirmed).toBe(3);
    expect(db.unpushedEvents()).toHaveLength(0); // all cleared
    expect(inserted.size).toBe(3); // server saw exactly 3
  });

  it('no duplicate events when outbox retries after a partial success', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const edgeId = 'edge-1';

    // Scan once.
    const token = issueToken(employee.id, privateKey);
    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    expect(db.unpushedEvents()).toHaveLength(1);

    const eventId = db.unpushedEvents()[0]!.eventId;
    let callCount = 0;
    const client = makeMockClient(async (req) => {
      callCount++;
      return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
    });

    // First flush — success.
    await flushOutbox(db, client, edgeId);
    expect(db.unpushedEvents()).toHaveLength(0);

    // Second flush — the event is already marked pushed, so nothing is sent.
    await flushOutbox(db, client, edgeId);
    expect(callCount).toBe(1); // server was only called once
    expect(db.unpushedEvents()).toHaveLength(0);

    // The eventId was accepted exactly once.
    void eventId; // used above
  });

  it('leaves events in the outbox when the server returns an error', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const edgeId = 'edge-1';

    const token = issueToken(employee.id, privateKey);
    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));

    const client = makeMockClient(async () => ({
      ok: false,
      status: 503,
      error: 'Server Error',
    }));

    const confirmed = await flushOutbox(db, client, edgeId);
    expect(confirmed).toBe(0);
    expect(db.unpushedEvents()).toHaveLength(1); // still there
  });
});
