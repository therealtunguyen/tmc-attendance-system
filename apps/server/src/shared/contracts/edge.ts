// Edge agent <-> server contract (ADR-9). Shared by the server and the edge agent (#23).
// JSON over HTTP, all under /api/edge. Dates are ISO 8601 strings on the wire.

import type { QrDenyReason } from './qr-validation.js';

/** The edge pulls GET /api/edge/snapshot this often. */
export const SNAPSHOT_PULL_INTERVAL_MS = 60_000;
/** An event decided from a snapshot older than this is sent with `stale: true`. */
export const SNAPSHOT_STALE_AFTER_MS = 5 * 60_000;

/** FR-2.6 defaults. The edge sends every 30 s; the server tolerates 90 s without a receipt. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
export const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;

/**
 * Most events in one POST /api/edge/events. A bigger batch gets 400, so the edge outbox must send
 * at most this many per push. 200 events of UUID-sized ids are about 60 KB, under the server's
 * 100 KB JSON body limit, so a long offline backlog drains in chunks instead of failing forever.
 */
export const MAX_EDGE_BATCH = 200;

/**
 * Why a scan was denied (FR-4.4): a QR check failure, a jti already used (ADR-10, checked at the edge),
 * or a gate check against the snapshot (#113). UNKNOWN_GATE is never pushed: the server would reject
 * the batch, so the edge only logs it.
 */
export type EdgeDenyReason = QrDenyReason | 'REPLAYED' | 'UNKNOWN_GATE' | 'GATE_INACTIVE';
export const DENY_REASONS: readonly EdgeDenyReason[] = [
  'INVALID_SIGNATURE',
  'EXPIRED',
  'UNKNOWN',
  'INACTIVE',
  'REVOKED',
  'REPLAYED',
  'UNKNOWN_GATE',
  'GATE_INACTIVE',
];

/** One scan the edge has committed locally. The edge's outbox pushes it until the server confirms. */
export interface EdgeEvent {
  /** Made by the edge (UUID). The server inserts by eventId, so a repeated push is ignored (FR-3.2). */
  eventId: string;
  gateId: string;
  /** Null when the token did not verify (bad signature, or expired): only a verified sub is recorded. */
  employeeId: string | null;
  method: 'QR' | 'MANUAL';
  /** PENDING if the edge crashed between commit and TCS call. */
  outcome: 'PENDING' | 'GRANTED' | 'DENIED';
  /** Edge clock (NTP). The server stores its own receivedAt next to it. */
  occurredAt: string;
  /** Token ID, so the server can flag one jti used at two edges. Null for MANUAL. */
  jti: string | null;
  /** True if the snapshot was older than SNAPSHOT_STALE_AFTER_MS when this event was decided. */
  stale: boolean;
  /**
   * Why the edge denied the scan, for the security access log (FR-4.4). Only with outcome DENIED;
   * optional so an edge built before this field still pushes. Null or absent = not known.
   */
  denyReason?: EdgeDenyReason | null;
}

/** POST /api/edge/events */
export interface PushEventsRequest {
  edgeId: string;
  events: EdgeEvent[];
}

/** 200. Every eventId the server now holds, new or duplicate; the edge drops these from its outbox. */
export interface PushEventsResponse {
  accepted: string[];
}

/** Public half of a QR signing key. */
export interface EdgePublicKey {
  kid: string;
  /** Ed25519 public key, base64 DER (SPKI). */
  spki: string;
}

/** An employee the edge may see in a token. Missing from the snapshot = unknown employee. */
export interface SnapshotEmployee {
  id: string;
  /** Shown on the kiosk when the gate opens. */
  firstName: string;
  /** Null = admit. Otherwise deny with this reason (FR-2.2). */
  deny: 'REVOKED' | 'INACTIVE' | null;
}

/** A gate of the requesting edge (#113). Missing from the snapshot = unknown gate. */
export interface SnapshotGate {
  /** Gate UUID, what the kiosk sends as `gateId` and what events carry. */
  id: string;
  /** The device id TCS expects in `open()`. */
  turnstileId: string;
  /** False = deactivated: the edge denies with GATE_INACTIVE. */
  active: boolean;
}

/** 200 from GET /api/edge/snapshot?edgeId=... Full snapshot each time; no diffs at this size. */
export interface EdgeSnapshot {
  /** Server clock. The edge compares it with its own to set `stale`. */
  generatedAt: string;
  /** Current and previous signing key (ADR-10 rotation). */
  publicKeys: EdgePublicKey[];
  employees: SnapshotEmployee[];
  /**
   * Only the gates of the requesting edge (#113). A snapshot saved by an older server has none; the
   * edge then skips the gate check instead of denying everything (ADR-9 offline resilience).
   */
  gates: SnapshotGate[];
}

/** POST /api/edge/heartbeat. 204. The server marks the edge offline when these stop (FR-2.6). */
export interface EdgeHeartbeat {
  edgeId: string;
  /** Edge clock, to expose drift. */
  sentAt: string;
  /** generatedAt of the snapshot the edge is using. */
  snapshotAt: string | null;
  /** Events not yet confirmed by the server. */
  outboxSize: number;
}
