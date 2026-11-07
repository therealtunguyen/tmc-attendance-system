// Edge agent configuration (ADR-9, #23). All env vars with safe defaults for tests.
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v ? n : fallback;
};

export const config = {
  /** Unique ID for this edge instance (one per factory). Required in production. */
  edgeId: process.env.EDGE_ID ?? 'edge-dev',
  /** Directory that holds edge.db. Created at startup if absent. */
  dataDir: process.env.EDGE_DATA_DIR ?? '.',
  /** Base URL of the central server. */
  serverBaseUrl: process.env.SERVER_BASE_URL ?? 'http://localhost:3000',
  /** Kiosk HTTP port. */
  port: num(process.env.PORT, 3100),
  // TCS
  tcsMode: process.env.TCS_MODE === 'http' ? ('http' as const) : ('mock' as const),
  tcsBaseUrl: process.env.TCS_BASE_URL ?? '',
  tcsTimeoutMs: num(process.env.TCS_TIMEOUT_MS, 1000),
  // Timing (ms)
  snapshotIntervalMs: num(process.env.SNAPSHOT_INTERVAL_MS, 60_000),
  outboxIntervalMs: num(process.env.OUTBOX_INTERVAL_MS, 5_000),
  heartbeatIntervalMs: num(process.env.HEARTBEAT_INTERVAL_MS, 30_000),
};
