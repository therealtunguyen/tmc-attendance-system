// Tests for the outbox (#27, #30).
// Verifies: network drop/recovery, in-flight PENDING guard, crash recovery, overlap guard, reject limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import type {
  OpenResult,
  TurnstileClient,
} from '../../../server/src/adapters/tcs/turnstile-client.js';
import { MAX_PUSH_ATTEMPTS, OUTBOX_BATCH_LIMIT, type Db } from '../db.js';
import { flushOutbox, outboxSize, startOutboxLoop } from '../outbox.js';
import { ServerClient } from '../server-client.js';
import { scan } from '../scan.js';
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

    // Stuck row is parked and no longer blocks the outbox, but outboxSize still reports it (#96).
    expect(db.unpushedEvents()).toHaveLength(0);
    expect(outboxSize(db)).toBe(1);

    // Newer scan still flushes cleanly; parked row remains counted.
    await scan(
      { gateId: 'g', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      new MockTurnstile('open'),
    );
    expect(await flushOutbox(db, rejectStuckClient, 'edge-1')).toBe(1);
    expect(outboxSize(db)).toBe(1);
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

  it('counts an attempt on 4xx responses so a poison row parks after MAX_PUSH_ATTEMPTS (#96)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    await scan(
      { gateId: 'bad-gate', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      new MockTurnstile('open'),
    );
    const badId = db.unpushedEvents()[0]!.eventId;

    // Server returns 400 Bad Request for the poison batch.
    const badBatchClient = makeMockClient(async () => ({
      ok: false,
      status: 400,
      error: 'Invalid gateId in batch',
    }));

    for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) {
      expect(await flushOutbox(db, badBatchClient, 'edge-1')).toBe(0);
    }

    // Poison row is parked at MAX_PUSH_ATTEMPTS and no longer selected by unpushedEvents.
    expect(db.unpushedEvents()).toHaveLength(0);
    expect(outboxSize(db)).toBe(1); // Still reported in outboxSize (#96).

    // Subsequent valid scan can now be flushed.
    await scan(
      { gateId: 'g', token: issueToken(employee.id, privateKey) },
      db,
      snapshots,
      new MockTurnstile('open'),
    );
    const okClient = makeMockClient(async (req) => ({
      ok: true,
      data: { accepted: req.events.map((e) => e.eventId) },
    }));

    expect(await flushOutbox(db, okClient, 'edge-1')).toBe(1);
    expect(db.getEvent(badId)?.pushAttempts).toBe(MAX_PUSH_ATTEMPTS);
  });

  it('uses db.maxPushAttempts option in log messages instead of hardcoded constant (#96)', async () => {
    const custom = createTempDb({ maxPushAttempts: 2 });
    try {
      expect(custom.db.maxPushAttempts).toBe(2);
      const snapshots = makeLoadedSnapshots(custom.db, makeSnapshot([employee], publicKey));
      await scan(
        { gateId: 'g', token: issueToken(employee.id, privateKey) },
        custom.db,
        snapshots,
        new MockTurnstile('open'),
      );

      const client = makeMockClient(async () => ({
        ok: false,
        status: 400,
        error: 'Bad Request',
      }));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await flushOutbox(custom.db, client, 'edge-1');
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('(attempt 1/2)'))).toBe(true);

        await flushOutbox(custom.db, client, 'edge-1');
        expect(
          warnSpy.mock.calls.some((c) =>
            String(c[0]).includes('(reached max 2 attempts; parking)'),
          ),
        ).toBe(true);

        expect(custom.db.unpushedEvents()).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      custom.cleanup();
    }
  });

  it('backs off flush retries on repeated failures and resets upon success (#96)', async () => {
    vi.useFakeTimers();
    try {
      const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
      await scan(
        { gateId: 'g', token: issueToken(employee.id, privateKey) },
        db,
        snapshots,
        new MockTurnstile('open'),
      );

      let pushCalls = 0;
      let shouldFail = true;
      const client = makeMockClient(async (req) => {
        pushCalls++;
        if (shouldFail) {
          return { ok: false, status: 503, error: 'Server unavailable' };
        }
        return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // startOutboxLoop runs immediate flush (pushCalls = 1).
      const stop = startOutboxLoop(db, client, 'edge-1', 5_000, 30_000);
      expect(pushCalls).toBe(1);

      // Failure 1: next delay is 5s.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pushCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pushCalls).toBe(2);

      // Failure 2: delay doubles to 10s.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(pushCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(pushCalls).toBe(3);

      // Failure 3: delay doubles to 20s.
      await vi.advanceTimersByTimeAsync(19_999);
      expect(pushCalls).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(pushCalls).toBe(4);

      // Failure 4: delay capped at maxBackoffMs (30s).
      await vi.advanceTimersByTimeAsync(29_999);
      expect(pushCalls).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(pushCalls).toBe(5);

      // Server recovers!
      shouldFail = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pushCalls).toBe(6);
      expect(db.unpushedEvents()).toHaveLength(0);

      // Queue another scan so the next tick has an event to push.
      await scan(
        { gateId: 'g', token: issueToken(employee.id, privateKey) },
        db,
        snapshots,
        new MockTurnstile('open'),
      );

      // Next interval resets back to base 5s.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pushCalls).toBe(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(pushCalls).toBe(7);

      stop();
      warnSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates the rejected row: good events in a mixed batch are pushed, only the bad one parks (#96)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    for (const gateId of ['g1', 'bad-gate', 'g3']) {
      await scan(
        { gateId, token: issueToken(employee.id, privateKey) },
        db,
        snapshots,
        new MockTurnstile('open'),
      );
    }
    const badId = db.unpushedEvents().find((e) => e.gateId === 'bad-gate')!.eventId;
    // Server rejects with 400 any request that contains the bad event.
    const client = makeMockClient(async (req) =>
      req.events.some((e) => e.eventId === badId)
        ? { ok: false, status: 400, error: 'Invalid gateId' }
        : { ok: true, data: { accepted: req.events.map((e) => e.eventId) } },
    );

    for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) await flushOutbox(db, client, 'edge-1');

    expect(db.unpushedEvents()).toHaveLength(0);
    expect(db.getEvent(badId)?.pushAttempts).toBe(MAX_PUSH_ATTEMPTS);
    expect(outboxSize(db)).toBe(1); // only the parked bad row remains
  });

  it('does not count attempts or park anything on a 401 (key rotation) (#96)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    for (const gateId of ['g1', 'g2']) {
      await scan(
        { gateId, token: issueToken(employee.id, privateKey) },
        db,
        snapshots,
        new MockTurnstile('open'),
      );
    }
    const client = makeMockClient(async () => ({ ok: false, status: 401, error: 'Unauthorized' }));

    for (let i = 0; i < MAX_PUSH_ATTEMPTS + 2; i++) await flushOutbox(db, client, 'edge-1');

    const pending = db.unpushedEvents();
    expect(pending).toHaveLength(2);
    expect(pending.every((e) => e.pushAttempts === 0)).toBe(true);
  });

  it('never parks valid events when every push returns 404 (wrong SERVER_BASE_URL) (#96)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    for (const gateId of ['g1', 'g2', 'g3']) {
      await scan(
        { gateId, token: issueToken(employee.id, privateKey) },
        db,
        snapshots,
        new MockTurnstile('open'),
      );
    }
    const client = makeMockClient(async () => ({ ok: false, status: 404, error: 'Not Found' }));

    for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) await flushOutbox(db, client, 'edge-1');

    const pending = db.unpushedEvents();
    expect(pending).toHaveLength(3);
    expect(pending.every((e) => e.pushAttempts === 0)).toBe(true);
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

  it('does not overwrite an already-pushed PENDING row when setOutcome runs late and logs an error', async () => {
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

    const serverEvents: { eventId: string; outcome: string }[] = [];
    const client = makeMockClient(async (req) => {
      for (const e of req.events) serverEvents.push({ eventId: e.eventId, outcome: e.outcome });
      return { ok: true, data: { accepted: req.events.map((e) => e.eventId) } };
    });

    // Simulate a scan older than pendingGraceS (10s) still waiting on TCS.
    const oldClock = () => new Date(Date.now() - 10_000);
    const scanPromise = scan({ gateId: 'g', token }, db, snapshots, turnstile, oldClock);
    await openCalled;

    // Outbox flushes the aged PENDING row while TCS is still in flight.
    expect(await flushOutbox(db, client, 'edge-1')).toBe(1);
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]?.outcome).toBe('PENDING');

    // Now TCS finally returns OPENED; setOutcome sees pushed_at IS NOT NULL and logs an error.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      resolveOpen('OPENED');
      const result = await scanPromise;
      expect(result.outcome).toBe('GRANTED');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain('updated 0 rows');

      const stored = db.getEvent(result.eventId);
      expect(stored?.outcome).toBe('PENDING');
      expect(stored?.pushedAt).not.toBeNull();
      expect(outboxSize(db)).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('non-JSON 200 body (#113 B1)', () => {
  const html = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>captive portal</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

  afterEach(() => vi.unstubAllGlobals());

  it('getSnapshot and pushEvents resolve {ok:false} instead of rejecting', async () => {
    html();
    const client = new ServerClient('http://server.test', 't');
    expect((await client.getSnapshot('edge')).ok).toBe(false);
    expect((await client.pushEvents({ edgeId: 'edge', events: [] })).ok).toBe(false);
  });

  it('flushOutbox does not reject and keeps the event queued', async () => {
    html();
    db.commitScan(
      {
        eventId: 'e1',
        gateId: 'g',
        employeeId: 'x',
        method: 'QR',
        outcome: 'GRANTED',
        occurredAt: new Date(Date.now() - 10_000).toISOString(),
        jti: 'j',
        stale: 0,
        denyReason: null,
      },
      1000,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      flushOutbox(db, new ServerClient('http://server.test', 't'), 'edge'),
    ).resolves.toBe(0);
    warn.mockRestore();
    expect(outboxSize(db)).toBe(1);
  });
});
