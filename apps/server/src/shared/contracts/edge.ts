// Edge agent <-> server contract (ADR-9). Shared by the server and the edge agent (#23).
// JSON over HTTP, all under /api/edge. Dates are ISO 8601 strings on the wire.

/** The edge pulls GET /api/edge/snapshot this often. */
export const SNAPSHOT_PULL_INTERVAL_MS = 60_000;
/** An event decided from a snapshot older than this is sent with `stale: true`. */
export const SNAPSHOT_STALE_AFTER_MS = 5 * 60_000;

/**
 * Most events in one POST /api/edge/events. A bigger batch gets 400, so the edge outbox must send
 * at most this many per push. 200 events of UUID-sized ids are about 60 KB, under the server's
 * 100 KB JSON body limit, so a long offline backlog drains in chunks instead of failing forever.
 */
export const MAX_EDGE_BATCH = 200;

/** One scan the edge has committed locally. The edge's outbox pushes it until the server confirms. */
export interface EdgeEvent {
  /** Made by the edge (UUID). The server inserts by eventId, so a repeated push is ignored (FR-3.2). */
  eventId: string;
  gateId: string;
  /** Null when the token could not be read or did not verify. */
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

/** 200 from GET /api/edge/snapshot?edgeId=... Full snapshot each time; no diffs at this size. */
export interface EdgeSnapshot {
  /** Server clock. The edge compares it with its own to set `stale`. */
  generatedAt: string;
  /** Current and previous signing key (ADR-10 rotation). */
  publicKeys: EdgePublicKey[];
  employees: SnapshotEmployee[];
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
