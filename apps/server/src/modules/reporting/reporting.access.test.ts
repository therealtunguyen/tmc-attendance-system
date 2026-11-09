import { describe, expect, it } from 'vitest';
import type { UserRef } from '../iam/index.js';
import { AccessLogGateNotFoundError, AccessLogService } from './reporting.access.js';
import { FakeAccessSource, FakeGateLookup, FakeRoster } from './reporting.fakes.js';
import type { AccessFixture } from './reporting.fakes.js';

const RANGE = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z') };
const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h));
const event = (id: string, extra: Partial<AccessFixture> = {}): AccessFixture => ({
  eventId: id,
  gateId: 'gate-bd-1',
  employeeId: 'e-cut',
  method: 'QR',
  outcome: 'GRANTED',
  denyReason: null,
  guardId: null,
  reason: null,
  occurredAt: at(8),
  ...extra,
});
const grd = (scopes?: string[]): UserRef => ({ id: 'g', role: 'GRD', scopes });

const setup = (events: AccessFixture[] = [event('ev-1')]) => {
  const source = new FakeAccessSource(events);
  const gates = new FakeGateLookup();
  const roster = new FakeRoster();
  return { source, gates, roster, service: new AccessLogService(source, gates, roster) };
};

describe('AccessLogService', () => {
  it('unrestricted viewer sees every gate and sends no gateIds filter', async () => {
    const { service, source, gates } = setup([
      event('ev-1'),
      event('ev-2', { gateId: 'gate-la-1', occurredAt: at(9) }),
    ]);
    const rows = await service.list(grd(), { range: RANGE, limit: 100 });
    expect(rows.map((r) => r.eventId)).toEqual(['ev-2', 'ev-1']);
    expect(gates.calls).toEqual([undefined]);
    expect(source.queries[0]).not.toHaveProperty('gateIds');
    expect(source.queries[0]).not.toHaveProperty('outcome');
  });

  it('a scoped GRD gets only the gates of the factory, inactive ones included', async () => {
    const { service, source } = setup([event('ev-1'), event('ev-2', { gateId: 'gate-la-1' })]);
    const rows = await service.list(grd(['binh-duong']), { range: RANGE, limit: 100 });
    expect(source.queries[0]!.gateIds).toEqual(['gate-bd-1', 'gate-bd-old']);
    expect(rows.map((r) => r.eventId)).toEqual(['ev-1']);
    expect(rows[0]).toMatchObject({ gateName: 'BD main gate', factoryId: 'binh-duong' });
  });

  it('narrows to one visible gate', async () => {
    const { service, source } = setup();
    await service.list(grd(['binh-duong']), { range: RANGE, gateId: 'gate-bd-old', limit: 5 });
    expect(source.queries[0]!.gateIds).toEqual(['gate-bd-old']);
  });

  it('answers the same for a gate of another factory and for an unknown gate', async () => {
    const { service, source } = setup();
    for (const gateId of ['gate-la-1', 'nope']) {
      await expect(
        service.list(grd(['binh-duong']), { range: RANGE, gateId, limit: 5 }),
      ).rejects.toBeInstanceOf(AccessLogGateNotFoundError);
    }
    await expect(
      service.list(grd(), { range: RANGE, gateId: 'nope', limit: 5 }),
    ).rejects.toBeInstanceOf(AccessLogGateNotFoundError);
    expect(source.queries).toEqual([]);
  });

  it('a restricted viewer with no gates gets [] and the source is not called', async () => {
    const { service, source, roster } = setup();
    for (const scopes of [[], ['nowhere']]) {
      expect(await service.list(grd(scopes), { range: RANGE, limit: 100 })).toEqual([]);
    }
    expect(source.queries).toEqual([]);
    expect(roster.calls).toEqual([]);
  });

  it('shows the deny reason of denied scans', async () => {
    const { service } = setup([event('ev-1', { outcome: 'DENIED', denyReason: 'REVOKED' })]);
    const [row] = await service.list(grd(), { range: RANGE, limit: 100 });
    expect(row).toMatchObject({ outcome: 'DENIED', denyReason: 'REVOKED' });
  });

  it('returns the guard and written reason of a MANUAL override, null for QR scans', async () => {
    const { service } = setup([
      event('ev-qr'),
      event('ev-man', { method: 'MANUAL', guardId: 'guard-1', reason: 'Forgot phone at home' }),
    ]);
    const rows = await service.list(grd(), { range: RANGE, limit: 100 });
    expect(rows.find((r) => r.eventId === 'ev-man')).toMatchObject({
      method: 'MANUAL',
      outcome: 'GRANTED',
      guardId: 'guard-1',
      overrideReason: 'Forgot phone at home',
    });
    expect(rows.find((r) => r.eventId === 'ev-qr')).toMatchObject({
      guardId: null,
      overrideReason: null,
    });
  });

  it('keeps the deny reason of a denied QR scan apart from the override reason', async () => {
    const { service } = setup([event('ev-1', { outcome: 'DENIED', denyReason: 'REVOKED' })]);
    const [row] = await service.list(grd(), { range: RANGE, limit: 100 });
    expect(row).toMatchObject({ denyReason: 'REVOKED', guardId: null, overrideReason: null });
  });

  it('gives null code and name for no employee and for an unknown one', async () => {
    const { service } = setup([
      event('ev-1', { employeeId: null, outcome: 'DENIED', denyReason: 'INVALID_SIGNATURE' }),
      event('ev-2', { employeeId: 'ghost' }),
    ]);
    const rows = await service.list(grd(), { range: RANGE, limit: 100 });
    for (const row of rows) expect(row).toMatchObject({ employeeCode: null, firstName: null });
  });

  it('names an employee of another factory (roster is read without a scope)', async () => {
    const { service, roster } = setup([event('ev-1', { employeeId: 'e-pack' })]);
    const [row] = await service.list(grd(['binh-duong']), { range: RANGE, limit: 100 });
    expect(row).toMatchObject({ employeeCode: 'E-PACK', firstName: 'Lan' });
    expect(roster.calls).toEqual([undefined]);
  });

  it('exposes exactly twelve fields, never the last name', async () => {
    const { service } = setup();
    const [row] = await service.list(grd(), { range: RANGE, limit: 100 });
    expect(Object.keys(row!).sort()).toEqual(
      [
        'denyReason',
        'employeeCode',
        'eventId',
        'factoryId',
        'firstName',
        'gateId',
        'gateName',
        'guardId',
        'method',
        'occurredAt',
        'outcome',
        'overrideReason',
      ].sort(),
    );
  });

  it('reads the roster once for many events, and not at all without employees', async () => {
    const many = setup([event('ev-1'), event('ev-2'), event('ev-3', { employeeId: 'e-sew' })]);
    await many.service.list(grd(), { range: RANGE, limit: 100 });
    expect(many.roster.calls).toHaveLength(1);

    const none = setup([event('ev-1', { employeeId: null })]);
    await none.service.list(grd(), { range: RANGE, limit: 100 });
    expect(none.roster.calls).toEqual([]);
  });

  it('passes outcome, range and limit to the source', async () => {
    const { service, source } = setup();
    await service.list(grd(), { range: RANGE, outcome: 'DENIED', limit: 7 });
    expect(source.queries[0]).toEqual({ range: RANGE, outcome: 'DENIED', limit: 7 });
  });

  it('uses null gate fields for a gate it does not know', async () => {
    const { service } = setup([event('ev-1', { gateId: 'gate-gone' })]);
    const [row] = await service.list(grd(), { range: RANGE, limit: 100 });
    expect(row).toMatchObject({ gateName: null, factoryId: null });
  });
});
