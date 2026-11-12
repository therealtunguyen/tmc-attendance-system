import type { EdgeHeartbeat } from '../../shared/contracts/edge.js';
import { HEARTBEAT_CHECK_INTERVAL_MS } from '../../shared/contracts/edge.js';

export interface EdgeState {
  id: string;
  lastHeartbeatAt: Date | null;
}

export interface OfflineEdge extends EdgeState {
  factoryId: string;
  gates: { id: string; name: string }[];
}

export class UnknownEdgeError extends Error {
  constructor() {
    super('Edge not found');
  }
}

export const connectionStatus = (at: Date | null, now: Date, timeout: number) =>
  at !== null && now.getTime() - at.getTime() <= timeout
    ? ('ONLINE' as const)
    : ('OFFLINE' as const);

export const parseHeartbeat = (
  body: unknown,
  authenticatedEdgeId: string,
): EdgeHeartbeat | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { sentAt, snapshotAt, outboxSize } = body as Record<string, unknown>;
  const timestamp = (value: unknown): value is string =>
    typeof value === 'string' &&
    /T.*(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
  const resolvedEdgeId = authenticatedEdgeId.trim();
  if (
    !resolvedEdgeId ||
    !timestamp(sentAt) ||
    (snapshotAt !== null && !timestamp(snapshotAt)) ||
    typeof outboxSize !== 'number' ||
    !Number.isSafeInteger(outboxSize) ||
    outboxSize < 0
  )
    return null;
  return { edgeId: resolvedEdgeId, sentAt, snapshotAt, outboxSize };
};

/** Serial checks; stop waits for the current check before closing the database. */
export const startGateMonitor = (
  check: () => Promise<void>,
  interval = HEARTBEAT_CHECK_INTERVAL_MS,
  onError: (error: unknown) => void = (error) => console.error('Gate monitor failed', error),
) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  const tick = () => {
    running = check()
      .catch(onError)
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, interval);
          timer.unref();
        }
      });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
};
