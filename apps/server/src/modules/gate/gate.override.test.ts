import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { AttendanceService, type StoredEvent } from '../attendance/index.js';
import type { UserRef } from '../iam/index.js';
import { entrance, InMemoryGates, RecordingGateAudit } from './gate.fakes.js';
import { gateRoutes } from './gate.routes.js';
import { GateService } from './gate.service.js';

const now = new Date('2026-11-08T10:00:00Z');
let events: Map<string, StoredEvent>;
let store: InMemoryGates;
let audit: RecordingGateAudit;
let open: ReturnType<typeof vi.fn<() => Promise<'OPENED' | 'ERROR' | 'TIMEOUT'>>>;
let employeeActive: boolean;
let user: UserRef | undefined;
let gateId: string;
let app: ReturnType<typeof createApp>;
const body = { eventId: 'manual-1', employeeId: 'emp-1', reason: 'Phone broken', mode: 'OPEN' };

beforeEach(async () => {
  events = new Map();
  store = new InMemoryGates();
  audit = new RecordingGateAudit();
  open = vi.fn(async () => 'OPENED' as const);
  employeeActive = true;
  user = { id: 'guard-1', role: 'GRD', scopes: ['binh-duong'] };
  const directory = {
    find: async (id: string) =>
      id === 'emp-1' ? { id, firstName: 'An', lastName: 'Nguyen', active: employeeActive } : null,
    list: async () => [],
  };
  const attendance = new AttendanceService(
    {
      insert: async (event) => {
        if (events.has(event.eventId)) return false;
        events.set(event.eventId, { ...event });
        return true;
      },
      insertMany: async () => {},
      grantedEvents: async () => [],
      decide: async (id, outcome) => {
        const event = events.get(id);
        if (!event || (event.outcome !== 'PENDING' && event.outcome !== outcome)) return false;
        event.outcome = outcome;
        return true;
      },
      outcomeOf: async (id) => events.get(id)?.outcome ?? null,
    },
    directory,
  );
  const gate = new GateService(
    store,
    { validate: vi.fn() },
    attendance,
    { open },
    { get: vi.fn(), orgUnits: vi.fn() },
    { alert: vi.fn() },
    audit,
    { now: () => now, directory },
  );
  gateId = (await store.create(entrance)).id;
  app = createApp([gateRoutes(gate)], {
    before: [
      (_req, res, next) => {
        res.locals.user = user;
        next();
      },
    ],
  });
});

const submit = (input: object = body) =>
  request(app).post(`/api/gates/${gateId}/override`).send(input);

describe('Manual override (FR-2.5, UC-4)', () => {
  it('stores guard/reason and audits before opening the registered turnstile', async () => {
    open.mockImplementationOnce(async () => {
      expect(events.get(body.eventId)).toMatchObject({ outcome: 'PENDING', guardId: 'guard-1' });
      expect(audit.entries).toHaveLength(1);
      return 'OPENED';
    });
    expect((await submit()).body).toEqual({ eventId: body.eventId, outcome: 'GRANTED' });
    expect(open).toHaveBeenCalledWith(entrance.turnstileId);
    expect(events.get(body.eventId)).toMatchObject({
      method: 'MANUAL',
      employeeId: 'emp-1',
      gateId,
      guardId: 'guard-1',
      reason: body.reason,
      occurredAt: now,
      outcome: 'GRANTED',
    });
    expect(audit.entries[0]).toMatchObject({
      actorId: 'guard-1',
      action: 'GATE_OVERRIDE',
      target: `attendance-event:${body.eventId}`,
      after: { reason: body.reason, gateId, occurredAt: now.toISOString(), mode: 'OPEN' },
    });
  });

  it.each(['ERROR', 'TIMEOUT'] as const)(
    'records DENIED when TCS returns %s without retrying',
    async (result) => {
      open.mockResolvedValue(result);
      expect((await submit()).body.outcome).toBe('DENIED');
      expect(events.get(body.eventId)?.outcome).toBe('DENIED');
      expect(open).toHaveBeenCalledTimes(1);
      expect(audit.entries).toHaveLength(1);
    },
  );

  it('backfills a physical admission even when the edge is offline, preserving the actual time', async () => {
    await store.deactivate(gateId);
    employeeActive = false;
    const occurredAt = '2026-11-07T07:30:00+07:00';
    expect((await submit({ ...body, mode: 'BACKFILL', occurredAt })).status).toBe(201);
    expect(events.get(body.eventId)).toMatchObject({
      outcome: 'GRANTED',
      occurredAt: new Date(occurredAt),
    });
    expect(audit.entries[0]?.after).toMatchObject({ mode: 'BACKFILL' });
    expect(open).not.toHaveBeenCalled();
  });

  it('does not repeat an event, audit or physical open on concurrent retries', async () => {
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    expect((await submit({ ...body, reason: 'Different payload' })).status).toBe(409);
    expect(events.size).toBe(1);
    expect(audit.entries).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps PENDING and never opens if audit fails; a retry cannot bypass the failure', async () => {
    vi.spyOn(audit, 'append').mockRejectedValue(new Error('Audit unavailable'));
    expect((await submit()).status).toBe(500);
    expect(events.get(body.eventId)?.outcome).toBe('PENDING');
    expect((await submit()).status).toBe(409);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: 'admin', role: 'ADM' }, { id: 'employee', role: 'EMP' }] as const)(
    'requires a signed-in guard (%j)',
    async (actor) => {
      user = actor;
      expect((await submit()).status).toBe(actor ? 403 : 401);
      expect(events.size).toBe(0);
    },
  );

  it('rejects a guard outside the factory scope', async () => {
    user = { id: 'guard-2', role: 'GRD', scopes: ['long-an'] };
    expect((await submit()).status).toBe(404);
    expect(events.size).toBe(0);
  });

  it.each([
    { reason: '  ' },
    { employeeId: '' },
    { eventId: '' },
    { mode: 'INVALID' },
    { guardId: 'someone-else' },
    { occurredAt: now.toISOString() },
    { mode: 'BACKFILL' },
    { mode: 'BACKFILL', occurredAt: '2026-11-07' },
    { mode: 'BACKFILL', occurredAt: '2026-02-31T10:00:00Z' },
    { mode: 'BACKFILL', occurredAt: '2026-11-09T10:00:00Z' },
  ])('rejects invalid fields %j before writing', async (changes) => {
    expect((await submit({ ...body, ...changes })).status).toBe(400);
    expect(events.size).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses an unknown employee', async () => {
    expect((await submit({ ...body, employeeId: 'missing' })).status).toBe(404);
    expect(events.size).toBe(0);
  });

  it('refuses opening an inactive employee or gate', async () => {
    employeeActive = false;
    expect((await submit()).status).toBe(409);
    employeeActive = true;
    await store.deactivate(gateId);
    expect((await submit()).status).toBe(409);
    expect(events.size).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });
});
