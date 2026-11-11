// Tests for the outbox (#27, #30).
// Verifies: network drop/recovery, in-flight PENDING guard, crash recovery, overlap guard, reject limit.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import type {
  OpenResult,
  TurnstileClient,
} from '../../../server/src/adapters/tcs/turnstile-client.js';
import { MAX_PUSH_ATTEMPTS, OUTBOX_BATCH_LIMIT, type Db } from '../db.js';
import { flushOutbox, outboxSize } from '../outbox.js';
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
    expect(db.unpushedEvents()).toHaveLength(0);
    expect(inserted.size).toBe(3);
  });

  it('does not push an in-flight PENDING row between commitScan and setOutcome', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const token = issueToken(employee.id, privateKey);

    let resolveOpen!: (res: OpenResult) => void;
    let markOpenCalled!: () => void;
    const openCalled = new Promise<void>((r) => {
      markOpenCalled = r;
    });
    const turnstile: TurnstileClient = {
      open: () => {
        markOpenCalled();
        return new Promise<OpenResult>((r) => {
          resolveOpen = r;
        });
      },
    };

    const pushedBatches: PushEventsRequest[] = [];
    const client = makeMockClient(async (req) => {
      pushedBatches.push(req);
      return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
    });

    // Start the scan and wait until commitScan has written PENDING and TCS open() is in flight.
    const scanPromise = scan({ gateId: 'g', token }, db, snapshots, turnstile);
    await openCalled;

    // Flush during TCS call: the fresh PENDING row must NOT be pushed.
    expect(await flushOutbox(db, client, 'edge-1')).toBe(0);
    expect(pushedBatches).toHaveLength(0);

    // Finish TCS -> setOutcome sets GRANTED.
    resolveOpen('OPENED');
    await scanPromise;

    // Next flush pushes the final GRANTED event.
    expect(await flushOutbox(db, client, 'edge-1')).toBe(1);
    expect(pushedBatches).toHaveLength(1);
    expect(pushedBatches[0]?.events[0]?.outcome).toBe('GRANTED');
  });

  it('eventually pushes a PENDING row older than the grace window (crash recovery)', async () => {
    const stalePendingAt = new Date(Date.now() - 10_000).toISOString();
    db.commitScan(
      {
        eventId: 'crashed-evt',
        gateId: 'g',
        employeeId: employee.id,
        method: 'QR',
        outcome: 'PENDING',
        occurredAt: stalePendingAt,
        jti: 'jti-crash',
        stale: 0,
        denyReason: null,
      },
      60_000,
    );

    const pushed: string[] = [];
    const client = makeMockClient(async (req) => {
      for (const e of req.events) pushed.push(`${e.eventId}:${e.outcome}`);
      return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
    });

    expect(await flushOutbox(db, client, 'edge-1')).toBe(1);
    expect(pushed).toEqual(['crashed-evt:PENDING']);
  });

  it('prevents overlapping flushOutbox calls on the same db', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    await scan(
      { gateId: 'g', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      new MockTurnstile('open'),
    );

    let releasePush!: () => void;
    let pushCalls = 0;
    const client = makeMockClient(
      (req) =>
        new Promise((resolve) => {
          pushCalls++;
          releasePush = () =>
            resolve({ ok: true, data: { accepted: req.events.map((e) => e.eventId) } });
        }),
    );

    const first = flushOutbox(db, client, 'edge-1');
    const second = flushOutbox(db, client, 'edge-1');
    releasePush();

    const [c1, c2] = await Promise.all([first, second]);
    expect(pushCalls).toBe(1);
    expect(c1).toBe(1);
    expect(c2).toBe(0);
  });

  it('parks events omitted from accepted after MAX_PUSH_ATTEMPTS so newer events are not starved', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    await scan(
      { gateId: 'g', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      new MockTurnstile('open'),
    );
    const stuckId = db.unpushedEvents()[0]!.eventId;

    // Server keeps omitting stuckId on 200 responses.
    const rejectStuckClient = makeMockClient(async (req) => ({
      ok: true,
      data: { accepted: req.events.filter((e) => e.eventId !== stuckId).map((e) => e.eventId) },
    }));

    for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) {
      await flushOutbox(db, rejectStuckClient, 'edge-1');
    }

    // Stuck row is parked and no longer blocks the outbox.
    expect(db.unpushedEvents()).toHaveLength(0);
    expect(outboxSize(db)).toBe(0);

    // Newer scan still flushes cleanly.
    await scan(
      { gateId: 'g', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      new MockTurnstile('open'),
    );
    expect(await flushOutbox(db, rejectStuckClient, 'edge-1')).toBe(1);
  });

  it('no duplicate events when outbox retries after a partial success', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const edgeId = 'edge-1';

    const token = issueToken(employee.id, privateKey);
    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));
    expect(db.unpushedEvents()).toHaveLength(1);

    let callCount = 0;
    const client = makeMockClient(async (req) => {
      callCount++;
      return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
    });

    await flushOutbox(db, client, edgeId);
    expect(db.unpushedEvents()).toHaveLength(0);

    await flushOutbox(db, client, edgeId);
    expect(callCount).toBe(1);
    expect(db.unpushedEvents()).toHaveLength(0);
  });

  it('leaves events in the outbox without burning attempts when the server returns 503', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const edgeId = 'edge-1';

    const token = issueToken(employee.id, privateKey);
    await scan({ gateId: 'g', token }, db, snapshots, new MockTurnstile('open'));

    const client = makeMockClient(async () => ({
      ok: false,
      status: 503,
      error: 'Server Error',
    }));

    for (let i = 0; i < MAX_PUSH_ATTEMPTS + 2; i++) {
      expect(await flushOutbox(db, client, edgeId)).toBe(0);
    }
    expect(db.unpushedEvents()).toHaveLength(1);
    expect(db.unpushedEvents()[0]?.pushAttempts).toBe(0);
  });

  it('drains more than OUTBOX_BATCH_LIMIT queued events in a single flushOutbox call', async () => {
    const total = OUTBOX_BATCH_LIMIT + 25;
    const baseTime = Date.now() - total * 1000;

    for (let i = 0; i < total; i++) {
      const occurredAt = new Date(baseTime + i * 1000).toISOString();
      db.commitScan(
        {
          eventId: `bulk-${i}`,
          gateId: 'g',
          employeeId: employee.id,
          method: 'QR',
          outcome: 'GRANTED',
          occurredAt,
          jti: `jti-bulk-${i}`,
          stale: 0,
          denyReason: null,
        },
        60_000,
      );
    }
    expect(outboxSize(db)).toBe(total);

    const batchSizes: number[] = [];
    const pushedIds = new Set<string>();
    const client = makeMockClient(async (req) => {
      batchSizes.push(req.events.length);
      for (const e of req.events) pushedIds.add(e.eventId);
      return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
    });

    const confirmed = await flushOutbox(db, client, 'edge-1');

    expect(confirmed).toBe(total);
    expect(batchSizes).toEqual([OUTBOX_BATCH_LIMIT, 25]);
    expect(pushedIds.size).toBe(total);
    expect(outboxSize(db)).toBe(0);
  });
});
