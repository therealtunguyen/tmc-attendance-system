import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TcsHttpClient } from './http.js';
import { MockTurnstile } from './mock.js';

describe('MockTurnstile', () => {
  it('returns the result for each mode', async () => {
    expect(await new MockTurnstile('open').open()).toBe('OPENED');
    expect(await new MockTurnstile('fail').open()).toBe('ERROR');
    expect(await new MockTurnstile('slow', 10).open()).toBe('TIMEOUT');
  });
});

describe('TcsHttpClient', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // A TCS that never answers.
    server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('returns TIMEOUT after 1 s instead of throwing', async () => {
    const start = Date.now();
    expect(await new TcsHttpClient(baseUrl).open('T1')).toBe('TIMEOUT');
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('returns ERROR when TCS is unreachable', async () => {
    expect(await new TcsHttpClient('http://localhost:1').open('T1')).toBe('ERROR');
  });
});
