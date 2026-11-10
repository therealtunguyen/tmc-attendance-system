// HTTP kiosk API tests for the edge agent (#29, #41).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import {
  createTempDb,
  generatePair,
  issueToken,
  makeLoadedSnapshots,
  makeSnapshot,
} from './helpers.js';

let db: Db;
let cleanup: () => void;
let server: Server | null = null;
const { privateKey, publicKey } = generatePair();
const employee = { id: 'emp-1', firstName: 'Lan', deny: null as null };

const startServer = async (app: ReturnType<typeof createApp>) => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  cleanup();
});

describe('POST /kiosk/scan (#29)', () => {
  it('validates gateId against /^[\\w-]{1,64}$/', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const url = await startServer(createApp(db, snapshots, new MockTurnstile('open')));

    for (const gateId of ['', '   ', 'gate/1', 'gate 1', 'a'.repeat(65), 123]) {
      const res = await fetch(`${url}/kiosk/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gateId, token: 'tok' }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('returns GRANTED with firstName and eventId for valid scan', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const url = await startServer(createApp(db, snapshots, new MockTurnstile('open')));
    const token = issueToken(employee.id, privateKey);

    const res = await fetch(`${url}/kiosk/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateId: 'gate_1-BD', token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: 'GRANTED',
      firstName: 'Lan',
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('includes firstName and reason on DENIED when employee is identified (e.g. TCS failure)', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const url = await startServer(createApp(db, snapshots, new MockTurnstile('fail')));
    const token = issueToken(employee.id, privateKey);

    const res = await fetch(`${url}/kiosk/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateId: 'gate-1', token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: 'DENIED',
      reason: 'TCS_UNAVAILABLE',
      firstName: 'Lan',
      eventId: expect.any(String),
    });
  });

  it('includes reason and omits firstName on unidentified denials', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const url = await startServer(createApp(db, snapshots, new MockTurnstile('open')));

    const res = await fetch(`${url}/kiosk/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateId: 'gate-1', token: 'forged.token.sig' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      result: 'DENIED',
      reason: 'INVALID_SIGNATURE',
      eventId: expect.any(String),
    });
    expect(body).not.toHaveProperty('firstName');
  });

  it('fails closed with DENIED instead of 500 when SQLite throws', async () => {
    const snapshots = makeLoadedSnapshots(db, makeSnapshot([employee], publicKey));
    const url = await startServer(createApp(db, snapshots, new MockTurnstile('open')));
    const token = issueToken(employee.id, privateKey);

    // Close DB before request to trigger a real SQLite error inside scan().
    db.close();

    const res = await fetch(`${url}/kiosk/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateId: 'gate-1', token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: 'DENIED',
      reason: 'INTERNAL_ERROR',
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
});
