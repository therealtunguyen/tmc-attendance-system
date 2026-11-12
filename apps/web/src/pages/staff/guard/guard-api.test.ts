import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgePrivacyNotice,
  fetchPrivacyNotice,
  fetchAccessLog,
  fetchGuardGates,
  logQuery,
  submitOverride,
  vietnamDay,
  type AccessRow,
  type LogFilters,
  type OverrideInput,
} from './guard-api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const filters: LogFilters = { from: '2026-11-11', through: '2026-11-11', gateId: '', outcome: '' };
const gate = {
  id: 'g1',
  name: 'Main gate',
  factoryId: 'bd',
  active: true,
  direction: 'IN',
  status: 'OFFLINE',
};
const row: AccessRow = {
  eventId: 'e1',
  occurredAt: '2026-11-11T01:00:00Z',
  gateId: 'g1',
  gateName: 'Main gate',
  factoryId: 'bd',
  method: 'QR',
  outcome: 'DENIED',
  denyReason: 'REVOKED',
  guardId: null,
  overrideReason: null,
  employeeCode: 'BD-001',
  firstName: 'An',
};
const input: OverrideInput = {
  eventId: 'manual-1',
  employeeId: 'emp-1',
  reason: 'Phone broken',
  mode: 'OPEN',
};

afterEach(() => vi.unstubAllGlobals());

describe('Vietnam access-log range', () => {
  it('uses Vietnam midnight boundaries, including the entire through day', () => {
    const query = logQuery({ ...filters, gateId: 'g&1', outcome: 'DENIED' })!;
    expect(Object.fromEntries(query)).toEqual({
      from: '2026-11-10T17:00:00.000Z',
      to: '2026-11-11T17:00:00.000Z',
      limit: '500',
      gateId: 'g&1',
      outcome: 'DENIED',
    });
    expect(vietnamDay(new Date('2026-11-10T18:00:00Z'))).toBe('2026-11-11');
    expect(logQuery(filters)!.has('gateId')).toBe(false);
    expect(logQuery(filters)!.has('outcome')).toBe(false);
  });
  it.each([
    { from: '' },
    { from: '2026-02-30' },
    { from: '2026-11-12' },
    { from: '2026-10-11' },
    { through: 'invalid' },
  ])('rejects invalid or too-wide ranges %j', (changes) => {
    expect(logQuery({ ...filters, ...changes })).toBeNull();
  });
  it('accepts exactly 31 inclusive days', () => {
    expect(logQuery({ ...filters, from: '2026-10-12' })).not.toBeNull();
  });
});

describe('guard access', () => {
  it('verifies the server role before loading assigned gates, including inactive gates', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, { role: 'GRD' }))
      .mockResolvedValueOnce(json(200, [gate, { ...gate, id: 'old', active: false }]));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchGuardGates('guard-token')).toMatchObject({
      kind: 'ok',
      data: [gate, { id: 'old', active: false }],
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me', '/api/gates']);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        headers: { authorization: 'Bearer guard-token' },
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      });
    }
  });
  it.each(['EMP', 'ADM', 'HR', 'SUP', 'EXE'])('does not load guard data for %s', async (role) => {
    const fetch = vi.fn().mockResolvedValue(json(200, { role }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchGuardGates('s')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('guard access'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('handles an expired session and a privacy-notice block', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { role: 'GRD' }))
      .mockResolvedValueOnce(json(403, { code: 'NOTICE_REQUIRED' }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchGuardGates('s')).toEqual({ kind: 'signed-out' });
    expect(await fetchGuardGates('s')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('privacy notice'),
    });
  });
});

describe('access log', () => {
  it('loads filtered events with authentication', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { rows: [row] }));
    vi.stubGlobal('fetch', fetch);
    const query = logQuery(filters)!;
    expect(await fetchAccessLog('s', query)).toEqual({ kind: 'ok', data: [row] });
    expect(fetch).toHaveBeenCalledWith(
      `/api/access-log?${query}`,
      expect.objectContaining({ headers: { authorization: 'Bearer s' } }),
    );
  });
  it('supports an empty log', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { rows: [] })));
    expect(await fetchAccessLog('s', logQuery(filters)!)).toEqual({ kind: 'ok', data: [] });
  });
  it.each([
    { rows: [{}] },
    { rows: [{ ...row, occurredAt: 'bad' }] },
    { rows: [{ ...row, outcome: 'OPENED' }] },
    {},
    null,
  ])('rejects malformed responses %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, body)));
    expect(await fetchAccessLog('s', logQuery(filters)!)).toMatchObject({ kind: 'error' });
  });
  it('handles network failure and expired sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(json(401, {})),
    );
    expect(await fetchAccessLog('s', logQuery(filters)!)).toMatchObject({ kind: 'error' });
    expect(await fetchAccessLog('s', logQuery(filters)!)).toEqual({ kind: 'signed-out' });
  });
});

describe('override request', () => {
  it.each(['GRANTED', 'DENIED'])(
    'uses the authenticated API and respects outcome %s',
    async (outcome) => {
      const fetch = vi.fn().mockResolvedValue(json(201, { eventId: input.eventId, outcome }));
      vi.stubGlobal('fetch', fetch);
      expect(await submitOverride('s', 'gate/1', input)).toEqual({ kind: 'decided', outcome });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        '/api/gates/gate%2F1/override',
        expect.objectContaining({
          method: 'POST',
          headers: { authorization: 'Bearer s', 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: expect.any(AbortSignal),
        }),
      );
    },
  );
  it('preserves the backfill timestamp and mode', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json(201, { eventId: input.eventId, outcome: 'GRANTED' }));
    vi.stubGlobal('fetch', fetch);
    const backfill = {
      ...input,
      mode: 'BACKFILL' as const,
      occurredAt: '2026-11-10T00:00:00.000Z',
    };
    await submitOverride('s', 'g1', backfill);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(backfill);
  });
  it.each([500, 502, 504])('treats HTTP %s as unknown and never retries', async (status) => {
    const fetch = vi.fn().mockResolvedValue(json(status, { error: 'Failed' }));
    vi.stubGlobal('fetch', fetch);
    expect(await submitOverride('s', 'g1', input)).toEqual({ kind: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports an inactive gate/employee as a definite pre-write rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(409, { error: 'Gate and employee must be active' })),
    );
    expect(await submitOverride('s', 'g1', input)).toEqual({
      kind: 'rejected',
      message: 'Gate and employee must be active',
    });
  });
  it.each([
    { error: 'Event already recorded; do not repeat the override' },
    { error: 'Future conflict' },
    {},
  ])('keeps a duplicate or unrecognized 409 unknown: %j', async (body) => {
    const fetch = vi.fn().mockResolvedValue(json(409, body));
    vi.stubGlobal('fetch', fetch);
    expect(await submitOverride('s', 'g1', input)).toEqual({ kind: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    {},
    { eventId: 'wrong', outcome: 'GRANTED' },
    { eventId: input.eventId, outcome: 'PENDING' },
  ])('treats an unconfirmed response as unknown: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(201, body)));
    expect(await submitOverride('s', 'g1', input)).toEqual({ kind: 'unknown' });
  });
  it('keeps a timeout unknown rather than declaring failure or retrying', async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    vi.stubGlobal('fetch', fetch);
    expect(await submitOverride('s', 'g1', input)).toEqual({ kind: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([400, 403, 404])('reports a definite rejection for HTTP %s', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(status, { error: 'Employee not found' })),
    );
    expect(await submitOverride('s', 'g1', input)).toMatchObject({ kind: 'rejected' });
  });
  it('ends an expired session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, {})));
    expect(await submitOverride('s', 'g1', input)).toEqual({ kind: 'signed-out' });
  });
});

describe('guard privacy notice', () => {
  it('loads the current text and version without requesting personal data', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { version: 2, text: 'Test notice' }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchPrivacyNotice('s')).toEqual({
      kind: 'ok',
      data: { version: 2, text: 'Test notice' },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/privacy-notice');
  });
  it.each([{}, { version: 0, text: 'Bad' }, { version: 1, text: 123 }])(
    'refuses malformed notice %j',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, body)));
      expect(await fetchPrivacyNotice('s')).toMatchObject({ kind: 'error' });
    },
  );
  it('acknowledges the displayed version with the signed-in identity', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    expect(await acknowledgePrivacyNotice('s', 2)).toEqual({ kind: 'ok', data: null });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/privacy-notice/ack',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer s', 'content-type': 'application/json' },
        body: '{"version":2}',
      }),
    );
  });
  it('leaves a stale notice unacknowledged so the guard must reload it', async () => {
    const fetch = vi.fn().mockResolvedValue(json(409, { error: 'Notice has changed' }));
    vi.stubGlobal('fetch', fetch);
    expect(await acknowledgePrivacyNotice('s', 1)).toMatchObject({
      kind: 'error',
      message: 'Notice has changed',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves NOTICE_REQUIRED on reads and rejected overrides for the review UI', async () => {
    const fetch = vi.fn().mockImplementation(async () => json(403, { code: 'NOTICE_REQUIRED' }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchAccessLog('s', logQuery(filters)!)).toMatchObject({
      kind: 'error',
      code: 'NOTICE_REQUIRED',
    });
    expect(await submitOverride('s', 'g1', input)).toMatchObject({
      kind: 'rejected',
      code: 'NOTICE_REQUIRED',
    });
  });
});
