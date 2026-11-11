// Composition root for the edge agent (ADR-9, #23).
// Wires all modules together and starts the background loops.
import { mkdirSync } from 'node:fs';
import { TcsHttpClient } from '../../server/src/adapters/tcs/http.js';
import { MockTurnstile } from '../../server/src/adapters/tcs/mock.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { startHeartbeatLoop } from './heartbeat.js';
import { startOutboxLoop } from './outbox.js';
import { ServerClient } from './server-client.js';
import { SnapshotManager } from './snapshot.js';

// Ensure the data directory exists.
mkdirSync(config.dataDir, { recursive: true });

const db = openDb(config.dataDir, { pendingGraceS: config.pendingGraceS });
const serverClient = new ServerClient(config.serverBaseUrl, config.edgeToken);
const snapshots = new SnapshotManager(db, serverClient, config.edgeId);
const turnstile =
  config.tcsMode === 'http'
    ? new TcsHttpClient(config.tcsBaseUrl, config.tcsTimeoutMs)
    : new MockTurnstile('open');

// Load a previously persisted snapshot so the edge can decide before the first pull.
snapshots.load();

const stopSnapshot = snapshots.startLoop(config.snapshotIntervalMs);
const stopOutbox = startOutboxLoop(db, serverClient, config.edgeId, config.outboxIntervalMs);
const stopHeartbeat = startHeartbeatLoop(
  serverClient,
  snapshots,
  db,
  config.edgeId,
  config.heartbeatIntervalMs,
);

const app = createApp(db, snapshots, turnstile);
const server = app.listen(config.port, () => {
  console.log(
    `[edge] ${config.edgeId} listening on http://localhost:${config.port} (TCS ${config.tcsMode})`,
  );
});

// Graceful shutdown.
const shutdown = () => {
  console.log('[edge] shutting down…');
  stopSnapshot();
  stopOutbox();
  stopHeartbeat();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
