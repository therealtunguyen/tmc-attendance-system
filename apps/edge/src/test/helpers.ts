// Shared test helpers for the edge agent tests.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, type DbOptions } from '../db.js';
import { SnapshotManager } from '../snapshot.js';
import type { ServerClient } from '../server-client.js';
import { signQrToken, QR_TOKEN_TTL_S } from '../../../server/src/shared/contracts/qr-token.js';
import type {
  EdgeSnapshot,
  SnapshotEmployee,
  SnapshotGate,
} from '../../../server/src/shared/contracts/edge.js';

/** Generate a fresh Ed25519 pair for tests. */
export const generatePair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
};

/** Export a public key to base64 SPKI (the format EdgePublicKey.spki uses). */
export const toSpki = (key: KeyObject): string =>
  key.export({ type: 'spki', format: 'der' }).toString('base64');

/**
 * Build a minimal EdgeSnapshot with employees and one key pair. `gates` undefined builds a legacy
 * snapshot without the field (older server, #113), so the edge skips the gate check.
 */
export const makeSnapshot = (
  employees: SnapshotEmployee[],
  publicKey: KeyObject,
  kid = 'k1',
  gates?: SnapshotGate[],
): EdgeSnapshot =>
  ({
    generatedAt: new Date().toISOString(),
    publicKeys: [{ kid, spki: toSpki(publicKey) }],
    employees,
    ...(gates !== undefined ? { gates } : {}),
  }) as EdgeSnapshot;

/** Issue a valid token for a given employee. */
export const issueToken = (
  employeeId: string,
  privateKey: KeyObject,
  kid = 'k1',
  nowS = Math.floor(Date.now() / 1000),
): string =>
  signQrToken(
    { sub: employeeId, exp: nowS + QR_TOKEN_TTL_S, jti: crypto.randomUUID() },
    kid,
    privateKey,
  );

/** Creates a temporary SQLite db and a cleanup function. */
export const createTempDb = (options?: DbOptions): { db: Db; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-test-'));
  const db = openDb(dir, options);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
};

/** Build a SnapshotManager that is already loaded with the given snapshot. */
export const makeLoadedSnapshots = (db: Db, snapshot: EdgeSnapshot): SnapshotManager => {
  // We use a fake server client that never gets called.
  const fakeClient = {
    getSnapshot: async () => ({ ok: false as const, status: 0, error: 'unused' }),
    pushEvents: async () => ({ ok: false as const, status: 0, error: 'unused' }),
    heartbeat: async () => ({ ok: false as const, status: 0, error: 'unused' }),
  } as unknown as ServerClient;
  const mgr = new SnapshotManager(db, fakeClient, 'edge-test');
  // Inject the snapshot directly via the internal setter.
  // SnapshotManager.get() returns `live`. We persist it so load() picks it up.
  db.setKv('snapshot', JSON.stringify(snapshot));
  db.setKv('snapshot_at', String(Date.now()));
  mgr.load();
  return mgr;
};
