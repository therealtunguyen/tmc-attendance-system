// Kiosk HTTP API for the edge agent (ADR-9, #29).
// POST /kiosk/scan is served directly by the edge so gate decisions stay local-first.
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { TurnstileClient } from '../../server/src/adapters/tcs/turnstile-client.js';
import type { Db } from './db.js';
import { scan } from './scan.js';
import type { SnapshotManager } from './snapshot.js';

const GATE_ID_RE = /^[\w-]{1,64}$/;

export const createApp = (db: Db, snapshots: SnapshotManager, turnstile: TurnstileClient) => {
  const app = express();
  app.use(express.json());

  /** Health check — also used by monitoring to confirm the edge is up. */
  app.get('/health', (_req, res) => {
    res.json({ ok: true, stale: snapshots.isStale() });
  });

  /**
   * POST /kiosk/scan
   * Body: { gateId: string; token: string }
   * Response 200: { result: 'GRANTED' | 'DENIED'; firstName?: string; reason?: string; eventId: string }
   * Served on the edge (#29); the outbox later syncs committed events to the server.
   */
  app.post('/kiosk/scan', async (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const { gateId, token } = body as { gateId?: unknown; token?: unknown };
    if (typeof gateId !== 'string' || !GATE_ID_RE.test(gateId)) {
      res.status(400).json({ error: 'gateId must match /^[\\w-]{1,64}$/' });
      return;
    }
    if (typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ error: 'token is required' });
      return;
    }

    try {
      const result = await scan({ gateId, token }, db, snapshots, turnstile);
      res.json({
        result: result.outcome,
        ...(result.firstName !== undefined ? { firstName: result.firstName } : {}),
        ...(result.outcome === 'DENIED' ? { reason: result.reason } : {}),
        eventId: result.eventId,
      });
    } catch (err) {
      // Fail closed on unexpected storage/runtime errors rather than returning 500.
      console.error('[kiosk/scan] unexpected error, failing closed:', err);
      res.json({
        result: 'DENIED',
        reason: 'INTERNAL_ERROR',
        eventId: randomUUID(),
      });
    }
  });

  return app;
};
