import { useEffect, useState, type FormEvent } from 'react';
import { clearSession, loadSession, signOut, type Session } from '../../session';
import { formatDay } from '../portal/history';
import { SignInForm } from '../portal/SignInForm';
import {
  fetchCorrections,
  fetchEmployees,
  fetchRecords,
  submitCorrection,
  type ApiResult,
  type CorrectableRecord,
  type CorrectionEntry,
  type CorrectionField,
  type EmployeeOption,
} from './corrections';
import { CorrectionHistory, FIELD_LABEL, RecordsTable } from './CorrectionsScreen';

const field = { display: 'block', width: '100%', padding: 8, marginBottom: 12 };

function Panel({ session, onEnd }: { session: Session; onEnd: () => void }) {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [records, setRecords] = useState<CorrectableRecord[] | null>(null);
  const [open, setOpen] = useState<CorrectableRecord | null>(null);
  const [entries, setEntries] = useState<CorrectionEntry[]>([]);
  const [target, setTarget] = useState<CorrectionField>('LAST_OUT');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');

  /** The value, or null once the problem has been shown or the session has ended. */
  const unwrap = <T,>(result: ApiResult<T>): T | null => {
    if (result.kind === 'ok') return result.value;
    if (result.kind === 'signed-out') onEnd();
    if (result.kind === 'denied') setMessage('Only HR can correct attendance.');
    if (result.kind === 'refused') setMessage(result.message);
    if (result.kind === 'down') setMessage('Could not reach the server. Try again.');
    return null;
  };

  useEffect(() => {
    void fetchEmployees(session.token).then((result) => {
      const list = unwrap(result);
      if (list) setEmployees(list);
    });
    // Once per session: unwrap only reports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const load = async () => {
    const list = unwrap(await fetchRecords(session.token, employeeId, from, to));
    if (list) setRecords(list);
    return list;
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    setOpen(null);
    await load();
  };

  const openRecord = async (record: CorrectableRecord) => {
    setMessage('');
    setOpen(record);
    setTime('');
    setReason('');
    const list = unwrap(await fetchCorrections(session.token, record.recordId));
    setEntries(list ?? []);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!open) return;
    setMessage('');
    const saved = unwrap(
      await submitCorrection(session.token, open.recordId, target, time, reason),
    );
    if (!saved) return;
    setMessage('Correction saved. If this month was already exported, re-run the export.');
    const list = await load();
    const updated = list?.find((record) => record.recordId === open.recordId);
    if (updated) await openWithoutClearing(updated);
    setTime('');
    setReason('');
  };

  const openWithoutClearing = async (record: CorrectableRecord) => {
    setOpen(record);
    setEntries(unwrap(await fetchCorrections(session.token, record.recordId)) ?? []);
  };

  const leave = () => {
    void signOut(session);
    onEnd();
  };

  return (
    <section>
      <h2>Correct attendance</h2>
      <form onSubmit={(event) => void search(event)} style={{ maxWidth: 480 }}>
        <label>
          Employee
          <select
            style={field}
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            required
          >
            <option value="">Choose…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.code}: {e.firstName} {e.lastName}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            style={field}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            required
          />
        </label>
        <label>
          To
          <input
            style={field}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            required
          />
        </label>
        <button type="submit">Show records</button>
      </form>

      {message && <p role="status">{message}</p>}
      {records && <RecordsTable records={records} onOpen={(r) => void openRecord(r)} />}

      {open && (
        <section>
          <h3>{formatDay(open.day)}</h3>
          <CorrectionHistory entries={entries} />
          <form onSubmit={(event) => void save(event)} style={{ maxWidth: 480, marginTop: 12 }}>
            <label>
              Value to change
              <select
                style={field}
                value={target}
                onChange={(event) => setTarget(event.target.value as CorrectionField)}
              >
                {(Object.keys(FIELD_LABEL) as CorrectionField[]).map((key) => (
                  <option key={key} value={key}>
                    {FIELD_LABEL[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              New time (Vietnam)
              <input
                style={field}
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                required
              />
            </label>
            <label>
              Reason
              <textarea
                style={field}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                required
              />
            </label>
            <button type="submit">Save correction</button>
          </form>
        </section>
      )}

      <p>
        <button type="button" onClick={leave}>
          Sign out
        </button>
      </p>
    </section>
  );
}

/** HR corrects a daily record, with a reason (FR-3.6, UC-8). */
export function CorrectionsPage() {
  const [session, setSession] = useState(() => loadSession());
  const end = () => {
    clearSession();
    setSession(null);
  };
  if (!session) {
    return <SignInForm onSignedIn={setSession} title="Sign in to correct attendance" />;
  }
  return <Panel session={session} onEnd={end} />;
}
