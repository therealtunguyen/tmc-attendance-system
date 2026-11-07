// Periodic heartbeat to the server (#28). The server marks the edge offline when these stop (FR-2.6).
import type { EdgeHeartbeat } from '../../server/src/shared/contracts/edge.js';
import type { ServerClient } from './server-client.js';
import type { SnapshotManager } from './snapshot.js';
import type { Db } from './db.js';
import { outboxSize } from './outbox.js';

export const sendHeartbeat = async (
  client: ServerClient,
  snapshots: SnapshotManager,
  db: Db,
  edgeId: string,
): Promise<void> => {
  const live = snapshots.get();
  const hb: EdgeHeartbeat = {
    edgeId,
    sentAt: new Date().toISOString(),
    snapshotAt: live?.snapshot.generatedAt ?? null,
    outboxSize: outboxSize(db),
  };
  const result = await client.heartbeat(hb);
  if (!result.ok) {
    console.warn(`[heartbeat] failed: ${result.status} ${result.error}`);
  }
};

/** Starts the heartbeat loop. Returns a cleanup function. */
export const startHeartbeatLoop = (
  client: ServerClient,
  snapshots: SnapshotManager,
  db: Db,
  edgeId: string,
  intervalMs: number,
): (() => void) => {
  void sendHeartbeat(client, snapshots, db, edgeId);
  const id = setInterval(() => void sendHeartbeat(client, snapshots, db, edgeId), intervalMs);
  return () => clearInterval(id);
};
