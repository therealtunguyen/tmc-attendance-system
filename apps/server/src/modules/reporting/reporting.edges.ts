// Edge sync status the monthly export waits for (ADR-9, FR-4.5). Gate owns the Edge table and provides it.

/** One edge's last confirmed sync: a heartbeat that reported an empty outbox. */
export interface EdgeSync {
  edgeId: string;
  factoryId: string;
  /** Null when the edge has never reported an empty outbox. */
  lastSyncAt: Date | null;
}

/** Implemented by Gate. Events made while an edge was offline reach the server later (ADR-9). */
export interface EdgeSyncStatus {
  edgeSyncs(): Promise<EdgeSync[]>;
}

/** Edges with no sync at or after `since` (the end of the month to export), sorted by edgeId. */
export const unsyncedEdges = (edges: readonly EdgeSync[], since: Date): EdgeSync[] =>
  edges
    .filter((e) => e.lastSyncAt === null || e.lastSyncAt.getTime() < since.getTime())
    .sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
