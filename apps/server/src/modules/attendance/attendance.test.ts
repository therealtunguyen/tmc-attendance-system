import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { MAX_EDGE_BATCH, type EdgeEvent } from '../../shared/contracts/edge.js';
import type { Scope } from '../../shared/types.js';
import type { EmployeeDirectory } from '../employee-qr/index.js';
import type { AuditEntry, AuditLog, UserRef } from '../iam/index.js';
import { attendanceRoutes } from './attendance.routes.js';
import {
  AttendanceService,
  InvalidCorrectionError,
  OutcomeConflictError,
  RecordNotFoundError,
  UnknownEventError,
  type AccessLogQuery,
  type AttendanceStore,
  type Correction,
  type ScanEvent,
  type ScanOutcome,
  type StoredEvent,
} from './attendance.service.js';

/** Same contract as AttendanceRepo: insert skips a known eventId, decide only moves from PENDING. */
class InMemoryEvents implements AttendanceStore {
  rows = new Map<string, StoredEvent>();
  correctionRows: Correction[] = [];

  async corrections(from: Date, to: Date, employeeIds?: string[]) {
    return this.correctionRows.filter(
      (c) => c.day >= from && c.day < to && (!employeeIds || employeeIds.includes(c.employeeId)),
    );
  }

  async correctionsOf(employeeId: string) {
    return this.correctionRows.filter((c) => c.employeeId === employeeId);
  }

  correctionIds: string[] = [];

  async insertCorrection(correction: Correction) {
    const id = `c-${this.correctionIds.length + 1}`;
    this.correctionRows.push(correction);
    this.correctionIds.push(id);
    return id;
  }

  async deleteCorrection(id: string) {
    const index = this.correctionIds.indexOf(id);
    if (index === -1) return;
    this.correctionRows.splice(index, 1);
    this.correctionIds.splice(index, 1);
  }

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

  async grantedEventsOf(employeeId: string) {
    return [...this.rows.values()].filter(
      (e) => e.outcome === 'GRANTED' && e.employeeId === employeeId,
    );
  }

  accessLogCalls = 0;

  async accessLog({ range, gateIds, outcome, limit }: AccessLogQuery) {
    this.accessLogCalls++;
    return [...this.rows.values()]
      .filter(
        (e) =>
          e.occurredAt >= range.from &&
          e.occurredAt < range.to &&
          (!gateIds || gateIds.includes(e.gateId)) &&
          (!outcome || e.outcome === outcome),
      )
      .sort(
        (a, b) =>
          b.occurredAt.getTime() - a.occurredAt.getTime() || a.eventId.localeCompare(b.eventId),
      )
      .slice(0, limit)
      .map((e) => ({ ...e }));
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

class RecordingAudit implements AuditLog {
  entries: AuditEntry[] = [];

  async append(entry: AuditEntry) {
    this.entries.push(entry);
  }

  async search() {
    return this.entries;
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
let audit: RecordingAudit;
let attendance: AttendanceService;

beforeEach(() => {
  store = new InMemoryEvents();
  audit = new RecordingAudit();
  attendance = new AttendanceService(
    store,
    new FakeDirectory({ 'binh-duong': ['emp-1', 'emp-2'], 'long-an': ['emp-3'] }),
    audit,
    () => NOW,
  );
});

/** The clock of the service in these tests: after every day the tests correct. */
const NOW = new Date('2026-11-09T03:00:00Z');

describe('AttendanceService.record (FR-3.1, FR-3.2)', () => {
  it('stores a new scan as PENDING, from the server (no edge, not stale)', async () => {
    expect(await attendance.record(scan)).toBe(true);
    expect(store.rows.get('e-1')).toEqual({
      ...scan,
      outcome: 'PENDING',
      denyReason: null,
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

  it('stores why a scan was denied (FR-4.4)', async () => {
    await attendance.record({ ...scan, outcome: 'DENIED', denyReason: 'REVOKED' });
    expect(store.rows.get('e-1')?.denyReason).toBe('REVOKED');
  });

  it('stores null when no denyReason is given', async () => {
    await attendance.record({ ...scan, outcome: 'DENIED' });
    expect(store.rows.get('e-1')?.denyReason).toBeNull();
  });

  it('refuses a denyReason on a PENDING scan', async () => {
    await expect(attendance.record({ ...scan, denyReason: 'REVOKED' })).rejects.toThrow(
      'denyReason requires outcome DENIED',
    );
    expect(store.rows.size).toBe(0);
  });

  it('refuses an unknown denyReason', async () => {
    const bad = { ...scan, outcome: 'DENIED', denyReason: 'BANNED' } as unknown as ScanEvent;
    await expect(attendance.record(bad)).rejects.toThrow('Unknown denyReason BANNED');
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
      denyReason: null,
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

  it('stores the denyReason an edge sent, and null when absent or null (FR-4.4)', async () => {
    await attendance.ingest({
      edgeId: 'edge-bd',
      events: [
        edgeEvent('d-1', { outcome: 'DENIED', denyReason: 'REVOKED' }),
        edgeEvent('d-2', { outcome: 'DENIED' }),
        edgeEvent('d-3', { outcome: 'DENIED', denyReason: null }),
      ],
    });
    expect(store.rows.get('d-1')?.denyReason).toBe('REVOKED');
    expect(store.rows.get('d-2')?.denyReason).toBeNull();
    expect(store.rows.get('d-3')?.denyReason).toBeNull();
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
      'an unknown denyReason',
      {
        edgeId: 'e',
        events: [edgeEvent('x-1', { outcome: 'DENIED', denyReason: 'BANNED' as 'EXPIRED' })],
      },
      'events[0].denyReason must be one of INVALID_SIGNATURE, EXPIRED, UNKNOWN, INACTIVE, REVOKED, REPLAYED or null',
    ],
    [
      'a denyReason on a GRANTED event',
      { edgeId: 'e', events: [edgeEvent('x-1', { denyReason: 'EXPIRED' })] },
      'events[0].denyReason is only allowed with outcome DENIED',
    ],
    [
      'a denyReason on a PENDING event',
      { edgeId: 'e', events: [edgeEvent('x-1', { outcome: 'PENDING', denyReason: 'EXPIRED' })] },
      'events[0].denyReason is only allowed with outcome DENIED',
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

describe('own attendance history (FR-1.6, UC-3)', () => {
  const push = (eventId: string, employeeId: string, occurredAt: string, changes = {}) =>
    attendance.ingest({
      edgeId: 'edge-bd',
      events: [edgeEvent(eventId, { employeeId, occurredAt, ...changes })],
    });

  beforeEach(async () => {
    await push('a-1', 'emp-1', '2026-11-06T01:00:00Z'); // 06/11, one scan
    await push('a-2', 'emp-1', '2026-11-07T01:00:00Z'); // 07/11, two scans
    await push('a-3', 'emp-1', '2026-11-07T10:00:00Z');
    await push('a-4', 'emp-1', '2026-11-08T01:00:00Z', { outcome: 'DENIED' });
    await push('a-5', 'emp-1', '2026-11-08T02:00:00Z', { outcome: 'PENDING' });
    await push('b-1', 'emp-2', '2026-11-07T02:00:00Z');
  });

  describe('AttendanceService.history', () => {
    it('lists that employee only, newest day first, with hours and missing punches', async () => {
      expect(await attendance.history('emp-1')).toEqual([
        {
          employeeId: 'emp-1',
          day: new Date('2026-11-06T17:00:00Z'),
          firstIn: new Date('2026-11-07T01:00:00Z'),
          lastOut: new Date('2026-11-07T10:00:00Z'),
          hours: 9,
          missingPunch: false,
        },
        {
          employeeId: 'emp-1',
          day: new Date('2026-11-05T17:00:00Z'),
          firstIn: new Date('2026-11-06T01:00:00Z'),
          lastOut: null,
          hours: 0,
          missingPunch: true,
        },
      ]);
    });

    it('is empty for an employee with no granted scan', async () => {
      expect(await attendance.history('emp-9')).toEqual([]);
    });
  });

  describe('GET /api/me/attendance', () => {
    const app = (user?: UserRef) =>
      createApp([
        Router().use((_req, res, next) => {
          if (user) res.locals.user = user;
          next();
        }),
        attendanceRoutes(attendance),
      ]);
    const me: UserRef = { id: 'user-1', role: 'EMP', employeeId: 'emp-2' };

    it('returns the signed-in employee history, never cached', async () => {
      const res = await request(app(me)).get('/api/me/attendance');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        records: [
          {
            employeeId: 'emp-2',
            day: '2026-11-06T17:00:00.000Z',
            firstIn: '2026-11-07T02:00:00.000Z',
            lastOut: null,
            hours: 0,
            missingPunch: true,
          },
        ],
      });
    });

    it('ignores an employeeId in the request: nobody reads another person', async () => {
      const res = await request(app(me)).get('/api/me/attendance?employeeId=emp-1');
      expect(res.body.records.map((r: { employeeId: string }) => r.employeeId)).toEqual(['emp-2']);
    });

    it.each(['SUP', 'HR', 'GRD', 'ADM', 'EXE'] as const)(
      '%s also views own attendance (report 8.6)',
      async (role) => {
        const res = await request(app({ ...me, role })).get('/api/me/attendance');
        expect(res.status).toBe(200);
        expect(res.body.records).toHaveLength(1);
      },
    );

    it('401 when not signed in', async () => {
      expect((await request(app()).get('/api/me/attendance')).status).toBe(401);
    });

    it('403 NO_EMPLOYEE for an account with no employee record', async () => {
      const res = await request(app({ id: 'user-2', role: 'ADM' })).get('/api/me/attendance');
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('NO_EMPLOYEE');
    });
  });
});

describe('HR corrections (FR-3.6, UC-8)', () => {
  const recordId = 'emp-1_2026-11-07';
  const at = (time: string) => new Date(`2026-11-07T${time}:00+07:00`);
  const hr: UserRef = { id: 'hr-1', role: 'HR' };
  const seed = (eventId: string, occurredAt: string) =>
    attendance.ingest({
      edgeId: 'edge-bd',
      events: [edgeEvent(eventId, { employeeId: 'emp-1', occurredAt })],
    });

  beforeEach(async () => {
    await seed('c-1', '2026-11-07T07:58:00+07:00'); // 07/11, one scan: a missing punch
    await seed('c-2', '2026-11-08T08:00:00+07:00'); // 08/11, a normal day
    await seed('c-3', '2026-11-08T17:00:00+07:00');
  });

  describe('AttendanceService.correct', () => {
    it('stores the value beside the scans and recomputes the record', async () => {
      const record = await attendance.correct('hr-1', recordId, {
        field: 'LAST_OUT',
        value: at('17:00'),
        reason: '  Forgot to scan out  ',
      });
      expect(record).toMatchObject({
        firstIn: at('07:58'),
        lastOut: at('17:00'),
        hours: 9.03,
        missingPunch: false,
        corrected: true,
      });
      expect(store.correctionRows).toEqual([
        {
          employeeId: 'emp-1',
          day: new Date('2026-11-06T17:00:00Z'),
          field: 'LAST_OUT',
          originalValue: null,
          correctedValue: at('17:00'),
          reason: 'Forgot to scan out',
          correctedBy: 'hr-1',
          createdAt: expect.any(Date),
        },
      ]);
    });

    it('never changes the scans', async () => {
      const before = structuredClone([...store.rows.values()]);
      await attendance.correct('hr-1', recordId, {
        field: 'FIRST_IN',
        value: at('08:00'),
        reason: 'Wrong gate clock',
      });
      expect([...store.rows.values()]).toEqual(before);
    });

    it('writes the change to the audit log, with the values before and after', async () => {
      await attendance.correct('hr-1', recordId, {
        field: 'LAST_OUT',
        value: at('17:00'),
        reason: 'Forgot to scan out',
      });
      expect(audit.entries).toEqual([
        expect.objectContaining({
          actorId: 'hr-1',
          action: 'ATTENDANCE_CORRECT',
          target: `attendance:${recordId}`,
          before: expect.objectContaining({ lastOut: null, missingPunch: true }),
          after: expect.objectContaining({
            lastOut: at('17:00'),
            missingPunch: false,
            field: 'LAST_OUT',
            reason: 'Forgot to scan out',
          }),
        }),
      ]);
    });

    it('keeps each replaced value when a day is corrected twice; the newest applies', async () => {
      const request = { field: 'LAST_OUT', reason: 'First try' } as const;
      await attendance.correct('hr-1', recordId, { ...request, value: at('17:00') });
      const record = await attendance.correct('hr-2', recordId, {
        ...request,
        value: at('18:00'),
      });
      expect(record.lastOut).toEqual(at('18:00'));
      expect(
        (await attendance.recordCorrections(recordId)).map((c) => [
          c.originalValue,
          c.correctedValue,
          c.correctedBy,
        ]),
      ).toEqual([
        [null, at('17:00'), 'hr-1'],
        [at('17:00'), at('18:00'), 'hr-2'],
      ]);
    });

    it('keeps the scan time as the original of a corrected first in', async () => {
      await attendance.correct('hr-1', recordId, {
        field: 'FIRST_IN',
        value: at('08:00'),
        reason: 'Wrong gate clock',
      });
      expect(store.correctionRows[0]?.originalValue).toEqual(at('07:58'));
    });

    it('history, dailyRecords and employeeRecords all see the corrected value', async () => {
      await attendance.correct('hr-1', recordId, {
        field: 'LAST_OUT',
        value: at('17:00'),
        reason: 'Forgot to scan out',
      });
      const expected = expect.objectContaining({
        day: new Date('2026-11-06T17:00:00Z'),
        lastOut: at('17:00'),
        corrected: true,
      });
      const range = { from: at('00:00'), to: at('23:00') };
      expect(await attendance.history('emp-1')).toContainEqual(expected);
      expect(await attendance.dailyRecords(range, 'binh-duong')).toEqual([expected]);
      expect(await attendance.employeeRecords('emp-1', range)).toEqual([
        expect.objectContaining({ recordId, lastOut: at('17:00') }),
      ]);
    });

    it('does not flag a day nobody corrected', async () => {
      await attendance.correct('hr-1', recordId, {
        field: 'LAST_OUT',
        value: at('17:00'),
        reason: 'Forgot to scan out',
      });
      const [latest] = await attendance.history('emp-1');
      expect(latest).not.toHaveProperty('corrected');
    });

    it.each([
      ['no reason (UC-8 2a)', 'LAST_OUT', '17:00', '   ', 'reason is required'],
      [
        'a reason that is too long',
        'LAST_OUT',
        '17:00',
        'x'.repeat(501),
        'reason must be at most 500 characters',
      ],
      [
        'a last out before first in',
        'LAST_OUT',
        '07:00',
        'Typo',
        'first in must be before last out',
      ],
      [
        'a last out equal to first in',
        'LAST_OUT',
        '07:58',
        'Typo',
        'first in must be before last out',
      ],
    ] as const)(
      'refuses %s, storing and auditing nothing',
      async (_name, field, time, reason, error) => {
        await expect(
          attendance.correct('hr-1', recordId, { field, value: at(time), reason }),
        ).rejects.toThrow(new InvalidCorrectionError(error));
        expect(store.correctionRows).toEqual([]);
        expect(audit.entries).toEqual([]);
      },
    );

    it('refuses a value on another day', async () => {
      await expect(
        attendance.correct('hr-1', recordId, {
          field: 'LAST_OUT',
          value: new Date('2026-11-08T00:30:00+07:00'),
          reason: 'Night shift',
        }),
      ).rejects.toThrow(new InvalidCorrectionError('value must be on the day of the record'));
      expect(store.correctionRows).toEqual([]);
    });

    describe('a value later than now', () => {
      // The clock stands at 12:00 on 07/11, the day being corrected: the shift is still open.
      const noon = at('12:00');
      const service = () =>
        new AttendanceService(
          store,
          new FakeDirectory({ 'binh-duong': ['emp-1'] }),
          audit,
          () => noon,
        );

      it('is refused, storing and auditing nothing', async () => {
        await expect(
          service().correct('hr-1', recordId, {
            field: 'LAST_OUT',
            value: at('23:59'),
            reason: 'Will leave late',
          }),
        ).rejects.toThrow(new InvalidCorrectionError('value must not be in the future'));
        expect(store.correctionRows).toEqual([]);
        expect(audit.entries).toEqual([]);
      });

      it('is accepted up to now itself', async () => {
        const record = await service().correct('hr-1', recordId, {
          field: 'LAST_OUT',
          value: noon,
          reason: 'Left at noon',
        });
        expect(record.lastOut).toEqual(noon);
      });
    });

    it('stores the correction before writing the audit entry', async () => {
      const seen: number[] = [];
      const ordered: AuditLog = {
        append: async (entry) => {
          seen.push(store.correctionRows.length);
          await audit.append(entry);
        },
        search: async () => audit.entries,
      };
      const service = new AttendanceService(
        store,
        new FakeDirectory({ 'binh-duong': ['emp-1'] }),
        ordered,
        () => NOW,
      );
      await service.correct('hr-1', recordId, {
        field: 'LAST_OUT',
        value: at('17:00'),
        reason: 'Forgot to scan out',
      });
      expect(seen).toEqual([1]);
    });

    it('removes the correction again when the audit entry cannot be written', async () => {
      await attendance.correct('hr-1', recordId, {
        field: 'FIRST_IN',
        value: at('07:30'),
        reason: 'Kept: audited',
      });
      const failing: AuditLog = {
        append: async () => {
          throw new Error('audit log down');
        },
        search: async () => [],
      };
      const service = new AttendanceService(
        store,
        new FakeDirectory({ 'binh-duong': ['emp-1'] }),
        failing,
        () => NOW,
      );
      await expect(
        service.correct('hr-1', recordId, {
          field: 'LAST_OUT',
          value: at('17:00'),
          reason: 'Forgot to scan out',
        }),
      ).rejects.toThrow('audit log down');
      // Only the earlier, audited correction is left; the day is as it was.
      expect(store.correctionRows.map((c) => c.reason)).toEqual(['Kept: audited']);
      expect(audit.entries).toHaveLength(1);
      const [day] = await attendance.history('emp-1').then((r) => r.slice(-1));
      expect(day).toMatchObject({ lastOut: null, missingPunch: true });
    });

    it.each([
      ['a day with no granted scan (UC-8 precondition)', 'emp-1_2026-11-20'],
      ['another employee', 'emp-9_2026-11-07'],
      ['a malformed ID', 'emp-1'],
      ['a date that does not exist', 'emp-1_2026-02-31'],
    ])('throws RecordNotFoundError for %s', async (_name, id) => {
      await expect(
        attendance.correct('hr-1', id, { field: 'LAST_OUT', value: at('17:00'), reason: 'x' }),
      ).rejects.toThrow(RecordNotFoundError);
      expect(audit.entries).toEqual([]);
    });
  });

  describe('routes', () => {
    const app = (user?: UserRef) =>
      createApp([
        Router().use((_req, res, next) => {
          if (user) res.locals.user = user;
          next();
        }),
        attendanceRoutes(attendance),
      ]);
    const body = { field: 'LAST_OUT', value: '2026-11-07T17:00:00+07:00', reason: 'Forgot' };
    const post = (user?: UserRef, id = recordId, send: object = body) =>
      request(app(user)).post(`/api/attendance/${id}/corrections`).send(send);
    const records = '/api/attendance/records';
    const range = 'from=2026-11-07T00:00:00%2B07:00&to=2026-11-08T00:00:00%2B07:00';

    it('POST returns 201 and the recomputed record, with the HR user as author', async () => {
      const res = await post(hr);
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        lastOut: '2026-11-07T10:00:00.000Z',
        hours: 9.03,
        missingPunch: false,
        corrected: true,
      });
      expect(store.correctionRows[0]?.correctedBy).toBe('hr-1');
    });

    it('401 when not signed in', async () => {
      expect((await post()).status).toBe(401);
      expect((await request(app()).get(`${records}?employeeId=emp-1&${range}`)).status).toBe(401);
      expect((await request(app()).get(`/api/attendance/${recordId}/corrections`)).status).toBe(
        401,
      );
    });

    it.each(['EMP', 'SUP', 'ADM', 'GRD', 'EXE'] as const)(
      '403 for %s: only HR corrects (FR-3.6, Table 8.1)',
      async (role) => {
        const user: UserRef = { id: 'u-1', role };
        expect((await post(user)).status).toBe(403);
        expect((await request(app(user)).get(`${records}?employeeId=emp-1&${range}`)).status).toBe(
          403,
        );
        expect(
          (await request(app(user)).get(`/api/attendance/${recordId}/corrections`)).status,
        ).toBe(403);
        expect(store.correctionRows).toEqual([]);
      },
    );

    it.each([
      ['no reason', { field: 'LAST_OUT', value: body.value }, 'reason is required'],
      ['a blank reason', { ...body, reason: '  ' }, 'reason is required'],
      ['a bad field', { ...body, field: 'BREAK' }, 'field must be FIRST_IN or LAST_OUT'],
      [
        'a value with no offset',
        { ...body, value: '2026-11-07T17:00' },
        'value must be an ISO date with an offset',
      ],
      [
        'a value on another day',
        { ...body, value: '2026-11-08T17:00:00+07:00' },
        'value must be on the day of the record',
      ],
      [
        'a last out before first in',
        { ...body, value: '2026-11-07T07:00:00+07:00' },
        'first in must be before last out',
      ],
    ])('400 for %s, storing nothing', async (_name, send, error) => {
      const res = await post(hr, recordId, send);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error });
      expect(store.correctionRows).toEqual([]);
    });

    it('404 for a day with no record, and for a malformed ID', async () => {
      expect((await post(hr, 'emp-1_2026-11-20')).status).toBe(404);
      expect((await post(hr, 'nonsense')).status).toBe(404);
      expect((await request(app(hr)).get('/api/attendance/nonsense/corrections')).status).toBe(404);
    });

    it('an HR user limited to another factory reaches nothing, as if it did not exist', async () => {
      const other: UserRef = { id: 'hr-2', role: 'HR', scopes: ['long-an'] };
      expect((await post(other)).status).toBe(404);
      expect(store.correctionRows).toEqual([]);
      expect(
        (await request(app(other)).get(`/api/attendance/${recordId}/corrections`)).status,
      ).toBe(404);
      const res = await request(app(other)).get(`${records}?employeeId=emp-1&${range}`);
      expect(res.body).toEqual({ records: [] });
    });

    it('an HR user limited to the factory of the employee can correct', async () => {
      expect((await post({ id: 'hr-3', role: 'HR', scopes: ['binh-duong'] })).status).toBe(201);
    });

    it('GET records lists the days in range with their IDs, never cached', async () => {
      const res = await request(app(hr)).get(`${records}?employeeId=emp-1&${range}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.records.map((r: { recordId: string }) => r.recordId)).toEqual([
        'emp-1_2026-11-07',
        'emp-1_2026-11-08',
      ]);
    });

    it.each([
      ['no employee', range, 'employeeId is required'],
      ['no range', 'employeeId=emp-1', 'from and to must be ISO dates with an offset'],
      [
        'a date with no offset',
        'employeeId=emp-1&from=2026-11-07&to=2026-11-08',
        'from and to must be ISO dates with an offset',
      ],
      [
        'a reversed range',
        'employeeId=emp-1&from=2026-11-08T00:00:00Z&to=2026-11-07T00:00:00Z',
        'from must not be after to',
      ],
    ])('GET records answers 400 for %s', async (_name, query, error) => {
      const res = await request(app(hr)).get(`${records}?${query}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error });
    });

    it('GET corrections shows the original value and the reason', async () => {
      await post(hr);
      const res = await request(app(hr)).get(`/api/attendance/${recordId}/corrections`);
      expect(res.status).toBe(200);
      expect(res.body.corrections).toEqual([
        expect.objectContaining({
          field: 'LAST_OUT',
          originalValue: null,
          correctedValue: '2026-11-07T10:00:00.000Z',
          reason: 'Forgot',
          correctedBy: 'hr-1',
        }),
      ]);
    });

    it('the employee sees the corrected day in their own history', async () => {
      await post(hr);
      const me: UserRef = { id: 'u-1', role: 'EMP', employeeId: 'emp-1' };
      const res = await request(app(me)).get('/api/me/attendance');
      expect(res.body.records).toContainEqual(
        expect.objectContaining({ day: '2026-11-06T17:00:00.000Z', corrected: true, hours: 9.03 }),
      );
    });
  });
});

describe('AttendanceService.accessLog (FR-4.4)', () => {
  const at = (iso: string) => new Date(iso);
  const day = { from: at('2026-11-07T00:00:00Z'), to: at('2026-11-08T00:00:00Z') };
  const seed = async (eventId: string, occurredAt: string, changes: Partial<ScanEvent> = {}) =>
    attendance.record({ ...scan, eventId, occurredAt: at(occurredAt), ...changes });

  it('includes occurredAt at range.from and excludes it at range.to', async () => {
    await seed('a', '2026-11-06T23:59:59.999Z');
    await seed('b', '2026-11-07T00:00:00Z');
    await seed('c', '2026-11-07T23:59:59.999Z');
    await seed('d', '2026-11-08T00:00:00Z');
    const rows = await attendance.accessLog({ range: day, limit: 10 });
    expect(rows.map((r) => r.eventId)).toEqual(['c', 'b']);
  });

  it('an empty gateIds list matches nothing and never reaches the store', async () => {
    await seed('a', '2026-11-07T01:00:00Z');
    expect(await attendance.accessLog({ range: day, gateIds: [], limit: 10 })).toEqual([]);
    expect(store.accessLogCalls).toBe(0);
  });

  it('combines gateIds and outcome', async () => {
    await seed('a', '2026-11-07T01:00:00Z', { gateId: 'g1', outcome: 'DENIED' });
    await seed('b', '2026-11-07T02:00:00Z', { gateId: 'g1' });
    await seed('c', '2026-11-07T03:00:00Z', { gateId: 'g2', outcome: 'DENIED' });
    await seed('d', '2026-11-07T04:00:00Z', { gateId: 'g3', outcome: 'DENIED' });
    const rows = await attendance.accessLog({
      range: day,
      gateIds: ['g1', 'g2'],
      outcome: 'DENIED',
      limit: 10,
    });
    expect(rows.map((r) => r.eventId)).toEqual(['c', 'a']);
  });

  it('lists newest first, equal times by eventId ascending', async () => {
    await seed('b', '2026-11-07T02:00:00Z');
    await seed('a', '2026-11-07T02:00:00Z');
    await seed('old', '2026-11-07T01:00:00Z');
    await seed('new', '2026-11-07T03:00:00Z');
    const rows = await attendance.accessLog({ range: day, limit: 10 });
    expect(rows.map((r) => r.eventId)).toEqual(['new', 'a', 'b', 'old']);
  });

  it('returns at most limit rows, the newest ones', async () => {
    await seed('a', '2026-11-07T01:00:00Z');
    await seed('b', '2026-11-07T02:00:00Z');
    await seed('c', '2026-11-07T03:00:00Z');
    const rows = await attendance.accessLog({ range: day, limit: 2 });
    expect(rows.map((r) => r.eventId)).toEqual(['c', 'b']);
  });

  it('includes DENIED and PENDING scans, as stored', async () => {
    await seed('a', '2026-11-07T01:00:00Z', { outcome: 'DENIED' });
    await seed('b', '2026-11-07T02:00:00Z');
    await attendance.setOutcome('b', 'GRANTED');
    await seed('c', '2026-11-07T03:00:00Z');
    const rows = await attendance.accessLog({ range: day, limit: 10 });
    expect(rows.map((r) => [r.eventId, r.outcome])).toEqual([
      ['c', 'PENDING'],
      ['b', 'GRANTED'],
      ['a', 'DENIED'],
    ]);
    expect(rows[0]).toMatchObject({ edgeId: null, jti: null, stale: false });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects limit %s with a RangeError',
    async (limit) => {
      await expect(attendance.accessLog({ range: day, limit })).rejects.toThrow(RangeError);
    },
  );

  it('an empty or inverted range gives no rows', async () => {
    await seed('a', '2026-11-07T01:00:00Z');
    const t = at('2026-11-07T01:00:00Z');
    expect(await attendance.accessLog({ range: { from: t, to: t }, limit: 10 })).toEqual([]);
    expect(
      await attendance.accessLog({ range: { from: day.to, to: day.from }, limit: 10 }),
    ).toEqual([]);
  });
});
