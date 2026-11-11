export type Outcome = 'GRANTED' | 'DENIED' | 'PENDING';

export interface GuardGate {
  id: string;
  name: string;
  factoryId: string;
  direction: 'IN' | 'OUT';
  active: boolean;
  status: 'ONLINE' | 'OFFLINE';
}

export interface AccessRow {
  eventId: string;
  occurredAt: string;
  gateId: string;
  gateName: string | null;
  factoryId: string | null;
  method: 'QR' | 'MANUAL';
  outcome: Outcome;
  denyReason: string | null;
  guardId: string | null;
  overrideReason: string | null;
  employeeCode: string | null;
  firstName: string | null;
}

export interface LogFilters {
  from: string;
  through: string;
  gateId: string;
  outcome: Outcome | '';
}

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string; code?: 'NOTICE_REQUIRED' };

const TIMEOUT_MS = 10_000;
export const LOG_LIMIT = 500;
const DAY_MS = 86_400_000;

export const vietnamDay = (now = new Date()): string =>
  new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Date controls refer to inclusive Vietnam days; the API uses an exclusive upper bound. */
export const logQuery = (filters: LogFilters): URLSearchParams | null => {
  const day = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const time = Date.parse(`${value}T00:00:00+07:00`);
    return Number.isFinite(time) && vietnamDay(new Date(time)) === value ? time : NaN;
  };
  const from = day(filters.from);
  const to = day(filters.through) + DAY_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * DAY_MS) {
    return null;
  }
  const query = new URLSearchParams({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    limit: String(LOG_LIMIT),
  });
  if (filters.gateId) query.set('gateId', filters.gateId);
  if (filters.outcome) query.set('outcome', filters.outcome);
  return query;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown) => value === null || text(value);
const isOutcome = (value: unknown): value is Outcome =>
  value === 'GRANTED' || value === 'DENIED' || value === 'PENDING';

const isGate = (value: unknown): value is GuardGate =>
  isObject(value) &&
  ['id', 'name', 'factoryId'].every((key) => text(value[key])) &&
  (value.direction === 'IN' || value.direction === 'OUT') &&
  typeof value.active === 'boolean' &&
  (value.status === 'ONLINE' || value.status === 'OFFLINE');

const isRow = (value: unknown): value is AccessRow =>
  isObject(value) &&
  ['eventId', 'gateId'].every((key) => text(value[key])) &&
  text(value.occurredAt) &&
  Number.isFinite(Date.parse(value.occurredAt)) &&
  (value.method === 'QR' || value.method === 'MANUAL') &&
  isOutcome(value.outcome) &&
  [
    'gateName',
    'factoryId',
    'denyReason',
    'guardId',
    'overrideReason',
    'employeeCode',
    'firstName',
  ].every((key) => nullableText(value[key]));

const failure = async (res: Response): Promise<ApiResult<never>> => {
  if (res.status === 401) return { kind: 'signed-out' };
  const body: unknown = await res.json().catch(() => null);
  if (isObject(body) && body.code === 'NOTICE_REQUIRED') {
    return {
      kind: 'error',
      code: 'NOTICE_REQUIRED',
      message: 'Review and acknowledge the privacy notice to continue.',
    };
  }
  return {
    kind: 'error',
    message:
      res.status === 403
        ? 'This account does not have guard access.'
        : isObject(body) && text(body.error)
          ? body.error
          : 'The service is unavailable. Try refreshing.',
  };
};

async function get<T>(
  token: string,
  path: string,
  parse: (body: unknown) => T | null,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return await failure(res);
    const data = parse(await res.json());
    return data === null
      ? { kind: 'error', message: 'Invalid response from the service. Try refreshing.' }
      : { kind: 'ok', data };
  } catch {
    return { kind: 'error', message: 'Could not connect. Check your connection and refresh.' };
  }
}

export const fetchGuardGates = async (token: string): Promise<ApiResult<GuardGate[]>> => {
  const identity = await get(token, '/api/auth/me', (body) =>
    isObject(body) && text(body.role) ? body.role : null,
  );
  if (identity.kind !== 'ok') return identity;
  if (identity.data !== 'GRD') {
    return { kind: 'error', message: 'This account does not have guard access.' };
  }
  return get(token, '/api/gates', (body) =>
    Array.isArray(body) && body.every(isGate) ? body : null,
  );
};

export const fetchAccessLog = (token: string, query: URLSearchParams) =>
  get<AccessRow[]>(token, `/api/access-log?${query}`, (body) =>
    isObject(body) && Array.isArray(body.rows) && body.rows.every(isRow) ? body.rows : null,
  );

export interface PrivacyNotice {
  version: number;
  text: string;
}

export const fetchPrivacyNotice = (token: string) =>
  get<PrivacyNotice>(token, '/api/privacy-notice', (body) =>
    isObject(body) &&
    typeof body.version === 'number' &&
    Number.isInteger(body.version) &&
    body.version > 0 &&
    text(body.text)
      ? { version: body.version, text: body.text }
      : null,
  );

export const acknowledgePrivacyNotice = async (
  token: string,
  version: number,
): Promise<ApiResult<null>> => {
  try {
    const res = await fetch('/api/privacy-notice/ack', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? { kind: 'ok', data: null } : await failure(res);
  } catch {
    return { kind: 'error', message: 'Could not acknowledge the notice. Check your connection.' };
  }
};

export interface OverrideInput {
  eventId: string;
  employeeId: string;
  reason: string;
  mode: 'OPEN' | 'BACKFILL';
  occurredAt?: string;
}

export type OverrideResult =
  | { kind: 'decided'; outcome: 'GRANTED' | 'DENIED' }
  | { kind: 'unknown' }
  | { kind: 'rejected'; message: string; code?: 'NOTICE_REQUIRED' }
  | { kind: 'signed-out' };

/** No retry: a lost response can follow a physical open or an already committed event. */
export async function submitOverride(
  token: string,
  gateId: string,
  input: OverrideInput,
): Promise<OverrideResult> {
  try {
    const res = await fetch(`/api/gates/${encodeURIComponent(gateId)}/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 409 can mean the event already exists; 5xx may happen after the gate opened.
    if (res.status === 409 || res.status >= 500) return { kind: 'unknown' };
    if (!res.ok) {
      const result = await failure(res);
      return result.kind === 'signed-out'
        ? result
        : {
            kind: 'rejected',
            message: result.kind === 'error' ? result.message : 'Override refused.',
            ...(result.kind === 'error' && result.code ? { code: result.code } : {}),
          };
    }
    const body: unknown = await res.json();
    return isObject(body) &&
      body.eventId === input.eventId &&
      (body.outcome === 'GRANTED' || body.outcome === 'DENIED')
      ? { kind: 'decided', outcome: body.outcome }
      : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}
