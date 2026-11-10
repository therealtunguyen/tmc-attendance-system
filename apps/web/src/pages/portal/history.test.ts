import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHistory, formatDay, formatTime, type Profile } from './history';

const profile: Profile = {
  code: 'BD-0001',
  firstName: 'Lan',
  lastName: 'Nguyen',
  email: 'lan@example.com',
  factoryId: 'binh-duong',
  teamId: null,
};
const record = {
  day: '2026-11-06T17:00:00.000Z',
  firstIn: '2026-11-07T00:58:00.000Z',
  lastOut: null,
  hours: 0,
  missingPunch: true,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers each path; a path with no answer stands for no connection. */
const answer = (byPath: Record<string, () => Response>) => {
  const mock = vi.fn(async (path: string, _init?: RequestInit) => {
    const reply = byPath[path];
    if (!reply) throw new Error(`no connection: ${path}`);
    return reply();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
};

afterEach(() => vi.unstubAllGlobals());

describe('fetchHistory', () => {
  it('returns the profile and records, sending the session token', async () => {
    const mock = answer({
      '/api/me/profile': () => json(200, profile),
      '/api/me/attendance': () => json(200, { records: [record] }),
    });
    expect(await fetchHistory('s')).toEqual({ kind: 'ok', profile, records: [record] });
    expect(mock.mock.calls[0]?.[1]?.headers).toEqual({ authorization: 'Bearer s' });
  });

  it('is signed out when either answers 401', async () => {
    answer({
      '/api/me/profile': () => json(200, profile),
      '/api/me/attendance': () => json(401, {}),
    });
    expect(await fetchHistory('s')).toEqual({ kind: 'signed-out' });
  });

  it.each([
    ['no linked employee', { reason: 'NO_EMPLOYEE' }, 'NO_EMPLOYEE'],
    ['a privacy-notice block', { code: 'NOTICE_REQUIRED', version: 1 }, 'NOTICE_REQUIRED'],
    ['a permission check', { error: 'Forbidden' }, 'OTHER'],
  ])('treats a 403 with %s as a denial', async (_name, body, reason) => {
    answer({
      '/api/me/profile': () => json(403, body),
      '/api/me/attendance': () => json(403, body),
    });
    expect(await fetchHistory('s')).toEqual({ kind: 'denied', reason });
  });

  it('treats a 403 that is not JSON as a denial, not as no connection', async () => {
    answer({
      '/api/me/profile': () => new Response('<html>Forbidden</html>', { status: 403 }),
      '/api/me/attendance': () => json(200, { records: [] }),
    });
    expect(await fetchHistory('s')).toEqual({ kind: 'denied', reason: 'OTHER' });
  });

  it.each([
    ['no connection', {}],
    [
      'a server error',
      {
        '/api/me/profile': () => json(500, {}),
        '/api/me/attendance': () => json(200, { records: [] }),
      },
    ],
    [
      'an unexpected body',
      {
        '/api/me/profile': () => json(200, profile),
        '/api/me/attendance': () => json(200, { rows: [] }),
      },
    ],
  ])('is down on %s', async (_name, byPath) => {
    answer(byPath);
    expect(await fetchHistory('s')).toEqual({ kind: 'down' });
  });
});

describe('dates are shown in Vietnam time, wherever the device is', () => {
  it('names the local day from its UTC start', () => {
    expect(formatDay('2026-11-06T17:00:00.000Z')).toBe('07/11/2026');
  });

  it('shows the time at UTC+7, on a 24-hour clock', () => {
    expect(formatTime('2026-11-07T00:58:00.000Z')).toBe('07:58');
    expect(formatTime('2026-11-07T10:03:00.000Z')).toBe('17:03');
    expect(formatTime('2026-11-06T17:00:00.000Z')).toBe('00:00');
  });

  it('shows a dash for a missing time', () => {
    expect(formatTime(null)).toBe('–');
  });
});
