import { describe, expect, it } from 'vitest';
import { unsyncedEdges, type EdgeSync } from './reporting.edges.js';

const END = new Date('2026-10-31T17:00:00.000Z'); // 2026-11-01 00:00 in Vietnam
const edge = (edgeId: string, lastSyncAt: string | null): EdgeSync => ({
  edgeId,
  factoryId: `f-${edgeId}`,
  lastSyncAt: lastSyncAt === null ? null : new Date(lastSyncAt),
});

describe('unsyncedEdges (ADR-9)', () => {
  it('keeps edges never synced or synced before the month ended, sorted by id', () => {
    const edges = [
      edge('edge-z', null),
      edge('edge-ok', '2026-11-01T01:00:00.000Z'),
      edge('edge-a', '2026-10-31T16:59:59.999Z'),
    ];
    expect(unsyncedEdges(edges, END).map((e) => e.edgeId)).toEqual(['edge-a', 'edge-z']);
  });

  it('counts a sync exactly at the end of the month as synced, and does not mutate the input', () => {
    const edges = [edge('edge-b', '2026-10-31T17:00:00.000Z'), edge('edge-a', null)];
    expect(unsyncedEdges(edges, END)).toEqual([edge('edge-a', null)]);
    expect(edges.map((e) => e.edgeId)).toEqual(['edge-b', 'edge-a']);
  });
});
