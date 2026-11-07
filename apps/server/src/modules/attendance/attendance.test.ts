import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { MAX_EDGE_BATCH, type EdgeEvent } from '../../shared/contracts/edge.js';
import type { Scope } from '../../shared/types.js';
import type { EmployeeDirectory } from '../employee-qr/index.js';
import { attendanceRoutes } from './attendance.routes.js';
import {
  AttendanceService,
  OutcomeConflictError,
  UnknownEventError,
  type AttendanceStore,
  type ScanEvent,
  type ScanOutcome,
  type StoredEvent,
} from './attendance.service.js';

/** Same contract as AttendanceRepo: insert skips a known eventId, decide only moves from PENDING. */
class InMemoryEvents implements AttendanceStore {
  rows = new Map<string, StoredEvent>();

  async insert(event: StoredEvent) {
    if (this.rows.has(event.eventId)) return false;
    this.rows.set(event.eventId, { ...event });
    return true;
  }

  async insertMany(events: StoredEvent[]) {
    for (const event of events) await this.insert(event);
  }

  async decide(eventId: string, outcome: ScanOutcome) {
    const row = this.rows.get(eventId);
    if (!row || (row.outcome !== 'PENDING' && row.outcome !== outcome)) return false;
    row.outcome = outcome;
    return true;
  }

  async outcomeOf(eventId: string) {
    return this.rows.get(eventId)?.outcome ?? null;
  }

  async grantedEvents(from: Date, to: Date, employeeIds?: string[]) {
    return [...this.rows.values()].filter(
      (e) =>
        e.outcome === 'GRANTED' &&
        e.employeeId !== null &&
        (!employeeIds || employeeIds.includes(e.employeeId)) &&
        e.occurredAt >= from &&
        e.occurredAt < to,
    );
  }
}

/** Stands in for EQR's EmployeeDirectory: scope is a factory ID. */
class FakeDirectory implements EmployeeDirectory {
  constructor(private byFactory: Record<string, string[]>) {}

  async find(id: string) {
    return { id, firstName: id, lastName: 'X', active: true };
  }

  async list(scope: Scope) {
    return (this.byFactory[scope] ?? []).map((id) => ({
      id,
      firstName: id,
      lastName: 'X',
      active: true,
    }));
  }
}

const scan: ScanEvent = {
  eventId: 'e-1',
  employeeId: 'emp-1',
  gateId: 'bd-gate-1',
  method: 'QR',
  occurredAt: new Date('2026-11-06T07:58:00Z'),
};

let store: InMemoryEvents;
let attendance: AttendanceService;

beforeEach(() => {
  store = new InMemoryEvents();
  attendance = new AttendanceService(
    store,
    new FakeDirectory({ 'binh-duong': ['emp-1', 'emp-2'], 'long-an': ['emp-3'] }),
  );
});

describe('AttendanceService.record (FR-3.1, FR-3.2)', () => {
  it('stores a new scan as PENDING, from the server (no edge, not stale)', async () => {
    expect(await attendance.record(scan)).toBe(true);
    expect(store.rows.get('e-1')).toEqual({
      ...scan,
      outcome: 'PENDING',
      edgeId: null,
      jti: null,
      stale: false,
    });
  });

  it('is idempotent by eventId: a repeat returns false and keeps the first row', async () => {
    await attendance.record(scan);
    await attendance.setOutcome('e-1', 'GRANTED');
    expect(await attendance.record({ ...scan, gateId: 'other', occurredAt: new Date() })).toBe(
      false,
    );
    expect(store.rows.size).toBe(1);
    expect(store.rows.get('e-1')).toMatchObject({ gateId: 'bd-gate-1', outcome: 'GRANTED' });
  });

  it('two concurrent records of one eventId insert once', async () => {
    const results = await Promise.all([attendance.record(scan), attendance.record(scan)]);
    expect(results.sort()).toEqual([false, true]);
    expect(store.rows.size).toBe(1);
  });

  it('keeps a MANUAL event with no employee (unreadable token)', async () => {
    const manual = { ...scan, eventId: 'e-2', employeeId: null, method: 'MANUAL' as const };
    expect(await attendance.record(manual)).toBe(true);
    expect(store.rows.get('e-2')).toMatchObject({ employeeId: null, method: 'MANUAL' });
  });

  it('stores a scan that failed validation as DENIED straight away (ADR-3, Figure 5.2)', async () => {
    expect(await attendance.record({ ...scan, outcome: 'DENIED' })).toBe(true);
    expect(store.rows.get('e-1')?.outcome).toBe('DENIED');
    // Already decided: the gate does not call TCS, and the outcome cannot be flipped later.
    await expect(attendance.setOutcome('e-1', 'DENIED')).resolves.toBeUndefined();
    await expect(attendance.setOutcome('e-1', 'GRANTED')).rejects.toBeInstanceOf(
      OutcomeConflictError,
    );
  });

  it('refuses GRANTED at commit time: the gate has not opened yet (ADR-3)', async () => {
    const granted = { ...scan, outcome: 'GRANTED' } as unknown as ScanEvent;
    await expect(attendance.record(granted)).rejects.toThrow(TypeError);
    expect(store.rows.size).toBe(0);
  });

  it('ignores fields outside ScanEvent passed by a caller', async () => {
    await attendance.record({ ...scan, stale: true, edgeId: 'x' } as ScanEvent);
    expect(store.rows.get('e-1')).toMatchObject({ stale: false, edgeId: null });
  });
});

describe('AttendanceService.setOutcome', () => {
  it.each<ScanOutcome>(['GRANTED', 'DENIED'])('moves PENDING to %s', async (outcome) => {
    await attendance.record(scan);
    await attendance.setOutcome('e-1', outcome);
    expect(store.rows.get('e-1')?.outcome).toBe(outcome);
  });

  it('repeating the same outcome is a no-op (a retried call does not fail)', async () => {
    await attendance.record(scan);
    await attendance.setOutcome('e-1', 'DENIED');
    await expect(attendance.setOutcome('e-1', 'DENIED')).resolves.toBeUndefined();
  });

  it('refuses to flip a decided outcome', async () => {
    await attendance.record(scan);
    await attendance.setOutcome('e-1', 'GRANTED');
    const error = await attendance.setOutcome('e-1', 'DENIED').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeConflictError);
    expect(error).toMatchObject({ eventId: 'e-1', current: 'GRANTED' });
    expect(store.rows.get('e-1')?.outcome).toBe('GRANTED');
  });

  it('throws UnknownEventError for an eventId never recorded', async () => {
    const error = await attendance.setOutcome('nope', 'GRANTED').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownEventError);
    expect(error).toMatchObject({ eventId: 'nope' });
  });
});

const edgeEvent = (eventId: string, changes: Partial<EdgeEvent> = {}): EdgeEvent => ({
  eventId,
  gateId: 'bd-gate-1',
  employeeId: 'emp-1',
  method: 'QR',
  outcome: 'GRANTED',
  occurredAt: '2026-11-07T00:58:00.000Z',
  jti: `jti-${eventId}`,
  stale: false,
  ...changes,
});

describe('AttendanceService.ingest (ADR-9, FR-3.2)', () => {
  it('stores each event as the edge decided it, with the edgeId', async () => {
    const res = await attendance.ingest({
      edgeId: 'edge-bd',
      events: [edgeEvent('x-1'), edgeEvent('x-2', { outcome: 'DENIED', stale: true, jti: null })],
    });
    expect(res).toEqual({ accepted: ['x-1', 'x-2'] });
    expect(store.rows.get('x-1')).toEqual({
      eventId: 'x-1',
      gateId: 'bd-gate-1',
      employeeId: 'emp-1',
      method: 'QR',
      outcome: 'GRANTED',
      occurredAt: new Date('2026-11-07T00:58:00.000Z'),
      edgeId: 'edge-bd',
      jti: 'jti-x-1',
      stale: false,
    });
    expect(store.rows.get('x-2')).toMatchObject({ outcome: 'DENIED', stale: true, jti: null });
  });

  it('a repeated push stores once and still lists every eventId as accepted', async () => {
    const batch = { edgeId: 'edge-bd', events: [edgeEvent('x-1'), edgeEvent('x-2')] };
    await attendance.ingest(batch);
    const again = await attendance.ingest({
      ...batch,
      events: [...batch.events, edgeEvent('x-3')],
    });
    expect(again).toEqual({ accepted: ['x-1', 'x-2', 'x-3'] });
    expect(store.rows.size).toBe(3);
  });

  it('a duplicate inside one batch is stored once and listed once', async () => {
    const res = await attendance.ingest({
      edgeId: 'edge-bd',
      events: [edgeEvent('x-1'), edgeEvent('x-1', { outcome: 'DENIED' })],
    });
    expect(res).toEqual({ accepted: ['x-1'] });
    expect(store.rows.get('x-1')?.outcome).toBe('GRANTED');
  });

  it('skips a known eventId without changing it, even a PENDING one', async () => {
    await attendance.record({ ...scan, eventId: 'x-1' });
    const res = await attendance.ingest({ edgeId: 'edge-bd', events: [edgeEvent('x-1')] });
    expect(res).toEqual({ accepted: ['x-1'] });
    expect(store.rows.get('x-1')).toMatchObject({ outcome: 'PENDING', edgeId: null });
  });

  it('an empty batch stores nothing', async () => {
    expect(await attendance.ingest({ edgeId: 'edge-bd', events: [] })).toEqual({ accepted: [] });
    expect(store.rows.size).toBe(0);
  });
});

describe('POST /api/edge/events', () => {
  const app = () => createApp([attendanceRoutes(attendance)]);

  it('returns the accepted eventIds (200)', async () => {
    const res = await request(app())
      .post('/api/edge/events')
      .send({ edgeId: 'edge-bd', events: [edgeEvent('x-1'), edgeEvent('x-2')] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: ['x-1', 'x-2'] });
    expect(store.rows.get('x-2')?.occurredAt).toEqual(new Date('2026-11-07T00:58:00.000Z'));
  });

  it('reads an explicit +07:00 offset as the same instant in UTC', async () => {
    const local = edgeEvent('x-1', { occurredAt: '2026-11-07T07:58:00+07:00' });
    const res = await request(app())
      .post('/api/edge/events')
      .send({ edgeId: 'edge-bd', events: [local] });
    expect(res.status).toBe(200);
    expect(store.rows.get('x-1')?.occurredAt).toEqual(new Date('2026-11-07T00:58:00Z'));
  });

  it('a full batch of MAX_EDGE_BATCH UUID-sized events fits the JSON body limit (200)', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const events = Array.from({ length: MAX_EDGE_BATCH }, (_, i) =>
      edgeEvent(uuid(i), { employeeId: uuid(1e6 + i), gateId: uuid(2e6), jti: uuid(3e6 + i) }),
    );
    const res = await request(app())
      .post('/api/edge/events')
      .send({ edgeId: uuid(4e6), events });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toHaveLength(MAX_EDGE_BATCH);
  });

  it('accepts a MANUAL event with no employee and no jti', async () => {
    const manual = edgeEvent('m-1', { method: 'MANUAL', employeeId: null, jti: null });
    const res = await request(app())
      .post('/api/edge/events')
      .send({ edgeId: 'edge-bd', events: [manual] });
    expect(res.status).toBe(200);
  });

  it.each([
    ['an array body', [edgeEvent('x-1')], 'body must be a JSON object'],
    ['no edgeId', { events: [] }, 'edgeId must be a non-empty string'],
    ['events not an array', { edgeId: 'e', events: {} }, 'events must be an array'],
    ['a non-object event', { edgeId: 'e', events: ['x'] }, 'events[0] must be an object'],
    [
      'a bad method',
      { edgeId: 'e', events: [edgeEvent('x-1'), edgeEvent('x-2', { method: 'NFC' as 'QR' })] },
      'events[1].method must be QR or MANUAL',
    ],
    [
      'a bad outcome',
      { edgeId: 'e', events: [edgeEvent('x-1', { outcome: 'OPEN' as 'GRANTED' })] },
      'events[0].outcome must be PENDING, GRANTED or DENIED',
    ],
    [
      'a bad date',
      { edgeId: 'e', events: [edgeEvent('x-1', { occurredAt: '07/11/2026' })] },
      'events[0].occurredAt must be an ISO date',
    ],
    [
      'a date with no offset (server would read it in its own zone)',
      { edgeId: 'e', events: [edgeEvent('x-1', { occurredAt: '2026-11-07T07:58' })] },
      'events[0].occurredAt must be an ISO date',
    ],
    [
      'a date that does not exist (Date.parse rolls 02-31 into March)',
      { edgeId: 'e', events: [edgeEvent('x-1', { occurredAt: '2026-02-31T07:58:00Z' })] },
      'events[0].occurredAt must be an ISO date',
    ],
    [
      'an hour out of range',
      { edgeId: 'e', events: [edgeEvent('x-1', { occurredAt: '2026-11-07T25:00:00Z' })] },
      'events[0].occurredAt must be an ISO date',
    ],
    [
      `more than MAX_EDGE_BATCH (${MAX_EDGE_BATCH}) events`,
      {
        edgeId: 'e',
        events: Array.from({ length: MAX_EDGE_BATCH + 1 }, (_, i) => edgeEvent(`x-${i}`)),
      },
      `events must hold at most ${MAX_EDGE_BATCH} events; split the outbox into batches`,
    ],
    [
      'a missing eventId',
      { edgeId: 'e', events: [edgeEvent('', {})] },
      'events[0].eventId must be a non-empty string',
    ],
    [
      'a non-boolean stale',
      { edgeId: 'e', events: [edgeEvent('x-1', { stale: 'no' as unknown as boolean })] },
      'events[0].stale must be a boolean',
    ],
  ])('rejects %s (400) and stores nothing', async (_name, body, error) => {
    const res = await request(app()).post('/api/edge/events').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(store.rows.size).toBe(0);
  });
});

describe('AttendanceService.dailyRecords (FR-3.4, FR-3.5)', () => {
  /** Edge-pushed scans; times are UTC, Vietnam is UTC+7. */
  const push = (...events: [string, string, string, EdgeEvent['outcome']?][]) =>
    attendance.ingest({
      edgeId: 'edge-bd',
      events: events.map(([eventId, employeeId, occurredAt, outcome = 'GRANTED']) =>
        edgeEvent(eventId, { employeeId, occurredAt, outcome }),
      ),
    });
  const range = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });

  it('builds first in, last out and hours for each employee in the scope', async () => {
    await push(
      ['a', 'emp-1', '2026-11-07T00:58:00Z'], // 07:58 local
      ['b', 'emp-1', '2026-11-07T10:03:00Z'], // 17:03 local
      ['c', 'emp-2', '2026-11-07T01:00:00Z'], // single scan: missing punch
      ['d', 'emp-3', '2026-11-07T01:00:00Z'], // Long An: outside the scope
      ['e', 'emp-3', '2026-11-07T09:00:00Z'],
    );
    const records = await attendance.dailyRecords(
      range('2026-11-07T05:00:00Z', '2026-11-07T05:00:00Z'),
      'binh-duong',
    );
    expect(records).toEqual([
      {
        employeeId: 'emp-1',
        day: new Date('2026-11-06T17:00:00Z'),
        firstIn: new Date('2026-11-07T00:58:00Z'),
        lastOut: new Date('2026-11-07T10:03:00Z'),
        hours: 9.08,
        missingPunch: false,
      },
      {
        employeeId: 'emp-2',
        day: new Date('2026-11-06T17:00:00Z'),
        firstIn: new Date('2026-11-07T01:00:00Z'),
        lastOut: null,
        hours: 0,
        missingPunch: true,
      },
    ]);
  });

  it('includes every local day of the range, the last one too', async () => {
    await push(
      ['a', 'emp-1', '2026-11-05T16:59:00Z'], // 23:59 on 05/11: before the range
      ['b', 'emp-1', '2026-11-05T17:00:00Z'], // 00:00 on 06/11: first day
      ['c', 'emp-1', '2026-11-07T16:59:00Z'], // 23:59 on 07/11: last day
      ['d', 'emp-1', '2026-11-07T17:00:00Z'], // 00:00 on 08/11: after the range
    );
    const records = await attendance.dailyRecords(
      range('2026-11-06T03:00:00Z', '2026-11-07T03:00:00Z'),
      'binh-duong',
    );
    expect(records.map((r) => [r.day.toISOString(), r.firstIn?.toISOString()])).toEqual([
      ['2026-11-05T17:00:00.000Z', '2026-11-05T17:00:00.000Z'],
      ['2026-11-06T17:00:00.000Z', '2026-11-07T16:59:00.000Z'],
    ]);
  });

  it('counts only GRANTED events (PENDING and DENIED are not attendance)', async () => {
    await push(
      ['a', 'emp-1', '2026-11-07T01:00:00Z'],
      ['b', 'emp-1', '2026-11-07T09:00:00Z', 'DENIED'],
      ['c', 'emp-1', '2026-11-07T10:00:00Z', 'PENDING'],
    );
    const [record] = await attendance.dailyRecords(
      range('2026-11-07T05:00:00Z', '2026-11-07T05:00:00Z'),
      'binh-duong',
    );
    expect(record).toMatchObject({ missingPunch: true, lastOut: null });
  });

  it('a scope with no employees gives no records', async () => {
    await push(['a', 'emp-1', '2026-11-07T01:00:00Z']);
    const records = await attendance.dailyRecords(
      range('2026-11-07T05:00:00Z', '2026-11-07T05:00:00Z'),
      'nowhere',
    );
    expect(records).toEqual([]);
  });
});
