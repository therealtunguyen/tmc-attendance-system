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
  | { outcome: 'DENIED'; reason: DenyReason; eventId: string };

/**
 * Runs the edge scan flow (#24):
 * 1. Validate token with snapshot employees (reuses checkQrToken from shared contracts)
 * 2. Check jti reuse (#25)
 * 3. Commit to SQLite (PENDING) in one transaction with jti insert
 * 4. Call TCS (reuse TurnstileClient)
 * 5. Set final outcome (GRANTED | DENIED) in SQLite
 *
 * If a crash occurs between step 3 and step 5, the outbox will push a PENDING event —
 * the server records it and the supervisor can follow up.
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

  // 1 & 2: Validate token against snapshot
  const live = snapshots.get();
  if (!live) {
    // No snapshot at all — fail closed (FR-2.3).
    return { outcome: 'DENIED', reason: 'NO_SNAPSHOT', eventId };
  }

  const nowS = Math.floor(now().getTime() / 1000);
  const checkResult = await checkQrToken(input.token, {
    publicKeys: live.publicKeys,
    findEmployee: (id) => snapshots.findEmployee(id),
    nowS,
  });

  if (!checkResult.ok) {
    // Token is bad — no jti, no event (don't waste SQLite space on forgeries).
    return {
      outcome: 'DENIED',
      reason: checkResult.reason as DenyReason,
      eventId,
    };
  }

  const { employeeId, firstName, jti } = checkResult;

  // 3: Commit to SQLite + jti check (#25) — atomic transaction.
  const committed = db.commitScan(
    {
      eventId,
      gateId: input.gateId,
      employeeId,
      method: 'QR',
      outcome: 'PENDING',
      occurredAt,
      jti,
      stale,
    },
    JTI_TTL_MS,
  );

  if (!committed) {
    // jti already seen within TTL → REPLAYED (#25).
    // We don't store a REPLAYED event: no eventId to push to server.
    return { outcome: 'DENIED', reason: 'REPLAYED', eventId };
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
    eventId,
  };
};
