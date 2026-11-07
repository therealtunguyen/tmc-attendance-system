// Kiosk HTTP API for the edge agent (ADR-9, #29).
// POST /kiosk/scan is moved here from the server so the edge decides locally (local-first).
import express from 'express';
import type { TurnstileClient } from '../../server/src/adapters/tcs/turnstile-client.js';
import type { Db } from './db.js';
import { scan } from './scan.js';
import type { SnapshotManager } from './snapshot.js';

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
   * Response 200: { result: 'GRANTED' | 'DENIED'; firstName?: string; eventId: string }
   * Moved from server (#29). The edge decides locally; the outbox later syncs to the server.
   */
  app.post('/kiosk/scan', async (req, res) => {
    const { gateId, token } = req.body as { gateId?: unknown; token?: unknown };
    if (typeof gateId !== 'string' || !gateId.trim()) {
      res.status(400).json({ error: 'gateId is required' });
      return;
    }
    if (typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    const result = await scan({ gateId, token }, db, snapshots, turnstile);
    res.json({
      result: result.outcome,
      firstName: result.outcome === 'GRANTED' ? result.firstName : undefined,
      eventId: result.eventId,
    });
  });

  return app;
};
