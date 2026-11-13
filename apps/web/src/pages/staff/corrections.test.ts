import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dateOfRecord,
  fetchCorrections,
  fetchEmployees,
  fetchRecords,
  submitCorrection,
  vnInstant,
} from './corrections';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const answer = (reply: () => Response) => {
  const mock = vi.fn(async (_path: string, _init?: RequestInit) => reply());
  vi.stubGlobal('fetch', mock);
  return mock;
};

afterEach(() => vi.unstubAllGlobals());

describe('times HR types are Vietnam time', () => {
  it('sends the +07:00 offset', () => {
    expect(vnInstant('2026-11-07', '17:00')).toBe('2026-11-07T17:00:00+07:00');
  });

  it('reads the date from a record ID, even when the employee ID has an underscore', () => {
    expect(dateOfRecord('emp_1_2026-11-07')).toBe('2026-11-07');
  });
});

describe('submitCorrection', () => {
  it('posts the field, the Vietnam time of that day and the reason, with the session', async () => {
    const mock = answer(() => json(201, { hours: 9 }));
    const result = await submitCorrection('s', 'emp-1_2026-11-07', 'LAST_OUT', '17:00', 'Forgot');
    expect(result).toEqual({ kind: 'ok', value: { hours: 9 } });
    const [path, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/attendance/emp-1_2026-11-07/corrections');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer s' });
    expect(JSON.parse(init.body as string)).toEqual({
      field: 'LAST_OUT',
      value: '2026-11-07T17:00:00+07:00',
      reason: 'Forgot',
    });
  });

  it.each([
    ['a rule the server refused', 400, { error: 'reason is required' }, 'reason is required'],
    [
      'a record that does not exist',
      404,
      { error: 'Daily record not found' },
      'Daily record not found',
    ],
  ])('shows the words of the server for %s', async (_name, status, body, message) => {
    answer(() => json(status, body));
    expect(await submitCorrection('s', 'r_2026-11-07', 'LAST_OUT', '17:00', 'x')).toEqual({
      kind: 'refused',
      message,
    });
  });

  it.each([
    [401, 'signed-out'],
    [403, 'denied'],
    [500, 'down'],
  ])('maps a %i to %s', async (status, kind) => {
    answer(() => json(status, {}));
    expect(await submitCorrection('s', 'r_2026-11-07', 'LAST_OUT', '17:00', 'x')).toEqual({ kind });
  });

  it('is down when there is no connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await submitCorrection('s', 'r_2026-11-07', 'LAST_OUT', '17:00', 'x')).toEqual({
      kind: 'down',
    });
  });
});

describe('reads', () => {
  it('asks for the records of whole Vietnam days', async () => {
    const mock = answer(() => json(200, { records: [{ recordId: 'r' }] }));
    const result = await fetchRecords('s', 'emp-1', '2026-11-01', '2026-11-30');
    expect(result).toEqual({ kind: 'ok', value: [{ recordId: 'r' }] });
    const query = new URLSearchParams((mock.mock.calls[0]?.[0] as string).split('?')[1]);
    expect(Object.fromEntries(query)).toEqual({
      employeeId: 'emp-1',
      from: '2026-11-01T00:00:00+07:00',
      to: '2026-11-30T00:00:00+07:00',
    });
  });

  it('reads the correction list and the employee list', async () => {
    answer(() => json(200, { corrections: [{ reason: 'x' }] }));
    expect(await fetchCorrections('s', 'r')).toEqual({ kind: 'ok', value: [{ reason: 'x' }] });
    answer(() => json(200, [{ id: 'e' }]));
    expect(await fetchEmployees('s')).toEqual({ kind: 'ok', value: [{ id: 'e' }] });
  });

  it('is down on an unexpected body', async () => {
    answer(() => json(200, { rows: [] }));
    expect(await fetchRecords('s', 'e', '2026-11-01', '2026-11-30')).toEqual({ kind: 'down' });
  });
});
