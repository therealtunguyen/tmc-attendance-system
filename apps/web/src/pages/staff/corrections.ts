// HR corrects attendance (FR-3.6, UC-8). The server decides who may, and checks every rule again.
import type { DayRecord } from '../portal/history';

export interface EmployeeOption {
  id: string;
  code: string;
  firstName: string;
  lastName: string;
}

export interface CorrectableRecord extends DayRecord {
  recordId: string;
}

export type CorrectionField = 'FIRST_IN' | 'LAST_OUT';

export interface CorrectionEntry {
  field: CorrectionField;
  originalValue: string | null;
  correctedValue: string;
  reason: string;
  correctedBy: string;
  createdAt: string;
}

export type ApiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'signed-out' }
  | { kind: 'denied' }
  /** The server refused the request and says why, in words HR can act on. */
  | { kind: 'refused'; message: string }
  | { kind: 'down' };

const FETCH_TIMEOUT_MS = 10_000;

const call = async <T>(
  token: string,
  path: string,
  read: (body: unknown) => T | null,
  send?: object,
): Promise<ApiResult<T>> => {
  try {
    const res = await fetch(path, {
      method: send ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(send ? { 'content-type': 'application/json' } : {}),
      },
      body: send ? JSON.stringify(send) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) return { kind: 'signed-out' };
    if (res.status === 403) return { kind: 'denied' };
    if (res.status === 400 || res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return typeof body?.error === 'string'
        ? { kind: 'refused', message: body.error }
        : { kind: 'down' };
    }
    if (!res.ok) return { kind: 'down' };
    const value = read(await res.json());
    return value === null ? { kind: 'down' } : { kind: 'ok', value };
  } catch {
    return { kind: 'down' };
  }
};

const listIn =
  <T>(key?: string) =>
  (body: unknown): T[] | null => {
    const list = key ? (body as Record<string, unknown> | null)?.[key] : body;
    return Array.isArray(list) ? (list as T[]) : null;
  };

/** The whole of a Vietnam date, as the instants the API takes. */
export const vnDayStart = (date: string) => `${date}T00:00:00+07:00`;
/** A time HR types is factory time, whatever the computer is set to. */
export const vnInstant = (date: string, time: string) => `${date}T${time}:00+07:00`;
/** The date in a record ID: <employeeId>_<YYYY-MM-DD>. */
export const dateOfRecord = (recordId: string) => recordId.slice(recordId.lastIndexOf('_') + 1);

export const fetchEmployees = (token: string) =>
  call(token, '/api/employees', listIn<EmployeeOption>());

export const fetchRecords = (token: string, employeeId: string, from: string, to: string) => {
  const query = new URLSearchParams({
    employeeId,
    from: vnDayStart(from),
    to: vnDayStart(to),
  });
  return call(token, `/api/attendance/records?${query}`, listIn<CorrectableRecord>('records'));
};

export const fetchCorrections = (token: string, recordId: string) =>
  call(
    token,
    `/api/attendance/${encodeURIComponent(recordId)}/corrections`,
    listIn<CorrectionEntry>('corrections'),
  );

export const submitCorrection = (
  token: string,
  recordId: string,
  field: CorrectionField,
  time: string,
  reason: string,
) =>
  call(
    token,
    `/api/attendance/${encodeURIComponent(recordId)}/corrections`,
    (body) => body as DayRecord | null,
    { field, value: vnInstant(dateOfRecord(recordId), time), reason },
  );
