import { afterEach, describe, expect, it, vi } from 'vitest';
import { HrsHttpClient } from './http.js';

const batch = { month: '2026-10', rows: [{ id: 'E1', hours: 8 }] };

function stubStatus(status: number) {
  const fetchMock = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('HrsHttpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([200, 201])('maps %i to ACCEPTED and posts the batch with a signal', async (status) => {
    const fetchMock = stubStatus(status);
    expect(await new HrsHttpClient('http://hrs').send(batch)).toBe('ACCEPTED');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://hrs/attendance-batches');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(batch);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 404, 422])('maps %i to REJECTED (permanent)', async (status) => {
    stubStatus(status);
    expect(await new HrsHttpClient('http://hrs').send(batch)).toBe('REJECTED');
  });

  it.each([408, 429, 500, 502, 503])('throws on %i so the job retries', async (status) => {
    stubStatus(status);
    await expect(new HrsHttpClient('http://hrs').send(batch)).rejects.toThrow(
      `HRS answered ${status}`,
    );
  });

  it('throws on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(new HrsHttpClient('http://hrs').send(batch)).rejects.toThrow('fetch failed');
  });

  it('throws a clear error when HRS does not answer in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    await expect(new HrsHttpClient('http://hrs', 20).send(batch)).rejects.toThrow(
      'HRS did not answer within 20 ms',
    );
  });
});
