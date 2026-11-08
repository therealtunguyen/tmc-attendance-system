import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSession,
  loadSession,
  passMfa,
  saveSession,
  signIn,
  signOut,
  type KeyValue,
} from './session';

const memory = (): KeyValue => {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

const NOW = Date.parse('2026-11-08T07:00:00Z');
const session = { token: 't', expiresAt: '2026-11-08T15:00:00Z' };

describe('stored session', () => {
  it('round-trips, then clears', () => {
    const store = memory();
    saveSession(session, store);
    expect(loadSession(store, NOW)).toEqual(session);
    clearSession(store);
    expect(loadSession(store, NOW)).toBeNull();
  });

  it('is gone once expired', () => {
    const store = memory();
    saveSession(session, store);
    expect(loadSession(store, Date.parse(session.expiresAt))).toBeNull();
  });

  it.each(['not json', 'null', '{"token":"t"}', '{"token":"t","expiresAt":"soon"}'])(
    'ignores corrupt %s',
    (value) => {
      const store = memory();
      store.setItem('tmc.session', value);
      expect(loadSession(store, NOW)).toBeNull();
    },
  );

  it('clears the cached QR with the session (ADR-10: a QR is an identity)', () => {
    const store = memory();
    saveSession(session, store);
    store.setItem('tmc.lastQr', '{"token":"a"}');
    clearSession(store);
    expect(store.getItem('tmc.lastQr')).toBeNull();
  });

  it("a new sign-in drops the previous user's cached QR", () => {
    const store = memory();
    store.setItem('tmc.lastQr', '{"token":"from-user-a"}');
    saveSession(session, store);
    expect(store.getItem('tmc.lastQr')).toBeNull();
    expect(loadSession(store, NOW)).toEqual(session);
  });

  it('clears an expired session and its QR on load: it may have ended while the page was closed', () => {
    const store = memory();
    saveSession(session, store);
    store.setItem('tmc.lastQr', '{"token":"a"}');
    expect(loadSession(store, Date.parse(session.expiresAt) + 1)).toBeNull();
    expect(store.getItem('tmc.session')).toBeNull();
    expect(store.getItem('tmc.lastQr')).toBeNull();
  });

  it('works without storage', () => {
    expect(loadSession(null, NOW)).toBeNull();
    expect(() => saveSession(session, null)).not.toThrow();
    expect(() => clearSession(null)).not.toThrow();
  });
});

describe('signing in', () => {
  const answer = (status: number, body: unknown = {}) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  const offline = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );

  afterEach(() => vi.unstubAllGlobals());

  it('signs in without MFA', async () => {
    answer(200, { token: 't', mfaRequired: false, expiresAt: session.expiresAt });
    expect(await signIn('lan', 'pw')).toEqual({ kind: 'signed-in', session });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(init?.body as string)).toEqual({ username: 'lan', password: 'pw' });
  });

  it('asks for the second factor, then keeps the same token', async () => {
    answer(200, { token: 'pending', mfaRequired: true });
    expect(await signIn('hr', 'pw')).toEqual({ kind: 'mfa', pendingToken: 'pending' });
    answer(200, { expiresAt: session.expiresAt });
    expect(await passMfa('pending', '123456')).toEqual({
      kind: 'signed-in',
      session: { token: 'pending', expiresAt: session.expiresAt },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/auth/mfa');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer pending' });
  });

  it.each([
    [401, 'Wrong username or password.'],
    [403, 'Two-factor sign-in is not set up for this account. Contact IT.'],
    [423, 'This account is locked for now. Try again later.'],
    [429, 'Too many attempts. Wait a minute and try again.'],
    [500, 'Sign-in failed. Try again.'],
  ])('explains a %i', async (status, message) => {
    answer(status);
    expect(await signIn('lan', 'pw')).toEqual({ kind: 'refused', message });
  });

  it('explains a wrong code', async () => {
    answer(401);
    expect(await passMfa('p', '000000')).toEqual({
      kind: 'refused',
      message: 'Wrong or expired code. Sign in again.',
      restart: true,
    });
  });

  it('keeps the MFA step for a failure that did not spend the code', async () => {
    answer(500);
    expect(await passMfa('p', '1')).not.toHaveProperty('restart');
    offline();
    expect(await passMfa('p', '1')).not.toHaveProperty('restart');
  });

  it.each([
    ['no expiresAt', { token: 't', mfaRequired: false }],
    ['no token', { mfaRequired: false, expiresAt: session.expiresAt }],
    ['a non-string expiresAt', { token: 't', mfaRequired: false, expiresAt: 5 }],
  ])('refuses a sign-in answer with %s instead of saving an unusable session', async (_n, body) => {
    answer(200, body);
    expect(await signIn('lan', 'pw')).toEqual({
      kind: 'refused',
      message: 'Sign-in failed. Try again.',
    });
  });

  it('refuses an MFA answer without expiresAt', async () => {
    answer(200, {});
    expect(await passMfa('p', '1')).toMatchObject({ kind: 'refused' });
  });

  it('does not throw without a connection', async () => {
    offline();
    const refused = { kind: 'refused', message: 'No connection. Try again.' };
    expect(await signIn('lan', 'pw')).toEqual(refused);
    expect(await passMfa('p', '1')).toEqual(refused);
    await expect(signOut(session)).resolves.toBeUndefined();
  });

  it('ends the session on the server', async () => {
    answer(204);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await signOut(session);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer t' });
  });
});
