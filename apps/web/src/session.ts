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

export const loadSession = (
  store: KeyValue | null = browserStorage(),
  now = Date.now(),
): Session | null => {
  try {
    const session = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<Session> | null;
    if (typeof session?.token !== 'string' || typeof session.expiresAt !== 'string') return null;
    if (!(new Date(session.expiresAt).getTime() > now)) return null;
    return { token: session.token, expiresAt: session.expiresAt };
  } catch {
    return null;
  }
};

export const saveSession = (session: Session, store: KeyValue | null = browserStorage()) => {
  try {
    store?.setItem(KEY, JSON.stringify(session));
  } catch {
    // Full or blocked storage: the session lasts until the page closes.
  }
};

export const clearSession = (store: KeyValue | null = browserStorage()) => {
  try {
    store?.removeItem(KEY);
  } catch {
    // Nothing was stored.
  }
};

export type SignIn =
  | { kind: 'signed-in'; session: Session }
  /** HR and ADM must pass a second factor with this pending token (FR-5.2). */
  | { kind: 'mfa'; pendingToken: string }
  | { kind: 'refused'; message: string };

const NO_CONNECTION: SignIn = { kind: 'refused', message: 'No connection. Try again.' };

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
    const body = (await res.json()) as { token: string; mfaRequired: boolean; expiresAt?: string };
    if (body.mfaRequired) return { kind: 'mfa', pendingToken: body.token };
    return { kind: 'signed-in', session: { token: body.token, expiresAt: body.expiresAt ?? '' } };
  } catch {
    return NO_CONNECTION;
  }
};

export const passMfa = async (pendingToken: string, code: string): Promise<SignIn> => {
  try {
    const res = await post('/api/auth/mfa', { code }, pendingToken);
    if (res.status === 401) return { kind: 'refused', message: 'Wrong or expired code.' };
    if (!res.ok) return { kind: 'refused', message: 'Sign-in failed. Try again.' };
    const { expiresAt } = (await res.json()) as { expiresAt: string };
    return { kind: 'signed-in', session: { token: pendingToken, expiresAt } };
  } catch {
    return NO_CONNECTION;
  }
};

/** Best effort: the local sign-out must work without a connection. */
export const signOut = async (session: Session) => {
  await post('/api/auth/logout', {}, session.token).catch(() => undefined);
};
