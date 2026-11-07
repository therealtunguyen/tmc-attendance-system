import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { hashToken } from './iam.auth.js';
import { chainHash, GENESIS_HASH } from './iam.audit-chain.js';
import { InMemoryUsers } from './iam.fakes.js';
import { requirePermission } from './iam.rbac.js';
import { authenticate, iamRoutes, requireNoticeAck } from './iam.routes.js';
import {
  IamService,
  MAX_NOTICE_LENGTH,
  NOTICE_CACHE_TTL_MS,
  type AuditEntry,
  type AuditStore,
  type ChainedEntry,
  type Role,
} from './iam.service.js';

class Store extends InMemoryUsers implements AuditStore {
  rows: ChainedEntry[] = [];
  async append(e: AuditEntry) {
    const prevHash = this.rows.at(-1)?.hash ?? GENESIS_HASH;
    this.rows.push({ ...e, seq: this.rows.length + 1, prevHash, hash: chainHash(prevHash, e) });
  }
  async search() {
    return [...this.rows].reverse();
  }
  async chain() {
    return this.rows;
  }
}

let now = Date.now();
let store: Store;
let iam: IamService;
let app: ReturnType<typeof createApp>;
const tokens = new Map<string, string>();

/** A signed-in user: a fully authenticated session, without going through login. */
const signIn = async (username: string, role: Role) => {
  const user = await store.createUser({ username, passwordHash: 'x', role });
  const token = `token-${username}`;
  await store.createSession({
    tokenHash: hashToken(token),
    userId: user.id,
    mfaPassed: true,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  tokens.set(username, token);
  return user.id;
};

const as = (who: string) => ({ Authorization: `Bearer ${tokens.get(who)}` });
const actions = () => store.rows.map((r) => r.action);

beforeEach(async () => {
  store = new Store();
  now = Date.now();
  iam = new IamService(store, () => now);
  const normal = Router()
    .get('/qr/token', requirePermission('self:read'), (_req, res) => void res.json({ qr: true }))
    .get('/me/qr', requirePermission('self:read'), (_req, res) => void res.json({ qr: true }))
    .get('/things', requirePermission('self:read'), (_req, res) => {
      res.json({ ok: true });
    });
  app = createApp([iamRoutes(iam, { login: false, mfa: false }), normal], {
    before: [authenticate(iam), requireNoticeAck(iam)],
  });
  await signIn('emp', 'EMP');
  await signIn('hr', 'HR');
  await signIn('adm', 'ADM');
});

const publish = (who: string, text = 'We process data for access control and attendance only.') =>
  request(app).put('/api/privacy-notice').set(as(who)).send({ text });
const ack = (who: string, version: number) =>
  request(app).post('/api/privacy-notice/ack').set(as(who)).send({ version });
const things = (who?: string) => {
  const req = request(app).get('/api/things');
  return who ? req.set(as(who)) : req;
};

describe('first-login privacy notice (NFR-20)', () => {
  it('blocks nothing while no notice is published', async () => {
    expect((await things('emp')).status).toBe(200);
    const me = await request(app).get('/api/auth/me').set(as('emp'));
    expect(me.body.noticePending).toBeNull();
    expect((await request(app).get('/api/privacy-notice').set(as('emp'))).status).toBe(404);
    expect((await ack('emp', 1)).status).toBe(404);
  });

  it('blocks normal routes with NOTICE_REQUIRED but keeps the exempt ones open', async () => {
    await publish('hr');
    const res = await things('emp');
    expect([res.status, res.body]).toEqual([
      403,
      { error: 'Privacy notice must be acknowledged', code: 'NOTICE_REQUIRED', version: 1 },
    ]);
    const me = await request(app).get('/api/auth/me').set(as('emp'));
    expect([me.status, me.body.noticePending]).toEqual([200, 1]);
    const notice = await request(app).get('/api/privacy-notice').set(as('emp'));
    expect([notice.status, notice.body.version, notice.body.text]).toEqual([
      200,
      1,
      expect.stringContaining('attendance'),
    ]);
    expect((await request(app).post('/api/auth/logout').set(as('emp'))).status).toBe(204);
  });

  it('exempts login and mfa paths, including a trailing slash', async () => {
    await publish('hr');
    const login = await request(app).post('/api/auth/login').set(as('emp')).send({});
    expect(login.status).toBe(400);
    const slash = await request(app).get('/api/auth/me/').set(as('emp'));
    expect(slash.status).toBe(200);
  });

  it('lets the user in after acknowledging, and blocks again on a new version', async () => {
    await publish('hr');
    expect((await ack('emp', 1)).status).toBe(204);
    expect((await things('emp')).status).toBe(200);
    expect((await publish('hr', 'v2 text')).body.version).toBe(2);
    const blocked = await things('emp');
    expect([blocked.status, blocked.body.version]).toEqual([403, 2]);
    expect((await ack('emp', 2)).status).toBe(204);
    expect((await things('emp')).status).toBe(200);
  });

  it('returns 409 with the current version for a stale or future version', async () => {
    await publish('hr');
    await publish('hr', 'v2');
    for (const version of [1, 3]) {
      const res = await ack('emp', version);
      expect([res.status, res.body.currentVersion]).toEqual([409, 2]);
    }
    expect((await ack('emp', 'x' as unknown as number)).status).toBe(400);
  });

  it('accepts a repeated acknowledgement but audits it once', async () => {
    await publish('hr');
    expect((await ack('emp', 1)).status).toBe(204);
    expect((await ack('emp', 1)).status).toBe(204);
    expect(actions().filter((a) => a === 'NOTICE_ACK')).toHaveLength(1);
    const entry = store.rows.find((r) => r.action === 'NOTICE_ACK')!;
    expect(entry.target).toBe('notice:1');
  });

  it('audits a publish with the version only', async () => {
    await publish('adm', 'secret text');
    const entry = store.rows.find((r) => r.action === 'NOTICE_PUBLISH')!;
    expect([entry.target, entry.after]).toEqual(['notice:1', { version: 1 }]);
    expect(store.notices[0]!.publishedBy).toBeTruthy();
  });

  it('lets HR and ADM publish but not EMP', async () => {
    expect((await publish('emp')).status).toBe(403);
    expect((await publish('hr')).status).toBe(201);
    expect((await publish('adm')).status).toBe(201);
    expect(store.notices.map((n) => n.version)).toEqual([1, 2]);
  });

  it('rejects empty, blank, too long and non-string text with 400', async () => {
    for (const text of ['', '   ', 'x'.repeat(MAX_NOTICE_LENGTH + 1)]) {
      expect((await publish('hr', text)).status).toBe(400);
    }
    const res = await request(app).put('/api/privacy-notice').set(as('hr')).send({ text: 5 });
    expect(res.status).toBe(400);
    expect((await publish('hr', 'x'.repeat(MAX_NOTICE_LENGTH))).status).toBe(201);
    expect(store.notices).toHaveLength(1);
  });

  it('does not affect requests without a user', async () => {
    await publish('hr');
    const res = await things();
    expect([res.status, res.body]).toEqual([401, { error: 'Not signed in' }]);
  });

  it('gives concurrent publishes distinct, increasing versions', async () => {
    const results = await Promise.all([1, 2, 3].map((n) => store.publishNotice(`t${n}`, 'hr')));
    expect(results.map((n) => n.version).sort()).toEqual([1, 2, 3]);
  });

  it('audits one entry for two concurrent first acks', async () => {
    await publish('hr');
    const id = [...store.users.values()].find((u) => u.username === 'emp')!.id;
    await Promise.all([iam.acknowledgeNotice(id, 1), iam.acknowledgeNotice(id, 1)]);
    expect(actions().filter((a) => a === 'NOTICE_ACK')).toHaveLength(1);
  });

  it('caches the notice: own publish shows at once, an external one after the TTL', async () => {
    await publish('hr');
    expect((await things('emp')).body.version).toBe(1);
    await publish('hr', 'v2');
    expect((await things('emp')).body.version).toBe(2);
    await store.publishNotice('v3', 'other-process');
    expect((await things('emp')).body.version).toBe(2);
    now += NOTICE_CACHE_TTL_MS + 1;
    expect((await things('emp')).body.version).toBe(3);
  });

  it('does not block /qr/token while the notice is pending, but still blocks other routes', async () => {
    await publish('hr');
    const qr = await request(app).get('/api/qr/token').set(as('emp'));
    expect([qr.status, qr.body]).toEqual([200, { qr: true }]);
    expect((await things('emp')).body.code).toBe('NOTICE_REQUIRED');
  });

  it('does not block /me/qr while the notice is pending', async () => {
    await publish('hr');
    const qr = await request(app).get('/api/me/qr').set(as('emp'));
    expect([qr.status, qr.body]).toEqual([200, { qr: true }]);
  });

  it('does not cache a read that started before a publish', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    class SlowOnce extends Store {
      slow = true;
      override async currentNotice() {
        const notice = await super.currentNotice();
        if (this.slow) {
          this.slow = false;
          await held;
        }
        return notice;
      }
    }
    const slowStore = new SlowOnce();
    await slowStore.publishNotice('v1', 'hr');
    const service = new IamService(slowStore, () => now);
    const stale = service.currentNotice();
    await service.publishNotice('hr', 'v2');
    release();
    expect((await stale)?.version).toBe(1);
    expect((await service.currentNotice())?.version).toBe(2);
  });
});
