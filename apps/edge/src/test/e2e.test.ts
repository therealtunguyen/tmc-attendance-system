// End-to-end HTTP integration tests for the edge agent (#27, #28, #29, #30).
// Exercises real HTTP between Kiosk -> Edge App -> SQLite -> ServerClient -> Mock Central Server.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTurnstile } from '../../../server/src/adapters/tcs/mock.js';
import type {
  EdgeEvent,
  EdgeHeartbeat,
  EdgeSnapshot,
  PushEventsRequest,
} from '../../../server/src/shared/contracts/edge.js';
import { createApp } from '../app.js';
import type { Db } from '../db.js';
import { sendHeartbeat } from '../heartbeat.js';
import { flushOutbox, outboxSize } from '../outbox.js';
import { ServerClient } from '../server-client.js';
import { SnapshotManager } from '../snapshot.js';
import { createTempDb, generatePair, issueToken, makeSnapshot } from './helpers.js';

let db: Db;
let cleanup: () => void;
let edgeHttp: Server | null = null;
let centralHttp: Server | null = null;

const { privateKey, publicKey } = generatePair();
const employee = { id: 'emp-e2e', firstName: 'An', deny: null as null };

const listen = async (srv: Server): Promise<string> => {
  await new Promise<void>((resolve) => srv.listen(0, resolve));
  const { port } = srv.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

const closeServer = async (srv: Server | null) => {
  if (!srv) return;
  srv.closeAllConnections?.();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
};

beforeEach(() => {
  const temp = createTempDb();
  db = temp.db;
  cleanup = temp.cleanup;
});

afterEach(async () => {
  await closeServer(edgeHttp);
  await closeServer(centralHttp);
  edgeHttp = null;
  centralHttp = null;
  cleanup();
});

describe('Edge HTTP end-to-end (#27-#30)', () => {
  it('survives central server outage during POST /kiosk/scan and syncs without loss or duplicates on recovery', async () => {
    let centralOnline = true;
    const storedOnServer = new Map<string, EdgeEvent>();
    const heartbeats: EdgeHeartbeat[] = [];
    const snapshot: EdgeSnapshot = makeSnapshot([employee], publicKey);

    centralHttp = createServer(async (req, res) => {
      if (!centralOnline) {
        res.statusCode = 503;
        res.end('Service Unavailable');
        return;
      }
      if (req.headers.authorization !== 'Bearer edge-secret') {
        res.statusCode = 401;
        res.end('Unauthorized');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bodyText = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'GET' && req.url?.startsWith('/api/edge/snapshot')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(snapshot));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/edge/events') {
        const payload = JSON.parse(bodyText) as PushEventsRequest;
        const accepted: string[] = [];
        for (const ev of payload.events) {
          // Idempotent insert by eventId (FR-3.2).
          if (!storedOnServer.has(ev.eventId)) storedOnServer.set(ev.eventId, ev);
          accepted.push(ev.eventId);
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ accepted }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/edge/heartbeat') {
        heartbeats.push(JSON.parse(bodyText) as EdgeHeartbeat);
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const centralUrl = await listen(centralHttp);
    const client = new ServerClient(centralUrl, 'edge-secret');
    const snapshots = new SnapshotManager(db, client, 'edge-bd');
    await snapshots.pull();

    const turnstile = new MockTurnstile('open');
    edgeHttp = createServer(createApp(db, snapshots, turnstile));
    const edgeUrl = await listen(edgeHttp);

    // 1. Central server drops offline.
    centralOnline = false;

    // 2. Kiosk scans succeed locally while central server is down (#29, #24).
    const scanIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${edgeUrl}/kiosk/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gateId: 'gate-1', token: issueToken(employee.id, privateKey) }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: string; firstName?: string; eventId: string };
      expect(body).toMatchObject({ result: 'GRANTED', firstName: 'An' });
      scanIds.push(body.eventId);
    }

    // Flush attempt during outage keeps all 3 events in outbox (#27, #30).
    expect(await flushOutbox(db, client, 'edge-bd')).toBe(0);
    expect(outboxSize(db)).toBe(3);

    // 3. Central server recovers -> outbox pushes all 3 with zero duplicates (#27, #30).
    centralOnline = true;
    expect(await flushOutbox(db, client, 'edge-bd')).toBe(3);
    expect(await flushOutbox(db, client, 'edge-bd')).toBe(0); // idempotent second flush
    expect(outboxSize(db)).toBe(0);
    expect(storedOnServer.size).toBe(3);
    for (const id of scanIds) expect(storedOnServer.has(id)).toBe(true);

    // 4. Heartbeat reports synced state (#28).
    expect(await sendHeartbeat(client, snapshots, db, 'edge-bd')).toBe(true);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({
      edgeId: 'edge-bd',
      snapshotAt: snapshot.generatedAt,
      outboxSize: 0,
    });

    // 5. TCS timeout -> kiosk gets DENIED with firstName, event synced as DENIED (#30).
    turnstile.mode = 'slow';
    const slowTurnstile = new MockTurnstile('slow', 20);
    await closeServer(edgeHttp);
    edgeHttp = createServer(createApp(db, snapshots, slowTurnstile));
    const edgeUrl2 = await listen(edgeHttp);

    const timeoutRes = await fetch(`${edgeUrl2}/kiosk/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gateId: 'gate-1', token: issueToken(employee.id, privateKey) }),
    });
    expect(timeoutRes.status).toBe(200);
    const timeoutBody = (await timeoutRes.json()) as {
      result: string;
      reason?: string;
      firstName?: string;
      eventId: string;
    };
    expect(timeoutBody).toMatchObject({
      result: 'DENIED',
      reason: 'TCS_UNAVAILABLE',
      firstName: 'An',
    });

    expect(await flushOutbox(db, client, 'edge-bd')).toBe(1);
    expect(storedOnServer.get(timeoutBody.eventId)).toMatchObject({
      outcome: 'DENIED',
      employeeId: employee.id,
    });
  });
});
