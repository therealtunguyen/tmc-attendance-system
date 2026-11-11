import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeAdmission } from '../employee-qr/index.js';
import { SyncReconciler, type SyncAlertKind, type SyncAlerts } from './attendance.reconcile.js';
import type { JtiSighting, StoredEvent } from './attendance.service.js';

type Deny = Awaited<ReturnType<EmployeeAdmission['denyOf']>>;

/** What the server knows about each employee now; anyone not listed is admitted. */
class FakeAdmission implements EmployeeAdmission {
  asked: string[] = [];
  fail = false;

  constructor(private deny: Record<string, Deny> = {}) {}

  async denyOf(id: string) {
    this.asked.push(id);
    if (this.fail) throw new Error('employee table down');
    return this.deny[id] ?? null;
  }
}

class RecordingAlerts implements SyncAlerts {
  alerts: { kind: SyncAlertKind; message: string }[] = [];
  fail = false;

  async alert(kind: SyncAlertKind, message: string) {
    if (this.fail) throw new Error('mail down');
    this.alerts.push({ kind, message });
  }
}

/** The stored events, as AttendanceRepo.eventsWithJti reads them: by jti, oldest first. */
class StoredSightings {
  rows: StoredEvent[] = [];
  queries: string[][] = [];
  fail = false;

  async eventsWithJti(jtis: string[]): Promise<JtiSighting[]> {
    this.queries.push(jtis);
    if (this.fail) throw new Error('database down');
    return this.rows
      .filter((e) => e.jti !== null && jtis.includes(e.jti))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
}

const event = (eventId: string, changes: Partial<StoredEvent> = {}): StoredEvent => ({
  eventId,
  employeeId: 'emp-1',
  gateId: 'bd-gate-1',
  method: 'QR',
  occurredAt: new Date('2026-11-07T00:58:00.000Z'),
  outcome: 'GRANTED',
  denyReason: null,
  edgeId: 'edge-bd',
  jti: `jti-${eventId}`,
  stale: false,
  ...changes,
});

let sightings: StoredSightings;
let alerts: RecordingAlerts;
let log: ReturnType<typeof vi.fn<(message: string, error: unknown) => void>>;

beforeEach(() => {
  sightings = new StoredSightings();
  alerts = new RecordingAlerts();
  log = vi.fn();
});

/** Stores the events like a push would, then reconciles them. */
const reconcile = async (
  admission: FakeAdmission,
  stored: StoredEvent[],
  edgeId = 'edge-bd',
): Promise<void> => {
  sightings.rows.push(...stored);
  await new SyncReconciler(sightings, admission, alerts, log).reconcile(edgeId, stored);
};

describe('SyncReconciler: a stale entry of someone the server denies now (#33)', () => {
  it('alerts with the employee, their state, the gate, the time and the event', async () => {
    await reconcile(new FakeAdmission({ 'emp-1': 'REVOKED' }), [event('x-1', { stale: true })]);
    expect(alerts.alerts).toHaveLength(1);
    const [{ kind, message }] = alerts.alerts as [{ kind: SyncAlertKind; message: string }];
    expect(kind).toBe('STALE_ENTRY_REVOKED');
    expect(message).toContain('Edge edge-bd synced 1 entry ');
    expect(message).toContain(
      '- employee emp-1 (REVOKED now) entered at gate bd-gate-1 at 2026-11-07T00:58:00.000Z (event x-1)',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['INACTIVE', 'UNKNOWN'] as const)('also flags an employee who is %s', async (deny) => {
    await reconcile(new FakeAdmission({ 'emp-1': deny }), [event('x-1', { stale: true })]);
    expect(alerts.alerts[0]?.message).toContain(`employee emp-1 (${deny} now)`);
  });

  it('puts every entry of one push in one alert, asking about each employee once', async () => {
    const admission = new FakeAdmission({ 'emp-1': 'REVOKED', 'emp-3': 'INACTIVE' });
    await reconcile(admission, [
      event('x-1', { stale: true }),
      event('x-2', { stale: true, occurredAt: new Date('2026-11-07T10:00:00.000Z') }),
      event('x-3', { stale: true, employeeId: 'emp-2' }),
      event('x-4', { stale: true, employeeId: 'emp-3' }),
    ]);
    expect(alerts.alerts).toHaveLength(1);
    const lines = alerts.alerts[0]!.message.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => /\(event (.+)\)$/.exec(l)?.[1])).toEqual(['x-1', 'x-2', 'x-4']);
    expect(alerts.alerts[0]!.message).toContain('synced 3 entries ');
    expect([...admission.asked].sort()).toEqual(['emp-1', 'emp-2', 'emp-3']);
  });

  it.each([
    ['the employee is still admitted', {}, { stale: true }],
    ['the event is not stale', { 'emp-1': 'REVOKED' }, { stale: false }],
    ['the scan was denied', { 'emp-1': 'REVOKED' }, { stale: true, outcome: 'DENIED' }],
    ['the scan is still pending', { 'emp-1': 'REVOKED' }, { stale: true, outcome: 'PENDING' }],
    ['the event names no employee', { 'emp-1': 'REVOKED' }, { stale: true, employeeId: null }],
  ] as [string, Record<string, Deny>, Partial<StoredEvent>][])(
    'says nothing when %s',
    async (_name, deny, changes) => {
      await reconcile(new FakeAdmission(deny), [event('x-1', changes)]);
      expect(alerts.alerts).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('does not look anyone up when no entry is stale', async () => {
    const admission = new FakeAdmission({ 'emp-1': 'REVOKED' });
    await reconcile(admission, [event('x-1'), event('x-2', { stale: true, outcome: 'DENIED' })]);
    expect(admission.asked).toEqual([]);
  });
});

describe('SyncReconciler: one token at two edges (#33)', () => {
  const atOtherEdge = event('la-1', {
    edgeId: 'edge-la',
    gateId: 'la-gate-1',
    jti: 'jti-shared',
    occurredAt: new Date('2026-11-07T00:58:20.000Z'),
  });

  it('alerts with every use of the token, oldest first', async () => {
    sightings.rows.push(atOtherEdge);
    await reconcile(new FakeAdmission(), [
      event('bd-1', { jti: 'jti-shared', occurredAt: new Date('2026-11-07T00:58:05.000Z') }),
    ]);
    expect(alerts.alerts).toEqual([
      {
        kind: 'QR_USED_AT_TWO_EDGES',
        message: [
          'Edge edge-bd synced 1 QR token that another edge has also seen. A token is made for one use, so it may have been copied.',
          '- token jti-shared: edge edge-bd, gate bd-gate-1, 2026-11-07T00:58:05.000Z, GRANTED, employee emp-1; edge edge-la, gate la-gate-1, 2026-11-07T00:58:20.000Z, GRANTED, employee emp-1',
        ].join('\n'),
      },
    ]);
  });

  it('counts a denied use too', async () => {
    sightings.rows.push({ ...atOtherEdge, outcome: 'DENIED', denyReason: 'EXPIRED' });
    await reconcile(new FakeAdmission(), [event('bd-1', { jti: 'jti-shared' })]);
    expect(alerts.alerts[0]?.kind).toBe('QR_USED_AT_TWO_EDGES');
    expect(alerts.alerts[0]?.message).toContain('DENIED');
  });

  it('says nothing about a token one edge saw twice: that edge already denied the replay', async () => {
    await reconcile(new FakeAdmission(), [
      event('bd-1', { jti: 'jti-shared' }),
      event('bd-2', { jti: 'jti-shared', outcome: 'DENIED', denyReason: 'REPLAYED' }),
    ]);
    expect(alerts.alerts).toEqual([]);
    expect(sightings.queries).toEqual([['jti-shared']]);
  });

  it('lists only the shared tokens of a push', async () => {
    sightings.rows.push(atOtherEdge);
    await reconcile(new FakeAdmission(), [
      event('bd-1', { jti: 'jti-shared' }),
      event('bd-2'),
      event('bd-3'),
    ]);
    const lines = alerts.alerts[0]!.message.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('token jti-shared');
    expect(sightings.queries).toEqual([['jti-shared', 'jti-bd-2', 'jti-bd-3']]);
  });

  it('does not read the store when no event has a token (MANUAL)', async () => {
    await reconcile(new FakeAdmission(), [event('m-1', { method: 'MANUAL', jti: null })]);
    expect(sightings.queries).toEqual([]);
    expect(alerts.alerts).toEqual([]);
  });
});

describe('SyncReconciler: failures never reach the push (#33)', () => {
  const both = () => {
    sightings.rows.push(event('la-1', { edgeId: 'edge-la', jti: 'jti-shared' }));
    return [event('bd-1', { stale: true, jti: 'jti-shared' })];
  };

  it('sends both findings of one push as two alerts', async () => {
    await reconcile(new FakeAdmission({ 'emp-1': 'REVOKED' }), both());
    expect(alerts.alerts.map((a) => a.kind)).toEqual([
      'STALE_ENTRY_REVOKED',
      'QR_USED_AT_TWO_EDGES',
    ]);
  });

  it('logs an alert that cannot be sent, and resolves', async () => {
    alerts.fail = true;
    await expect(
      reconcile(new FakeAdmission({ 'emp-1': 'REVOKED' }), both()),
    ).resolves.toBeUndefined();
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'Sync reconciliation: the STALE_ENTRY_REVOKED check of a push from edge edge-bd failed',
      'Sync reconciliation: the QR_USED_AT_TWO_EDGES check of a push from edge edge-bd failed',
    ]);
    expect(log.mock.calls[0]![1]).toEqual(new Error('mail down'));
  });

  it('still checks the tokens when the employee lookup fails', async () => {
    const admission = new FakeAdmission({ 'emp-1': 'REVOKED' });
    admission.fail = true;
    await reconcile(admission, both());
    expect(alerts.alerts.map((a) => a.kind)).toEqual(['QR_USED_AT_TWO_EDGES']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toEqual(new Error('employee table down'));
  });

  it('still reports the stale entry when the token lookup fails', async () => {
    sightings.fail = true;
    await reconcile(new FakeAdmission({ 'emp-1': 'REVOKED' }), both());
    expect(alerts.alerts.map((a) => a.kind)).toEqual(['STALE_ENTRY_REVOKED']);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
