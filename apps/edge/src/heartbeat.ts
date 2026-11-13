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
  now = () => new Date(),
): Promise<boolean> => {
  const live = snapshots.get();
  const hb: EdgeHeartbeat = {
    edgeId,
    sentAt: now().toISOString(),
    snapshotAt: live?.snapshot.generatedAt ?? null,
    outboxSize: outboxSize(db),
  };
  const result = await client.heartbeat(hb);
  if (!result.ok) {
    console.warn(`[heartbeat] failed: ${result.status} ${result.error}`);
    return false;
  }
  return true;
};

/** Starts the heartbeat loop with an in-flight guard. Returns a cleanup function. */
export const startHeartbeatLoop = (
  client: ServerClient,
  snapshots: SnapshotManager,
  db: Db,
  edgeId: string,
  intervalMs: number,
): (() => void) => {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendHeartbeat(client, snapshots, db, edgeId);
    } catch (err) {
      // #113 B1: a throw here must not become an unhandled rejection.
      console.warn(`[heartbeat] tick failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const id = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(id);
};
