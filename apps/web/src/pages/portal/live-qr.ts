// The live QR's behaviour (FR-1.2, FR-1.3, ADR-10), apart from React so it can be tested on its own.
import { browserStorage, LAST_QR_KEY, type KeyValue } from '../../session';

export const QR_REFRESH_MS = 30_000;

export interface LiveQr {
  token: string;
  ttlSeconds: number;
  firstName: string;
  lastName: string;
  code: string;
}

const REASONS = ['REVOKED', 'INACTIVE', 'UNKNOWN', 'NO_EMPLOYEE'] as const;

/** OTHER: a 403 this page does not know, e.g. another middleware's. Still no QR, with a generic message. */
export type DenyReason = (typeof REASONS)[number] | 'OTHER';

const reasonOf = (body: unknown): DenyReason => {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return REASONS.find((known) => known === reason) ?? 'OTHER';
};

const isLiveQr = (body: unknown): body is LiveQr => {
  const qr = body as Partial<LiveQr> | null;
  return typeof qr?.token === 'string' && typeof qr.ttlSeconds === 'number';
};

export type QrFetch =
  | { kind: 'ok'; qr: LiveQr }
  | { kind: 'signed-out' }
  | { kind: 'denied'; reason: DenyReason }
  /** No connection, or the server cannot answer now: try again on the next refresh. */
  | { kind: 'down' };

const FETCH_TIMEOUT_MS = 10_000;

export const fetchLiveQr = async (token: string): Promise<QrFetch> => {
  try {
    const res = await fetch('/api/me/qr', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) return { kind: 'signed-out' };
    // A 403 is a denial whatever its body says; only the message depends on it.
    if (res.status === 403) {
      return { kind: 'denied', reason: reasonOf(await res.json().catch(() => null)) };
    }
    if (!res.ok) return { kind: 'down' };
    const body: unknown = await res.json();
    return isLiveQr(body) ? { kind: 'ok', qr: body } : { kind: 'down' };
  } catch {
    return { kind: 'down' };
  }
};

/** The last token, and when this device must stop showing it. */
export interface ShownQr extends Omit<LiveQr, 'ttlSeconds'> {
  /**
   * This device's clock: ttlSeconds counted from when it asked, not from the answer, so a slow
   * response never stretches it past the server's exp. A wrong phone clock does no harm either.
   */
  showUntil: number;
}

interface CachedQr extends ShownQr {
  owner: string;
}

/**
 * Survives a reload: the signal at a gate can be poor. Each entry carries the session that fetched it,
 * and any other session ignores it, so one person's QR is never shown to the next (ADR-10).
 */
export class QrCache {
  constructor(
    private store: KeyValue | null,
    private owner: string,
  ) {}

  load(now: number): ShownQr | null {
    try {
      const qr = JSON.parse(this.store?.getItem(LAST_QR_KEY) ?? 'null') as CachedQr | null;
      if (typeof qr?.token !== 'string' || typeof qr.showUntil !== 'number') return null;
      if (qr.owner !== this.owner || qr.showUntil <= now) return null;
      const { token, firstName, lastName, code, showUntil } = qr;
      return { token, firstName, lastName, code, showUntil };
    } catch {
      return null;
    }
  }

  save(qr: ShownQr) {
    try {
      this.store?.setItem(LAST_QR_KEY, JSON.stringify({ ...qr, owner: this.owner }));
    } catch {
      // The on-screen QR still works; only a reload without signal loses it.
    }
  }

  clear() {
    try {
      this.store?.removeItem(LAST_QR_KEY);
    } catch {
      // Nothing was stored.
    }
  }
}

/** The cache for one session. */
export const qrCacheFor = (sessionToken: string) => new QrCache(browserStorage(), sessionToken);

export type QrView =
  | { kind: 'loading' }
  /** offline: this is the last token, the refresh failed. */
  | { kind: 'showing'; qr: ShownQr; offline: boolean }
  | { kind: 'denied'; reason: DenyReason }
  /** No connection and the last token has expired: a scan would only be refused. */
  | { kind: 'expired' }
  | { kind: 'signed-out' };

export class LiveQrController {
  private view: QrView = { kind: 'loading' };
  private refreshTimer?: ReturnType<typeof setInterval>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private fetching = false;
  private stopped = true;

  constructor(
    private fetchQr: () => Promise<QrFetch>,
    private cache: QrCache,
    private onChange: (view: QrView) => void,
    private now: () => number = Date.now,
  ) {}

  start() {
    this.stopped = false;
    const cached = this.cache.load(this.now());
    if (cached) this.show(cached, false);
    else this.publish({ kind: 'loading' });
    this.refreshTimer = setInterval(() => void this.refresh(), QR_REFRESH_MS);
    void this.refresh();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.refreshTimer);
    clearTimeout(this.expiryTimer);
  }

  /** Also for the moment the phone wakes up: timers do not run while it is locked. */
  async refresh() {
    if (this.fetching || this.stopped) return;
    this.expireIfDue();
    this.fetching = true;
    const asked = this.now();
    const result = await this.fetchQr();
    this.fetching = false;
    if (this.stopped) return;
    switch (result.kind) {
      case 'ok':
        return this.fresh(result.qr, asked);
      case 'down':
        return this.lostConnection();
      case 'denied':
        this.cache.clear();
        return this.publish({ kind: 'denied', reason: result.reason });
      case 'signed-out':
        this.cache.clear();
        return this.publish({ kind: 'signed-out' });
    }
  }

  private fresh({ ttlSeconds, ...qr }: LiveQr, asked: number) {
    const shown = { ...qr, showUntil: asked + ttlSeconds * 1000 };
    this.cache.save(shown);
    this.show(shown, false);
  }

  private lostConnection() {
    if (this.view.kind === 'showing') this.show(this.view.qr, true);
    else if (this.view.kind === 'loading') this.publish({ kind: 'expired' });
  }

  private show(qr: ShownQr, offline: boolean) {
    this.publish({ kind: 'showing', qr, offline });
    clearTimeout(this.expiryTimer);
    // The timer itself decides: it can fire a moment before Date.now agrees, and nothing re-checks soon.
    this.expiryTimer = setTimeout(() => this.expire(), qr.showUntil - this.now());
  }

  private expireIfDue() {
    if (this.view.kind === 'showing' && this.view.qr.showUntil <= this.now()) this.expire();
  }

  private expire() {
    if (this.view.kind !== 'showing') return;
    this.cache.clear();
    this.publish({ kind: 'expired' });
  }

  private publish(view: QrView) {
    this.view = view;
    this.onChange(view);
  }
}
