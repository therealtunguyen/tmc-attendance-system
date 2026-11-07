import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyValue } from '../../session';
import {
  fetchLiveQr,
  LiveQrController,
  QR_REFRESH_MS,
  QrCache,
  type LiveQr,
  type QrFetch,
  type QrView,
  type ShownQr,
} from './live-qr';

const TTL_MS = 60_000;

const memory = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

const qr = (token: string): LiveQr => ({
  token,
  ttlSeconds: TTL_MS / 1000,
  firstName: 'Lan',
  lastName: 'Nguyen',
  code: 'BD-0001',
});
const ok = (token: string): QrFetch => ({ kind: 'ok', qr: qr(token) });
const down: QrFetch = { kind: 'down' };

describe('LiveQrController', () => {
  let store: ReturnType<typeof memory>;
  let cache: QrCache;
  let view: QrView;
  let serverAnswers: () => QrFetch;
  let fetchQr: ReturnType<typeof vi.fn<() => Promise<QrFetch>>>;
  let live: LiveQrController;

  const controller = () => new LiveQrController(fetchQr, cache, (next) => (view = next), Date.now);
  const shown = () => (view.kind === 'showing' ? view : null);
  const settle = () => vi.advanceTimersByTimeAsync(0);
  let serial = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    serial = 0;
    store = memory();
    cache = new QrCache(store);
    view = { kind: 'loading' };
    serverAnswers = () => ok(`t${++serial}`);
    fetchQr = vi.fn(async () => serverAnswers());
    live = controller();
  });

  afterEach(() => {
    live.stop();
    vi.useRealTimers();
  });

  it('asks at once and shows the answer', async () => {
    live.start();
    await settle();
    expect(fetchQr).toHaveBeenCalledTimes(1);
    expect(shown()).toMatchObject({ offline: false, qr: { token: 't1', firstName: 'Lan' } });
  });

  it('refreshes every 30 s, not sooner', async () => {
    expect(QR_REFRESH_MS).toBe(30_000);
    live.start();
    await settle();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchQr).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchQr).toHaveBeenCalledTimes(2);
    expect(shown()?.qr.token).toBe('t2');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown()?.qr.token).toBe('t3');
  });

  it('caches the last token, with when to stop showing it', async () => {
    live.start();
    await settle();
    expect(cache.load(Date.now())).toMatchObject({ token: 't1', showUntil: Date.now() + TTL_MS });
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    expect(cache.load(Date.now())?.token).toBe('t2');
  });

  it('keeps showing the last token when a refresh fails, marked offline', async () => {
    live.start();
    await settle();
    serverAnswers = () => down;
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    expect(shown()).toMatchObject({ offline: true, qr: { token: 't1' } });
    expect(cache.load(Date.now())?.token).toBe('t1');
  });

  it('stops showing it when it expires offline: a dead QR is worse than none', async () => {
    live.start();
    await settle();
    serverAnswers = () => down;
    await vi.advanceTimersByTimeAsync(TTL_MS - 1);
    expect(shown()?.qr.token).toBe('t1');
    await vi.advanceTimersByTimeAsync(1);
    expect(view).toEqual({ kind: 'expired' });
    expect(cache.load(Date.now())).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('expires even when the timer fires a moment before the clock says so', async () => {
    // Real browsers: setTimeout and Date.now are different clocks and can disagree by a millisecond.
    let behind = 0;
    live.stop();
    live = new LiveQrController(
      fetchQr,
      cache,
      (next) => (view = next),
      () => Date.now() - behind,
    );
    serverAnswers = () => ({ kind: 'ok', qr: { ...qr('t'), ttlSeconds: 45 } });
    live.start();
    await settle();
    serverAnswers = () => down;
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    behind = 1; // After the last refresh armed the timer, so it fires 1 ms early by this clock.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view).toEqual({ kind: 'expired' });
    expect(store.data.size).toBe(0);
  });

  it('recovers by itself when the connection returns', async () => {
    live.start();
    await settle();
    serverAnswers = () => down;
    await vi.advanceTimersByTimeAsync(TTL_MS);
    expect(view.kind).toBe('expired');
    serverAnswers = () => ok('back');
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    expect(shown()).toMatchObject({ offline: false, qr: { token: 'back' } });
  });

  it('shows a cached token right after a reload, before the server answers', async () => {
    cache.save({ ...qr('kept'), showUntil: Date.now() + 20_000 });
    serverAnswers = () => down;
    live.start();
    expect(shown()).toMatchObject({ offline: false, qr: { token: 'kept' } });
    await settle();
    expect(shown()).toMatchObject({ offline: true, qr: { token: 'kept' } });
  });

  it('expires a token loaded from the cache at the right time', async () => {
    cache.save({ ...qr('kept'), showUntil: Date.now() + 20_000 });
    serverAnswers = () => down;
    live.start();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(shown()?.qr.token).toBe('kept');
    await vi.advanceTimersByTimeAsync(1);
    expect(view).toEqual({ kind: 'expired' });
  });

  it('never shows an expired cached token', async () => {
    cache.save({ ...qr('dead'), showUntil: Date.now() - 1 });
    serverAnswers = () => down;
    live.start();
    expect(view).toEqual({ kind: 'loading' });
    await settle();
    expect(view).toEqual({ kind: 'expired' });
  });

  it('drops the token at once when the QR is revoked', async () => {
    live.start();
    await settle();
    serverAnswers = () => ({ kind: 'denied', reason: 'REVOKED' });
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    expect(view).toEqual({ kind: 'denied', reason: 'REVOKED' });
    expect(store.data.size).toBe(0);
  });

  it('does not bring a denied QR back when it runs out while offline', async () => {
    live.start();
    await settle();
    serverAnswers = () => ({ kind: 'denied', reason: 'REVOKED' });
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    serverAnswers = () => down;
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS + TTL_MS);
    expect(view).toEqual({ kind: 'denied', reason: 'REVOKED' });
  });

  it('shows the QR again after a reissue, on the next refresh', async () => {
    serverAnswers = () => ({ kind: 'denied', reason: 'REVOKED' });
    live.start();
    await settle();
    serverAnswers = () => ok('again');
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    expect(shown()?.qr.token).toBe('again');
  });

  it('drops the token when the session ends', async () => {
    live.start();
    await settle();
    serverAnswers = () => ({ kind: 'signed-out' });
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    expect(view).toEqual({ kind: 'signed-out' });
    expect(store.data.size).toBe(0);
  });

  it('on waking up, hides a token that expired during sleep while it asks for a new one', async () => {
    live.start();
    await settle();
    // A locked phone runs no timers: the clock moves, the timers did not fire.
    vi.setSystemTime(Date.now() + TTL_MS + 5_000);
    let answer!: (result: QrFetch) => void;
    fetchQr.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    void live.refresh();
    expect(view).toEqual({ kind: 'expired' });
    answer(ok('woken'));
    await settle();
    expect(shown()?.qr.token).toBe('woken');
  });

  it('asks once at a time', async () => {
    let answer!: (result: QrFetch) => void;
    fetchQr.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    live.start();
    void live.refresh();
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS);
    expect(fetchQr).toHaveBeenCalledTimes(1);
    answer(ok('one'));
    await settle();
    expect(shown()?.qr.token).toBe('one');
  });

  it('leaves no timer running after stop', async () => {
    live.start();
    await settle();
    expect(vi.getTimerCount()).toBe(2);
    live.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops asking after stop, and ignores an answer that arrives late', async () => {
    let answer!: (result: QrFetch) => void;
    fetchQr.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    live.start();
    live.stop();
    answer(ok('late'));
    await vi.advanceTimersByTimeAsync(QR_REFRESH_MS * 3);
    expect(fetchQr).toHaveBeenCalledTimes(1);
    expect(view).toEqual({ kind: 'loading' });
    expect(store.data.size).toBe(0);
  });
});

describe('QrCache', () => {
  const entry: ShownQr = { token: 't', firstName: 'L', lastName: 'N', code: 'C', showUntil: 100 };

  it('loads only what is still valid', () => {
    const cache = new QrCache(memory());
    cache.save(entry);
    expect(cache.load(99)).toEqual(entry);
    expect(cache.load(100)).toBeNull();
  });

  it.each(['not json', 'null', '{"token":5}', '{"token":"t"}'])('ignores corrupt %s', (value) => {
    const store = memory();
    store.setItem('tmc.lastQr', value);
    expect(new QrCache(store).load(0)).toBeNull();
  });

  it('works without storage and when storage throws', () => {
    const blocked: KeyValue = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    for (const cache of [new QrCache(null), new QrCache(blocked)]) {
      expect(() => cache.save(entry)).not.toThrow();
      expect(cache.load(0)).toBeNull();
      expect(() => cache.clear()).not.toThrow();
    }
  });
});

describe('fetchLiveQr', () => {
  const answer = (status: number, body: unknown = {}) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  afterEach(() => vi.unstubAllGlobals());

  it('sends the session token', async () => {
    answer(200, qr('t'));
    await fetchLiveQr('secret');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/me/qr');
    expect(init?.headers).toEqual({ authorization: 'Bearer secret' });
  });

  it('maps the answers', async () => {
    answer(200, qr('t'));
    expect(await fetchLiveQr('s')).toEqual({ kind: 'ok', qr: qr('t') });
    answer(401);
    expect(await fetchLiveQr('s')).toEqual({ kind: 'signed-out' });
    answer(403, { reason: 'REVOKED' });
    expect(await fetchLiveQr('s')).toEqual({ kind: 'denied', reason: 'REVOKED' });
  });

  it.each([500, 503])('treats %i as down, not as a denial', async (status) => {
    answer(status);
    expect(await fetchLiveQr('s')).toEqual({ kind: 'down' });
  });

  it('treats a network failure as down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await fetchLiveQr('s')).toEqual({ kind: 'down' });
  });
});
