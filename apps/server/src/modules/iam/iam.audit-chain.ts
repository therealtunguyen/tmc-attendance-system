import { createHash } from 'node:crypto';

/** prevHash of the first entry in the chain. */
export const GENESIS_HASH = '0'.repeat(64);

export interface ChainInput {
  actorId: string;
  action: string;
  target: string;
  at: Date;
  before?: unknown;
  after?: unknown;
}

export type ChainedEntry = ChainInput & { seq: number; prevHash: string; hash: string };

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => [key, sortKeys(v)]),
  );
};

/** Deterministic JSON: Postgres jsonb reorders keys, so the same value must hash the same either way. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value) ?? 'null')));

export const chainHash = (prevHash: string, entry: ChainInput): string =>
  createHash('sha256')
    .update(
      prevHash +
        canonicalJson({
          actorId: entry.actorId,
          action: entry.action,
          target: entry.target,
          at: entry.at.toISOString(),
          before: entry.before ?? null,
          after: entry.after ?? null,
        }),
    )
    .digest('hex');

export type ChainVerdict = { ok: true } | { ok: false; brokenAtSeq: number };

/** Rows ordered by seq. No gap check: SERIAL skips numbers on rollback; a deleted row breaks prevHash linkage instead. */
export const verifyChain = (rows: ChainedEntry[]): ChainVerdict => {
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== prev || row.hash !== chainHash(row.prevHash, row)) {
      return { ok: false, brokenAtSeq: row.seq };
    }
    prev = row.hash;
  }
  return { ok: true };
};
