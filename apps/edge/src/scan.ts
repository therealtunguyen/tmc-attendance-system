// Local-first scan flow (ADR-9, #24, #25).
// validate (reuse qr-validation) → commit to SQLite → call TCS (reuse TurnstileClient) → set outcome.
import { randomUUID } from 'node:crypto';
import { checkQrToken } from '../../server/src/shared/contracts/qr-validation.js';
import { QR_TOKEN_TTL_S, QR_EXP_TOLERANCE_S } from '../../server/src/shared/contracts/qr-token.js';
import type { TurnstileClient } from '../../server/src/adapters/tcs/turnstile-client.js';
import type { Db } from './db.js';
import type { SnapshotManager } from './snapshot.js';

/** #25: jti stays in jti_seen for the token TTL plus tolerance plus a small buffer. */
const JTI_TTL_MS = (QR_TOKEN_TTL_S + QR_EXP_TOLERANCE_S + 30) * 1000;

export interface ScanInput {
  gateId: string;
  /** Raw QR token string. */
  token: string;
}

export type ScanOutcome = 'GRANTED' | 'DENIED';

export type DenyReason =
  | 'INVALID_SIGNATURE'
  | 'EXPIRED'
  | 'UNKNOWN'
  | 'INACTIVE'
  | 'REVOKED'
  | 'REPLAYED'
  | 'NO_SNAPSHOT'
  | 'TCS_UNAVAILABLE';

export type ScanResult =
  | { outcome: 'GRANTED'; firstName: string; eventId: string }
  | { outcome: 'DENIED'; reason: DenyReason; firstName?: string; eventId: string };

/**
 * Runs the edge scan flow (#24):
 * 1. Validate token against snapshot employees (reuses checkQrToken from shared contracts)
 * 2. Verified, unexpired denials (REVOKED/INACTIVE/UNKNOWN) are committed straight as DENIED
 *    with employeeId + jti and skip TCS; unverified/expired/no-snapshot scans are logged only.
 * 3. Check jti reuse (#25) and commit to SQLite atomically
 * 4. Call TCS (reuse TurnstileClient)
 * 5. Set final outcome (GRANTED | DENIED) in SQLite
 *
 * If a crash occurs between step 3 and step 5, the outbox will push the PENDING event
 * once the pending grace window elapses — the server records it and the supervisor can follow up.
 */
export const scan = async (
  input: ScanInput,
  db: Db,
  snapshots: SnapshotManager,
  turnstile: TurnstileClient,
  now = () => new Date(),
): Promise<ScanResult> => {
  const eventId = randomUUID();
  const occurredAt = now().toISOString();
  const stale = snapshots.isStale() ? (1 as const) : (0 as const);

  // 1: Validate token against snapshot
  const live = snapshots.get();
  if (!live) {
    // FR-3.1 exception: no snapshot is loaded so we cannot verify or identify the token;
    // log and fail closed without writing unverified rows to SQLite.
    console.warn(`[scan] gate=${input.gateId} denied: NO_SNAPSHOT`);
    return { outcome: 'DENIED', reason: 'NO_SNAPSHOT', eventId };
  }

  const nowS = Math.floor(now().getTime() / 1000);
  const checkResult = await checkQrToken(input.token, {
    publicKeys: live.publicKeys,
    findEmployee: (id) => snapshots.findEmployee(id),
    nowS,
  });

  if (!checkResult.ok) {
    // FR-3.1 exception: INVALID_SIGNATURE and EXPIRED cannot be trusted to identify an
    // employee and would allow token floods to bloat SQLite/outbox; log them and skip storage.
    if (checkResult.reason === 'INVALID_SIGNATURE' || checkResult.reason === 'EXPIRED') {
      console.warn(`[scan] gate=${input.gateId} denied: ${checkResult.reason}`);
      return { outcome: 'DENIED', reason: checkResult.reason, eventId };
    }

    // Verified, unexpired denial (REVOKED, INACTIVE, UNKNOWN): employeeId and jti are known.
    // Commit directly as DENIED (skip TCS) and record at most one REPLAYED if seen again.
    const employeeId = checkResult.employeeId ?? null;
    const jti = checkResult.jti ?? null;
    const firstName = employeeId ? snapshots.findEmployee(employeeId)?.firstName : undefined;
    const status = db.commitScan(
      {
        eventId,
        gateId: input.gateId,
        employeeId,
        method: 'QR',
        outcome: 'DENIED',
        occurredAt,
        jti,
        stale,
        denyReason: checkResult.reason,
      },
      JTI_TTL_MS,
    );

    const reason: DenyReason = status === 'REPLAYED' ? 'REPLAYED' : checkResult.reason;
    return {
      outcome: 'DENIED',
      reason,
      ...(firstName !== undefined ? { firstName } : {}),
      eventId,
    };
  }

  const { employeeId, firstName, jti } = checkResult;

  // 3: Commit PENDING to SQLite + jti replay guard (#25) — atomic transaction.
  const status = db.commitScan(
    {
      eventId,
      gateId: input.gateId,
      employeeId,
      method: 'QR',
      outcome: 'PENDING',
      occurredAt,
      jti,
      stale,
      denyReason: null,
    },
    JTI_TTL_MS,
  );

  if (status === 'REPLAYED') {
    // First replay per jti was stored as DENIED in commitScan; subsequent replays are logged only.
    console.warn(`[scan] gate=${input.gateId} employee=${employeeId} denied: REPLAYED`);
    return { outcome: 'DENIED', reason: 'REPLAYED', firstName, eventId };
  }

  // 4: Call TCS (ADR-3: 1 s timeout, no retry). Fail closed on anything but OPENED.
  const tcsResult = await turnstile.open(input.gateId);
  const outcome: ScanOutcome = tcsResult === 'OPENED' ? 'GRANTED' : 'DENIED';

  // 5: Persist final outcome.
  db.setOutcome(eventId, outcome);

  if (outcome === 'GRANTED') {
    return { outcome: 'GRANTED', firstName, eventId };
  }
  return {
    outcome: 'DENIED',
    reason: 'TCS_UNAVAILABLE',
    firstName,
    eventId,
  };
};
