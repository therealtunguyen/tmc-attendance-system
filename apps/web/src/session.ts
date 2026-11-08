// The signed-in session, kept across visits: an employee opens the QR page from an email link at the gate.

export interface Session {
  token: string;
  /** ISO time from the server. */
  expiresAt: string;
}

export type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, or nothing where it is blocked: the page must work without it. */
export const browserStorage = (): KeyValue | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const KEY = 'tmc.session';
/** The last QR belongs to the session that fetched it: a QR is an identity at the gate (ADR-10). */
export const LAST_QR_KEY = 'tmc.lastQr';

const remove = (store: KeyValue | null, key: string) => {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing was stored.
  }
};

/** Ends the session on this device, and with it the cached QR, whoever opens the page next. */
export const clearSession = (store: KeyValue | null = browserStorage()) => {
  remove(store, KEY);
  remove(store, LAST_QR_KEY);
};

/** An expired or unreadable session is cleared here: the page may have been closed when it ended. */
export const loadSession = (
  store: KeyValue | null = browserStorage(),
  now = Date.now(),
): Session | null => {
  let raw: string | null;
  try {
    raw = store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const session = JSON.parse(raw) as Partial<Session> | null;
    if (
      typeof session?.token === 'string' &&
      typeof session.expiresAt === 'string' &&
      new Date(session.expiresAt).getTime() > now
    ) {
      return { token: session.token, expiresAt: session.expiresAt };
    }
  } catch {
    // Corrupt: cleared below.
  }
  clearSession(store);
  return null;
};

/** A new session starts with no cached QR, so it can never show the previous user's. */
export const saveSession = (session: Session, store: KeyValue | null = browserStorage()) => {
  remove(store, LAST_QR_KEY);
  try {
    store?.setItem(KEY, JSON.stringify(session));
  } catch {
    // Full or blocked storage: the session lasts until the page closes.
  }
};

export type SignIn =
  | { kind: 'signed-in'; session: Session }
  /** HR and ADM must pass a second factor with this pending token (FR-5.2). */
  | { kind: 'mfa'; pendingToken: string }
  /** restart: the pending MFA token is spent, so the form must ask for the password again. */
  | { kind: 'refused'; message: string; restart?: boolean };

const NO_CONNECTION: SignIn = { kind: 'refused', message: 'No connection. Try again.' };

const FAILED: SignIn = { kind: 'refused', message: 'Sign-in failed. Try again.' };

const REFUSED: Record<number, string> = {
  400: 'Enter your username and password.',
  401: 'Wrong username or password.',
  403: 'Two-factor sign-in is not set up for this account. Contact IT.',
  423: 'This account is locked for now. Try again later.',
  429: 'Too many attempts. Wait a minute and try again.',
};

const post = (path: string, body: object, token?: string) =>
  fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

export const signIn = async (username: string, password: string): Promise<SignIn> => {
  try {
    const res = await post('/api/auth/login', { username, password });
    if (!res.ok) {
      return { kind: 'refused', message: REFUSED[res.status] ?? 'Sign-in failed. Try again.' };
    }
    const body = (await res.json()) as {
      token?: unknown;
      mfaRequired?: unknown;
      expiresAt?: unknown;
    };
    if (typeof body.token !== 'string') return FAILED;
    if (body.mfaRequired === true) return { kind: 'mfa', pendingToken: body.token };
    // A session we cannot date would be saved and then thrown away on the next load.
    if (typeof body.expiresAt !== 'string') return FAILED;
    return { kind: 'signed-in', session: { token: body.token, expiresAt: body.expiresAt } };
  } catch {
    return NO_CONNECTION;
  }
};

export const passMfa = async (pendingToken: string, code: string): Promise<SignIn> => {
  try {
    const res = await post('/api/auth/mfa', { code }, pendingToken);
    // The server does not say which: a wrong code, or a pending token that expired. Either way, start over.
    if (res.status === 401) {
      return { kind: 'refused', message: 'Wrong or expired code. Sign in again.', restart: true };
    }
    if (!res.ok) return FAILED;
    const { expiresAt } = (await res.json()) as { expiresAt?: unknown };
    if (typeof expiresAt !== 'string') return FAILED;
    return { kind: 'signed-in', session: { token: pendingToken, expiresAt } };
  } catch {
    return NO_CONNECTION;
  }
};

/** Best effort: the local sign-out must work without a connection. */
export const signOut = async (session: Session) => {
  await post('/api/auth/logout', {}, session.token).catch(() => undefined);
};
