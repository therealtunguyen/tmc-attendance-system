import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { canonicalJson, chainHash, GENESIS_HASH, verifyChain } from './iam.audit-chain.js';
import { iamRoutes } from './iam.routes.js';
import {
  IamService,
  type AuditEntry,
  type AuditFilter,
  type AuditStore,
  type ChainedEntry,
} from './iam.service.js';

const at = (n: number) => new Date(Date.UTC(2026, 10, 6, 8, n));

const entry = (n: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  actorId: 'hr-1',
  action: 'employee.update',
  target: `employee:${n}`,
  at: at(n),
  ...extra,
});

/** Same linking as the Prisma repo, minus the database. */
class InMemoryAudit implements AuditStore {
  rows: ChainedEntry[] = [];
  lastFilter: AuditFilter | undefined;

  async append(e: AuditEntry) {
    const prevHash = this.rows.at(-1)?.hash ?? GENESIS_HASH;
    this.rows.push({ ...e, seq: this.rows.length + 1, prevHash, hash: chainHash(prevHash, e) });
  }

  async search(filter: AuditFilter) {
    this.lastFilter = filter;
    return this.rows
      .filter(
        (r) =>
          (filter.actorId === undefined || r.actorId === filter.actorId) &&
          (filter.action === undefined || r.action === filter.action) &&
          (filter.target === undefined || r.target === filter.target) &&
          (filter.from === undefined || r.at >= filter.from) &&
          (filter.to === undefined || r.at <= filter.to),
      )
      .reverse()
      .slice(0, filter.limit);
  }

  async chain() {
    return this.rows.map((r) => ({ ...r }));
  }
}

const build = async (count: number) => {
  const store = new InMemoryAudit();
  const iam = new IamService(store);
  for (let i = 1; i <= count; i++) await iam.append(entry(i, { after: { n: i } }));
  return { store, iam };
};

describe('audit chain', () => {
  it('canonicalJson sorts keys recursively and normalises dates', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: undefined }], c: at(0) } })).toBe(
      `{"a":{"c":"${at(0).toISOString()}","d":[{"z":1}]},"b":1}`,
    );
  });

  it('hash does not depend on key order in before/after', () => {
    const a = entry(1, { before: { x: 1, y: { p: 1, q: 2 } }, after: { m: 1, n: 2 } });
    const b = entry(1, { before: { y: { q: 2, p: 1 }, x: 1 }, after: { n: 2, m: 1 } });
    expect(chainHash(GENESIS_HASH, a)).toBe(chainHash(GENESIS_HASH, b));
  });

  it('treats missing and null before/after the same', () => {
    expect(chainHash(GENESIS_HASH, entry(1))).toBe(
      chainHash(GENESIS_HASH, entry(1, { before: null, after: null })),
    );
  });

  it('hash depends on prevHash and content', () => {
    expect(chainHash(GENESIS_HASH, entry(1))).not.toBe(chainHash('1'.repeat(64), entry(1)));
    expect(chainHash(GENESIS_HASH, entry(1))).not.toBe(chainHash(GENESIS_HASH, entry(2)));
  });

  it('accepts an empty chain and a valid chain', async () => {
    expect(verifyChain([])).toEqual({ ok: true });
    expect(verifyChain(await (await build(4)).store.chain())).toEqual({ ok: true });
  });

  it('detects an edited field at that row', async () => {
    const rows = await (await build(4)).store.chain();
    rows[2]!.after = { n: 999 };
    expect(verifyChain(rows)).toEqual({ ok: false, brokenAtSeq: 3 });
  });

  it('detects a deleted middle row', async () => {
    const rows = await (await build(4)).store.chain();
    rows.splice(1, 1);
    expect(verifyChain(rows)).toEqual({ ok: false, brokenAtSeq: 3 });
  });

  it('detects reordered rows', async () => {
    const rows = await (await build(4)).store.chain();
    [rows[1], rows[2]] = [rows[2]!, rows[1]!];
    expect(verifyChain(rows)).toEqual({ ok: false, brokenAtSeq: 3 });
  });

  it('detects a wrong first prevHash', async () => {
    const rows = await (await build(2)).store.chain();
    rows[0]!.prevHash = '1'.repeat(64);
    expect(verifyChain(rows)).toEqual({ ok: false, brokenAtSeq: 1 });
  });
});

describe('IamService audit', () => {
  it('verifies after appends', async () => {
    const { iam } = await build(3);
    expect(await iam.verify()).toEqual({ ok: true });
  });

  it('reports tampering', async () => {
    const { iam, store } = await build(3);
    store.rows[1]!.actorId = 'someone-else';
    expect(await iam.verify()).toEqual({ ok: false, brokenAtSeq: 2 });
  });

  it('defaults and clamps the limit', async () => {
    const { iam, store } = await build(1);
    await iam.search({});
    expect(store.lastFilter?.limit).toBe(100);
    await iam.search({ limit: 100000 });
    expect(store.lastFilter?.limit).toBe(500);
    await iam.search({ limit: 7 });
    expect(store.lastFilter?.limit).toBe(7);
  });

  it('returns newest first', async () => {
    const { iam } = await build(3);
    expect((await iam.search({})).map((r) => r.seq)).toEqual([3, 2, 1]);
  });
});

describe('/api/audit', () => {
  /** Stands in for the IAM auth middleware (FR-5.1). */
  const signedInAs = (role?: string) =>
    Router().use((_req, res, next) => {
      if (role) res.locals.user = { id: 'u-1', role };
      next();
    });
  const setup = async (role?: string) => {
    const { iam, store } = await build(3);
    return { store, app: createApp([signedInAs(role), iamRoutes(iam)]) };
  };

  it('rejects when not signed in', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not signed in' });
    expect((await request(app).get('/api/audit/verify')).status).toBe(401);
  });

  it('rejects non-ADM roles', async () => {
    const { app } = await setup('HR');
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect((await request(app).get('/api/audit/verify')).status).toBe(403);
  });

  it('lists entries for ADM, newest first', async () => {
    const { app } = await setup('ADM');
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.map((r: ChainedEntry) => r.seq)).toEqual([3, 2, 1]);
    expect(res.body[0]).toMatchObject({ actorId: 'hr-1', hash: expect.any(String) });
  });

  it('passes filters through, parsing dates', async () => {
    const { app, store } = await setup('ADM');
    const res = await request(app)
      .get('/api/audit')
      .query({
        actorId: 'hr-1',
        action: 'employee.update',
        target: 'employee:2',
        from: at(1).toISOString(),
        to: at(2).toISOString(),
        limit: '5',
      });
    expect(res.status).toBe(200);
    expect(store.lastFilter).toEqual({
      actorId: 'hr-1',
      action: 'employee.update',
      target: 'employee:2',
      from: at(1),
      to: at(2),
      limit: 5,
    });
    expect(res.body.map((r: ChainedEntry) => r.seq)).toEqual([2]);
  });

  it.each([
    ['from', 'yesterday'],
    ['to', 'not-a-date'],
    ['limit', '0'],
    ['limit', '-3'],
    ['limit', '1.5'],
    ['limit', 'abc'],
    ['actorId', ''],
    ['action', ''],
    ['target', ''],
    ['from', ''],
    ['limit', ''],
  ])('400 on bad %s=%j', async (key, value) => {
    const { app } = await setup('ADM');
    const res = await request(app)
      .get('/api/audit')
      .query({ [key]: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
  });

  it('verify reports ok, then the broken row', async () => {
    const { app, store } = await setup('ADM');
    expect((await request(app).get('/api/audit/verify')).body).toEqual({ ok: true });
    store.rows[1]!.action = 'tampered';
    expect((await request(app).get('/api/audit/verify')).body).toEqual({
      ok: false,
      brokenAtSeq: 2,
    });
  });

  it('offers no way to modify or delete', async () => {
    const { app } = await setup('ADM');
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/api/audit')).status).toBe(404);
    }
  });
});
