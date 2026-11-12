// Edge agent configuration (ADR-9, #23). All env vars with safe defaults for tests.
import {
  HEARTBEAT_INTERVAL_MS,
  SNAPSHOT_PULL_INTERVAL_MS,
} from '../../server/src/shared/contracts/edge.js';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v ? n : fallback;
};

const tcsTimeoutMs = num(process.env.TCS_TIMEOUT_MS, 1000);

export const config = {
  /** Unique ID for this edge instance (one per factory). Required in production. */
  edgeId: process.env.EDGE_ID ?? 'edge-dev',
  /** Directory that holds edge.db. Created at startup if absent. */
  dataDir: process.env.EDGE_DATA_DIR ?? '.',
  /** Base URL of the central server. */
  serverBaseUrl: process.env.SERVER_BASE_URL ?? 'http://localhost:3000',
  /** Shared secret matching EDGE_ID in the server's EDGE_TOKENS (#69). */
  edgeToken: process.env.EDGE_TOKEN ?? '',
  /** Kiosk HTTP port. */
  port: num(process.env.PORT, 3100),
  // TCS
  tcsMode: process.env.TCS_MODE === 'http' ? ('http' as const) : ('mock' as const),
  tcsBaseUrl: process.env.TCS_BASE_URL ?? '',
  tcsTimeoutMs,
  /** Seconds before a PENDING row can be flushed (always > TCS timeout). */
  pendingGraceS: Math.ceil(tcsTimeoutMs / 1000) + 5,
  // Timing (ms)
  snapshotIntervalMs: num(process.env.SNAPSHOT_INTERVAL_MS, SNAPSHOT_PULL_INTERVAL_MS),
  outboxIntervalMs: num(process.env.OUTBOX_INTERVAL_MS, 5_000),
  heartbeatIntervalMs: num(process.env.HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS),
};
