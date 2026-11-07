import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../../app.js';
import {
  hashPassword,
  LOCKOUT_MS,
  MFA_PENDING_TTL_MS,
  newTotpSecret,
  SESSION_TTL_MS,
  totp,
} from './iam.auth.js';
import { chainHash, GENESIS_HASH } from './iam.audit-chain.js';
import { InMemoryUsers } from './iam.fakes.js';
import { authenticate, iamRoutes } from './iam.routes.js';
import {
  IamService,
  type AuditEntry,
  type AuditFilter,
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
  async search(_filter: AuditFilter) {
    return [...this.rows].reverse();
  }
  async chain() {
    return this.rows;
  }
}

const FAST = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse 42';
const SECRET = newTotpSecret();

let now: number;
let store: Store;
let iam: IamService;
let app: ReturnType<typeof createApp>;

const addUser = async (username: string, role: Role, extra: object = {}) =>
  store.createUser({
    username,
    passwordHash: await hashPassword(PASSWORD, FAST),
    role,
    ...extra,
  });

const login = (username: string, password = PASSWORD) =>
  request(app).post('/api/auth/login').send({ username, password });
const me = (token: string) =>
  request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
const mfa = (token: string, code: string) =>
  request(app).post('/api/auth/mfa').set('Authorization', `Bearer ${token}`).send({ code });
const actions = () => store.rows.map((r) => r.action);

beforeEach(async () => {
  now = Date.UTC(2026, 10, 6, 8, 0, 0);
  store = new Store();
  iam = new IamService(store, () => now);
  app = createApp([iamRoutes(iam, { login: false, mfa: false })], { before: [authenticate(iam)] });
  await addUser('emp', 'EMP', { employeeId: 'e-1' });
  await addUser('adm', 'ADM', { mfaSecret: SECRET });
  await addUser('hr-nomfa', 'HR');
});

describe('POST /api/auth/login', () => {
  it('logs a non-MFA role in; the token works with /auth/me', async () => {
    const res = await login('emp');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: expect.any(String),
      mfaRequired: false,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    const who = await me(res.body.token);
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ role: 'EMP', employeeId: 'e-1' });
    expect(who.body.scopes).toBeUndefined();
    // The raw token is never stored.
    expect([...store.sessions.values()].some((s) => s.tokenHash === res.body.token)).toBe(false);
  });

  it('returns scopes only for scoped users', async () => {
    await addUser('sup', 'SUP', { scoped: true, scopes: ['team-1'] });
    const res = await login('sup');
    expect((await me(res.body.token)).body.scopes).toEqual(['team-1']);
  });

  it('400 for missing or non-string fields', async () => {
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
    expect(
      (await request(app).post('/api/auth/login').send({ username: 1, password: 'x' })).status,
    ).toBe(400);
    expect((await login('emp', '')).status).toBe(400);
  });

  it('unknown user and wrong password give the same 401 body', async () => {
    const unknown = await login('nobody');
    const wrong = await login('emp', 'wrong password 1');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: 'Invalid username or password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('401 for an inactive user, even with the right password', async () => {
    await addUser('gone', 'EMP', { active: false });
    const res = await login('gone');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid username or password' });
  });

  it('locks after 5 wrong passwords: 423 even with the right one, unlocks after 15 minutes', async () => {
    for (let i = 0; i < 5; i++) expect((await login('emp', 'wrong password 1')).status).toBe(401);
    const locked = await login('emp');
    expect(locked.status).toBe(423);
    expect(locked.body).toEqual({ error: 'Account locked' });
    expect((await login('emp', 'wrong password 1')).status).toBe(423);
    now += LOCKOUT_MS - 1;
    expect((await login('emp')).status).toBe(423);
    now += 1;
    expect((await login('emp')).status).toBe(200);
  });

  it('a successful login resets the failure count', async () => {
    for (let i = 0; i < 4; i++) await login('emp', 'wrong password 1');
    expect((await login('emp')).status).toBe(200);
    for (let i = 0; i < 4; i++) await login('emp', 'wrong password 1');
    expect((await login('emp')).status).toBe(200);
  });

  it('403 for an MFA role without a secret', async () => {
    const res = await login('hr-nomfa');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'MFA not enrolled' });
  });
});

describe('input limits and rate limiting', () => {
  it('400 for an over-long username or password', async () => {
    expect((await login('a'.repeat(65))).status).toBe(400);
    expect((await login('emp', 'p'.repeat(257))).status).toBe(400);
    expect((await login('a'.repeat(64))).status).toBe(401);
    expect((await login('emp', 'p'.repeat(256))).status).toBe(401);
    expect(actions()).toEqual(['LOGIN_FAIL', 'LOGIN_FAIL']);
  });

  it('never stores a raw unknown username in the audit actor', async () => {
    const typed = 'my secret password 123';
    await login(typed);
    const digest = createHash('sha256').update(typed).digest('hex').slice(0, 16);
    expect(store.rows[0]!.actorId).toBe(`username-sha256:${digest}`);
    expect(JSON.stringify(store.rows)).not.toContain(typed);
  });

  it('429 with Retry-After on the 11th request in a window; a new window allows again', async () => {
    let t = 0;
    const limited = createApp([
      iamRoutes(iam, { login: { clock: () => t }, mfa: { clock: () => t } }),
    ]);
    const attempt = () =>
      request(limited).post('/api/auth/login').send({ username: 'emp', password: PASSWORD });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(200);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many attempts, try again later' });
    expect(blocked.headers['retry-after']).toBe('60');
    t += 60_000;
    expect((await attempt()).status).toBe(200);
    // /auth/mfa has its own budget.
    const mfaAttempt = () => request(limited).post('/api/auth/mfa').send({ code: '1' });
    for (let i = 0; i < 10; i++) expect((await mfaAttempt()).status).toBe(401);
    expect((await mfaAttempt()).status).toBe(429);
  });

  it('purges dead sessions on about 1% of logins', async () => {
    const { token } = (await login('emp')).body;
    await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(store.sessions.size).toBe(1);
    now += 1000;
    const calls = [0.5, 0.005];
    const purging = new IamService(
      store,
      () => now,
      () => calls.shift()!,
    );
    await purging.login('emp', PASSWORD);
    expect(store.sessions.size).toBe(2);
    await purging.login('emp', PASSWORD);
    // The revoked session is gone; the first new one and the latest remain.
    expect(store.sessions.size).toBe(2);
    expect([...store.sessions.values()].every((s) => s.revokedAt === null)).toBe(true);
  });
});

describe('MFA (FR-5.2)', () => {
  it('a pending ADM token is rejected until the right code is given', async () => {
    const res = await login('adm');
    expect(res.body).toEqual({ token: expect.any(String), mfaRequired: true });
    const { token } = res.body;
    expect((await me(token)).status).toBe(401);
    const ok = await mfa(token, totp(SECRET, now));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ expiresAt: new Date(now + SESSION_TTL_MS).toISOString() });
    expect((await me(token)).status).toBe(200);
    // Already verified: a second /auth/mfa is refused.
    expect((await mfa(token, totp(SECRET, now))).status).toBe(401);
  });

  it('401 for a wrong code, a bad token, or no header; 400 for a missing code', async () => {
    const { token } = (await login('adm')).body;
    expect((await mfa(token, '000000')).status).toBe(401);
    expect((await me(token)).status).toBe(401);
    expect((await mfa('nope', totp(SECRET, now))).status).toBe(401);
    expect((await request(app).post('/api/auth/mfa').send({ code: '1' })).status).toBe(401);
    expect(
      (await request(app).post('/api/auth/mfa').set('Authorization', `Bearer ${token}`).send({}))
        .status,
    ).toBe(400);
  });

  it('a pending session expires after 5 minutes', async () => {
    const { token } = (await login('adm')).body;
    now += MFA_PENDING_TTL_MS;
    expect((await mfa(token, totp(SECRET, now))).status).toBe(401);
  });

  it('a correct password alone does not reset the counter: login + 4 wrong codes cannot loop forever', async () => {
    let lockedAt = -1;
    for (let cycle = 0; cycle < 10 && lockedAt < 0; cycle++) {
      const res = await login('adm');
      if (res.status === 423) {
        lockedAt = cycle;
        break;
      }
      for (let i = 0; i < 4; i++) await mfa(res.body.token, '000000');
    }
    expect(lockedAt).toBeGreaterThanOrEqual(0);
    expect(lockedAt).toBeLessThanOrEqual(2);
    const adm = (await store.findUserByUsername('adm'))!;
    expect(adm.lockedUntil).not.toBeNull();
    expect((await login('adm')).status).toBe(423);
  });

  it('the 10-cycle loop never gets a valid session', async () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      const res = await login('adm');
      if (res.status === 200) for (let i = 0; i < 4; i++) await mfa(res.body.token, '000000');
    }
    expect((await store.findUserByUsername('adm'))!.lockedUntil).not.toBeNull();
    expect((await login('adm')).status).toBe(423);
  });

  it('a successful MFA resets the counter', async () => {
    const first = (await login('adm')).body.token;
    for (let i = 0; i < 4; i++) await mfa(first, '000000');
    expect((await store.findUserByUsername('adm'))!.failedLogins).toBe(4);
    expect((await mfa(first, totp(SECRET, now))).status).toBe(200);
    expect((await store.findUserByUsername('adm'))!.failedLogins).toBe(0);
  });

  it('a corrupt stored secret is a failed code, not a 500', async () => {
    const { token } = (await login('adm')).body;
    (await store.findUserByUsername('adm'))!.mfaSecret = '!!not base32!!';
    const res = await mfa(token, '123456');
    expect(res.status).toBe(401);
    expect(actions().at(-1)).toBe('MFA_FAIL');
  });

  it('wrong codes count toward the lockout', async () => {
    const { token } = (await login('adm')).body;
    for (let i = 0; i < 5; i++) await mfa(token, '000000');
    expect((await mfa(token, totp(SECRET, now))).status).toBe(401);
    expect((await login('adm')).status).toBe(423);
  });
});

describe('TOTP replay (FR-5.2)', () => {
  it('rejects a used code on a second pending session', async () => {
    const code = totp(SECRET, now);
    const first = (await login('adm')).body.token;
    const second = (await login('adm')).body.token;
    expect((await mfa(first, code)).status).toBe(200);
    expect((await mfa(second, code)).status).toBe(401);
    expect(actions().at(-1)).toBe('MFA_FAIL');
  });

  it('rejects a code from an earlier step once a later step was used', async () => {
    const earlier = totp(SECRET, now - 30_000);
    const first = (await login('adm')).body.token;
    const second = (await login('adm')).body.token;
    expect((await mfa(first, totp(SECRET, now))).status).toBe(200);
    expect((await mfa(second, earlier)).status).toBe(401);
    expect((await mfa(second, totp(SECRET, now + 30_000))).status).toBe(200);
  });
});

describe('sessions', () => {
  it('logout revokes the token', async () => {
    const { token } = (await login('emp')).body;
    const res = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect((await me(token)).status).toBe(401);
  });

  it('expires after 8 hours', async () => {
    const { token } = (await login('emp')).body;
    now += SESSION_TTL_MS - 1;
    expect((await me(token)).status).toBe(200);
    now += 1;
    expect((await me(token)).status).toBe(401);
  });

  it('stops working when the user is deactivated or locked', async () => {
    const { token } = (await login('emp')).body;
    const user = (await store.findUserByUsername('emp'))!;
    user.active = false;
    expect((await me(token)).status).toBe(401);
    user.active = true;
    user.lockedUntil = new Date(now + 1000);
    expect((await me(token)).status).toBe(401);
  });

  it('the middleware ignores a missing or malformed header', async () => {
    const { token } = (await login('emp')).body;
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    for (const header of [token, `Basic ${token}`, 'Bearer', `Bearer a b`, 'Bearer unknown']) {
      expect((await request(app).get('/api/auth/me').set('Authorization', header)).status).toBe(
        401,
      );
    }
  });
});

describe('audit (FR-4.9)', () => {
  it('records every attempt with the actor and target', async () => {
    const emp = (await store.findUserByUsername('emp'))!;
    const { token } = (await login('emp')).body;
    await login('emp', 'wrong password 1');
    await login('nobody');
    await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(actions()).toEqual(['LOGIN_OK', 'LOGIN_FAIL', 'LOGIN_FAIL', 'LOGOUT']);
    expect(store.rows[0]).toMatchObject({ actorId: emp.id, target: `user:${emp.id}` });
    expect(store.rows[2]).toMatchObject({
      actorId: expect.stringMatching(/^username-sha256:[0-9a-f]{16}$/),
      target: 'user:?',
    });
  });

  it('records locked attempts and MFA outcomes', async () => {
    for (let i = 0; i < 5; i++) await login('emp', 'wrong password 1');
    await login('emp');
    expect(actions().slice(-1)).toEqual(['LOGIN_LOCKED']);
    const { token } = (await login('adm')).body;
    await mfa(token, '000000');
    await mfa(token, totp(SECRET, now));
    expect(actions().slice(-3)).toEqual(['LOGIN_MFA_PENDING', 'MFA_FAIL', 'MFA_OK']);
  });
});
