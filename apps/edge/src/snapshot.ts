// Snapshot pull loop (#26). Fetches GET /api/edge/snapshot every SNAPSHOT_PULL_INTERVAL_MS.
// Stores the snapshot JSON in SQLite kv so it survives an edge restart.
import {
  SNAPSHOT_PULL_INTERVAL_MS,
  SNAPSHOT_STALE_AFTER_MS,
  type EdgeSnapshot,
} from '../../server/src/shared/contracts/edge.js';
import { createPublicKey } from 'node:crypto';
import type { QrPublicKeys } from '../../server/src/shared/contracts/qr-token.js';
import type { SnapshotEmployee } from '../../server/src/shared/contracts/edge.js';
import type { Db } from './db.js';
import type { ServerClient } from './server-client.js';

export interface LiveSnapshot {
  snapshot: EdgeSnapshot;
  /** Date.now() when the snapshot was last fetched from the server. */
  fetchedAt: number;
  /** Parsed public keys for verifyQrToken. */
  publicKeys: QrPublicKeys;
}

const KV_SNAPSHOT = 'snapshot';
const KV_SNAPSHOT_AT = 'snapshot_at';

/** Parses the public keys from an EdgeSnapshot into the format verifyQrToken expects. */
const parsePublicKeys = (snapshot: EdgeSnapshot): QrPublicKeys => {
  const result: QrPublicKeys = {};
  for (const { kid, spki } of snapshot.publicKeys) {
    result[kid] = createPublicKey({
      key: Buffer.from(spki, 'base64'),
      format: 'der',
      type: 'spki',
    });
  }
  return result;
};

/**
 * Manages the live snapshot. Loads a persisted snapshot at startup (so the edge
 * can admit employees even if the server is unreachable on boot), then polls every
 * SNAPSHOT_PULL_INTERVAL_MS (#26).
 */
export class SnapshotManager {
  private live: LiveSnapshot | null = null;

  constructor(
    private db: Db,
    private client: ServerClient,
    private edgeId: string,
  ) {}

  /** Call once at startup. Loads from disk if available. */
  load(): void {
    const json = this.db.getKv(KV_SNAPSHOT);
    const atStr = this.db.getKv(KV_SNAPSHOT_AT);
    if (json && atStr) {
      try {
        const snapshot = JSON.parse(json) as EdgeSnapshot;
        this.live = {
          snapshot,
          fetchedAt: Number(atStr),
          publicKeys: parsePublicKeys(snapshot),
        };
      } catch {
        // Corrupted — will be replaced on first successful pull
      }
    }
  }

  /** The current snapshot, or null if none has ever been fetched. */
  get(): LiveSnapshot | null {
    return this.live;
  }

  /**
   * Whether the current snapshot is stale (#26).
   * Returns true if the snapshot is older than SNAPSHOT_STALE_AFTER_MS or absent.
   */
  isStale(): boolean {
    if (!this.live) return true;
    return Date.now() - this.live.fetchedAt > SNAPSHOT_STALE_AFTER_MS;
  }

  /** Fetches a fresh snapshot from the server. Called by the pull loop and can be called manually. */
  async pull(): Promise<void> {
    const result = await this.client.getSnapshot(this.edgeId);
    if (!result.ok) {
      console.warn(`[snapshot] pull failed: ${result.status} ${result.error}`);
      return;
    }
    const snapshot = result.data;
    const fetchedAt = Date.now();
    this.live = { snapshot, fetchedAt, publicKeys: parsePublicKeys(snapshot) };
    this.db.setKv(KV_SNAPSHOT, JSON.stringify(snapshot));
    this.db.setKv(KV_SNAPSHOT_AT, String(fetchedAt));
    console.log(
      `[snapshot] updated at ${snapshot.generatedAt} (${snapshot.employees.length} employees)`,
    );
  }

  /** Starts the background pull loop. Returns a cleanup function (for tests). */
  startLoop(intervalMs = SNAPSHOT_PULL_INTERVAL_MS): () => void {
    // Pull immediately on startup, then on the interval.
    void this.pull();
    const id = setInterval(() => void this.pull(), intervalMs);
    return () => clearInterval(id);
  }

  /** Convenience: find an employee in the current snapshot. */
  findEmployee(id: string): SnapshotEmployee | null {
    return this.live?.snapshot.employees.find((e) => e.id === id) ?? null;
  }
}
