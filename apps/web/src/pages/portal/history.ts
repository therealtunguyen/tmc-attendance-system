// Own profile and attendance history (FR-1.6, UC-3). Both come from the verified session.

export interface Profile {
  code: string;
  firstName: string;
  lastName: string;
  email: string;
  factoryId: string;
  teamId: string | null;
}

export interface DayRecord {
  day: string;
  firstIn: string | null;
  lastOut: string | null;
  hours: number;
  missingPunch: boolean;
}

export type HistoryDenyReason = 'NO_EMPLOYEE' | 'NOTICE_REQUIRED' | 'OTHER';

export type HistoryFetch =
  | { kind: 'ok'; profile: Profile; records: DayRecord[] }
  | { kind: 'signed-out' }
  | { kind: 'denied'; reason: HistoryDenyReason }
  | { kind: 'down' };

const FETCH_TIMEOUT_MS = 10_000;

const denyReasonOf = (body: unknown): HistoryDenyReason => {
  const { reason, code } = (body ?? {}) as { reason?: unknown; code?: unknown };
  if (reason === 'NO_EMPLOYEE') return 'NO_EMPLOYEE';
  return code === 'NOTICE_REQUIRED' ? 'NOTICE_REQUIRED' : 'OTHER';
};

const isProfile = (body: unknown): body is Profile =>
  typeof (body as Partial<Profile> | null)?.code === 'string';

const recordsOf = (body: unknown): DayRecord[] | null => {
  const records = (body as { records?: unknown } | null)?.records;
  return Array.isArray(records) ? (records as DayRecord[]) : null;
};

export const fetchHistory = async (token: string): Promise<HistoryFetch> => {
  const get = (path: string) =>
    fetch(path, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  try {
    const [profileRes, historyRes] = await Promise.all([
      get('/api/me/profile'),
      get('/api/me/attendance'),
    ]);
    if (profileRes.status === 401 || historyRes.status === 401) return { kind: 'signed-out' };
    const denied = [profileRes, historyRes].find((res) => res.status === 403);
    if (denied) {
      return { kind: 'denied', reason: denyReasonOf(await denied.json().catch(() => null)) };
    }
    if (!profileRes.ok || !historyRes.ok) return { kind: 'down' };
    const profile: unknown = await profileRes.json();
    const records = recordsOf(await historyRes.json());
    return isProfile(profile) && records ? { kind: 'ok', profile, records } : { kind: 'down' };
  } catch {
    return { kind: 'down' };
  }
};

// Always factory time, wherever the phone is set: a working day is a Vietnam day.
const VIETNAM = 'Asia/Ho_Chi_Minh';
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: VIETNAM,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: VIETNAM,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const formatDay = (iso: string): string => dayFormat.format(new Date(iso));
export const formatTime = (iso: string | null): string =>
  iso === null ? '–' : timeFormat.format(new Date(iso));
