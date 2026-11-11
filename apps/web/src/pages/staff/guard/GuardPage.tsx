import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { clearSession, loadSession, signOut, type Session } from '../../../session';
import { SignInForm } from '../../portal/SignInForm';
import {
  acknowledgePrivacyNotice,
  fetchPrivacyNotice,
  fetchAccessLog,
  type PrivacyNotice,
  fetchGuardGates,
  LOG_LIMIT,
  logQuery,
  submitOverride,
  vietnamDay,
  type AccessRow,
  type ApiResult,
  type GuardGate,
  type LogFilters,
  type Outcome,
  type OverrideInput,
  type OverrideResult,
} from './guard-api';
import {
  GuardLanguageContext,
  guardText as gt,
  useGuardString,
  type GuardLanguage,
} from './guard.i18n';
import './guard.css';

const timestamp = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  dateStyle: 'short',
  timeStyle: 'medium',
});
const formatTime = (iso: string) => timestamp.format(new Date(iso));

function GuardDialog({
  title,
  children,
  onClose,
  side = false,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  side?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`guard-dialog ${side ? 'guard-drawer' : ''}`}
      aria-labelledby={heading}
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="guard-dialog-heading">
        <h2 id={heading}>{title}</h2>
        <button type="button" onClick={onClose}>
          {gt('Close')}
        </button>
      </div>
      {children}
    </dialog>
  );
}

function EventDetails({ row, onClose }: { row: AccessRow; onClose: () => void }) {
  return (
    <GuardDialog
      title={row.firstName ?? row.employeeCode ?? gt('Unidentified')}
      side
      onClose={onClose}
    >
      <dl className="guard-detail-list">
        {[
          ['Employee', row.employeeCode],
          ['Time', formatTime(row.occurredAt)],
          ['Gate', row.gateName ?? row.gateId],
          ['Factory', row.factoryId],
          ['Method', row.method],
          ['Outcome', row.outcome],
          ['Denied:', row.denyReason],
          ['Override:', row.overrideReason],
          ['Guard:', row.guardId],
          ['Event:', row.eventId],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{gt(label!)}</dt>
            <dd>{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </GuardDialog>
  );
}

export function AccessLogTable({ rows }: { rows: AccessRow[] }) {
  const t = useGuardString();
  const [selected, setSelected] = useState<AccessRow | null>(null);
  if (rows.length === 0) return <p>{gt('No access events match these filters.')}</p>;
  return (
    <>
      {selected && <EventDetails row={selected} onClose={() => setSelected(null)} />}
      <div
        className="guard-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={t('Access events')}
      >
        <table>
          <caption>{gt('Newest events first · Vietnam time (UTC+7)')}</caption>
          <thead>
            <tr>
              <th scope="col">{gt('Time')}</th>
              <th scope="col">{gt('Employee')}</th>
              <th scope="col">{gt('Gate / factory')}</th>
              <th scope="col">{gt('Method')}</th>
              <th scope="col">{gt('Outcome')}</th>
              <th scope="col">{gt('Details')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.eventId}>
                <td>
                  <time dateTime={row.occurredAt}>{formatTime(row.occurredAt)}</time>
                </td>
                <td>
                  {row.employeeCode ?? gt('Unidentified')}
                  {row.firstName && <> · {row.firstName}</>}
                </td>
                <td>
                  {row.gateName ?? row.gateId}
                  <small>{row.factoryId ?? gt('Unknown factory')}</small>
                </td>
                <td>{row.method}</td>
                <td>
                  <strong className={`guard-outcome guard-outcome-${row.outcome.toLowerCase()}`}>
                    {row.outcome}
                  </strong>
                </td>
                <td>
                  <button type="button" onClick={() => setSelected(row)}>
                    {gt('View details')}
                  </button>
                  {row.denyReason && (
                    <div>
                      {gt('Denied:')} {row.denyReason}
                    </div>
                  )}
                  {row.overrideReason && (
                    <div>
                      {gt('Override:')} {row.overrideReason}
                    </div>
                  )}
                  {row.guardId && (
                    <div>
                      {gt('Guard:')} {row.guardId}
                    </div>
                  )}
                  <small>
                    {gt('Event:')} {row.eventId}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GuardNotice({
  token,
  onEnd,
  onDone,
}: {
  token: string;
  onEnd: () => void;
  onDone: () => void;
}) {
  const noticeHeadingId = useId();
  const [notice, setNotice] = useState<ApiResult<PrivacyNotice> | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    void fetchPrivacyNotice(token).then((result) => {
      if (!current) return;
      if (result.kind === 'signed-out') onEnd();
      else setNotice(result);
    });
    return () => {
      current = false;
    };
  }, [token, onEnd, revision]);
  return (
    <section className="guard-card guard-notice" aria-labelledby={noticeHeadingId}>
      <h3 id={noticeHeadingId}>{gt('Privacy notice')}</h3>
      {!notice && <p role="status">{gt('Loading notice…')}</p>}
      {notice?.kind === 'error' && <p role="alert">{gt(notice.message)}</p>}
      {notice?.kind === 'ok' && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!accepted || busy) return;
            setBusy(true);
            setError('');
            const result = await acknowledgePrivacyNotice(token, notice.data.version);
            setBusy(false);
            if (result.kind === 'signed-out') onEnd();
            else if (result.kind === 'ok') onDone();
            else setError(result.message);
          }}
        >
          <p className="guard-notice-text">{notice.data.text}</p>
          <label className="guard-confirm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              disabled={busy}
              required
            />
            {gt('I have read privacy notice v')}
            {notice.data.version}.
          </label>
          <button className="guard-primary" type="submit" disabled={!accepted || busy}>
            {gt(busy ? 'Saving…' : 'Acknowledge and continue')}
          </button>
        </form>
      )}
      {error && <p role="alert">{gt(error)}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setNotice(null);
          setAccepted(false);
          setError('');
          setRevision((value) => value + 1);
        }}
      >
        {gt('Reload notice')}
      </button>
    </section>
  );
}

function AccessLog({ token, query, onEnd }: { token: string; query: string; onEnd: () => void }) {
  const [result, setResult] = useState<ApiResult<AccessRow[]> | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const searchPlaceholder = useGuardString()('Employee code, name or event ID');

  useEffect(() => {
    let current = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      const next = await fetchAccessLog(token, new URLSearchParams(query));
      if (current) {
        if (next.kind === 'signed-out') onEnd();
        else {
          setResult(next);
          if (next.kind === 'ok') setUpdatedAt(new Date().toISOString());
        }
      }
      busy = false;
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [token, query, refresh, onEnd]);

  return (
    <>
      <div className="guard-toolbar">
        <p role="status">
          {!result ? (
            gt('Loading access log…')
          ) : updatedAt ? (
            <>
              {gt('Last updated:')} {formatTime(updatedAt)}
            </>
          ) : (
            ''
          )}
          {' · '}
          {gt('Refreshes every 15 seconds')}
        </p>
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>
          {gt('Refresh log')}
        </button>
      </div>
      {result?.kind === 'error' && (
        <p role="alert">
          {gt(result.message)} {gt('The log is not up to date.')}
        </p>
      )}
      {result?.kind === 'error' && result.code === 'NOTICE_REQUIRED' && (
        <GuardNotice token={token} onEnd={onEnd} onDone={() => setRefresh((value) => value + 1)} />
      )}
      {result?.kind === 'ok' && (
        <>
          <label className="guard-log-search">
            {gt('Search loaded events')}
            <input
              type="search"
              value={search}
              placeholder={searchPlaceholder}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <AccessLogTable
            rows={result.data.filter((row) =>
              [row.employeeCode, row.firstName, row.eventId].some((value) =>
                value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
              ),
            )}
          />
          {result.data.length === LOG_LIMIT && (
            <p role="status">
              {gt('Showing the newest')} {LOG_LIMIT}{' '}
              {gt('events. Narrow the date range, gate or outcome to see other events.')}
            </p>
          )}
        </>
      )}
    </>
  );
}

export function OverrideStatus({
  result,
  input,
}: {
  result: OverrideResult;
  input: OverrideInput;
}) {
  const message =
    result.kind === 'decided'
      ? result.outcome === 'DENIED'
        ? 'DENIED — the turnstile did not confirm opening. No attendance was granted.'
        : input.mode === 'BACKFILL'
          ? 'Admission recorded. No open command was sent.'
          : 'GRANTED — the turnstile confirmed opening.'
      : result.kind === 'unknown'
        ? 'Outcome unknown. Do not repeat this override. Check the access log using the event ID and contact the operator if it remains pending or missing.'
        : result.kind === 'rejected'
          ? result.message
          : 'Your session has ended.';
  return (
    <div
      className={`guard-feedback guard-feedback-${result.kind === 'decided' ? result.outcome.toLowerCase() : 'unknown'}`}
      role={result.kind === 'decided' ? 'status' : 'alert'}
    >
      <p>{gt(message)}</p>
      <p>
        {gt('Event:')} <code>{input.eventId}</code>
      </p>
    </div>
  );
}

function OverrideForm({
  gates,
  token,
  onEnd,
  onRecorded,
  onClose,
}: {
  gates: GuardGate[];
  token: string;
  onEnd: () => void;
  onRecorded: () => void;
  onClose: () => void;
}) {
  const t = useGuardString();
  const [gateId, setGateId] = useState(gates.find((gate) => gate.active)?.id ?? gates[0]?.id ?? '');
  const [employeeId, setEmployeeId] = useState('');
  const [reason, setReason] = useState('');
  const [reasonChoice, setReasonChoice] = useState('');
  const employeeInput = useRef<HTMLInputElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<'OPEN' | 'BACKFILL'>('OPEN');
  const [occurredAt, setOccurredAt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState<{ input: OverrideInput; result: OverrideResult } | null>(
    null,
  );
  // A synchronous lock covers two submissions before React has disabled the button.
  const sending = useRef(false);
  const selected = gates.find((gate) => gate.id === gateId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current || attempt) return;
    if (!reason.trim()) {
      setError('Choose a reason to continue.');
      return;
    }
    if (
      !selected ||
      (mode === 'OPEN' && !selected.active) ||
      !employeeId.trim() ||
      !reason.trim()
    ) {
      setError('Choose an eligible gate and enter an employee ID and reason.');
      return;
    }
    const time = mode === 'BACKFILL' ? new Date(`${occurredAt}+07:00`) : null;
    if (time && (!Number.isFinite(time.getTime()) || time.getTime() > Date.now())) {
      setError('Enter a valid past admission time in Vietnam time.');
      return;
    }
    setConfirming(true);
  };

  const send = async () => {
    if (sending.current || attempt) return;
    const time = mode === 'BACKFILL' ? new Date(`${occurredAt}+07:00`) : null;
    // Generate before sending; this identity remains visible even if the response is lost.
    const input: OverrideInput = {
      eventId: crypto.randomUUID(),
      employeeId: employeeId.trim(),
      reason: reason.trim(),
      mode,
      ...(time ? { occurredAt: time.toISOString() } : {}),
    };
    sending.current = true;
    setBusy(true);
    setConfirming(false);
    setError('');
    const result = await submitOverride(token, gateId, input);
    setAttempt({ input, result });
    setBusy(false);
    // A completed attempt cannot be submitted again, even after a timeout or conflict.
    if (result.kind === 'signed-out') onEnd();
    else onRecorded();
  };

  return (
    <section className="guard-card guard-override" aria-labelledby="override-heading">
      {confirming && (
        <GuardDialog title={gt('Confirm manual override')} onClose={() => setConfirming(false)}>
          <dl className="guard-detail-list">
            <div>
              <dt>{gt('Gate')}</dt>
              <dd>{selected?.name}</dd>
            </div>
            <div>
              <dt>{gt('Employee ID')}</dt>
              <dd>{employeeId}</dd>
            </div>
            <div>
              <dt>{gt('Reason')}</dt>
              <dd>{reason}</dd>
            </div>
            <div>
              <dt>{gt('Action')}</dt>
              <dd>
                {gt(mode === 'OPEN' ? 'Open gate now' : 'Record an earlier manual admission')}
              </dd>
            </div>
            {mode === 'BACKFILL' && (
              <div>
                <dt>{gt('Admission time (Vietnam, UTC+7)')}</dt>
                <dd>{occurredAt}</dd>
              </div>
            )}
          </dl>
          <p>{gt('Check the employee and gate before confirming.')}</p>
          <p>{gt('Your identity and reason will be recorded in the audit log.')}</p>
          <div className="guard-actions">
            <button type="button" onClick={() => setConfirming(false)}>
              {gt('Cancel')}
            </button>
            <button type="button" className="guard-primary" onClick={() => void send()}>
              {gt(mode === 'OPEN' ? 'Confirm and open gate' : 'Record admission')}
            </button>
          </div>
        </GuardDialog>
      )}
      <h3 id="override-heading">
        {gt(mode === 'OPEN' ? 'Manual override' : 'Record an earlier manual admission')}
      </h3>
      {attempt ? (
        <>
          <OverrideStatus result={attempt.result} input={attempt.input} />
          {attempt.result.kind === 'rejected' && attempt.result.code === 'NOTICE_REQUIRED' && (
            <GuardNotice
              token={token}
              onEnd={onEnd}
              onDone={() => {
                sending.current = false;
                setAttempt(null);
                onRecorded();
              }}
            />
          )}
          {attempt.result.kind === 'rejected' && (
            <button
              type="button"
              onClick={() => {
                sending.current = false;
                setAttempt(null);
              }}
            >
              {gt('Edit admission details')}
            </button>
          )}
          {attempt.result.kind === 'decided' && (
            <button
              type="button"
              className="guard-primary"
              onClick={() => {
                sending.current = false;
                setAttempt(null);
                setEmployeeId('');
                setReason('');
                setReasonChoice('');
                setOccurredAt('');
                setMode('OPEN');
                requestAnimationFrame(() => employeeInput.current?.focus());
              }}
            >
              {gt('Next employee')}
            </button>
          )}
          <button type="button" onClick={onClose}>
            {gt('Close override')}
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <fieldset disabled={busy}>
            <legend className="guard-sr-only">{gt('Admission details')}</legend>
            <label>
              {gt('1. Gate')}
              <select
                aria-label={t('Gate')}
                value={gateId}
                onChange={(event) => setGateId(event.target.value)}
                required
              >
                <option value="">{t('Choose a gate')}</option>
                {gates.map((gate) => (
                  <option key={gate.id} value={gate.id} disabled={mode === 'OPEN' && !gate.active}>
                    {gate.name} · {t(gate.direction === 'IN' ? 'Entry' : 'Exit')}
                    {!gate.active ? t(' · Inactive') : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {gt('2. Employee')}
              <input
                ref={employeeInput}
                autoComplete="off"
                placeholder={t('Enter employee record ID')}
                aria-label={t('Employee ID')}
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
                required
                aria-describedby="employee-id-hint"
              />
            </label>
            <p id="employee-id-hint">{gt('Use the record ID from HR, not the employee code.')}</p>
            <div className="guard-reason-section">
              <p className="guard-step-label">{gt('3. Reason')}</p>
              <div className="guard-reason-options" role="group" aria-label={t('Quick reasons')}>
                {['QR expired', 'No phone', 'Scanner unavailable', 'Other'].map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={reasonChoice === value}
                    onClick={() => {
                      setError('');
                      setReasonChoice(value);
                      setReason(value === 'Other' ? '' : t(value));
                      if (value === 'Other')
                        requestAnimationFrame(() => reasonInput.current?.focus());
                    }}
                  >
                    {gt(value)}
                  </button>
                ))}
              </div>
              {reasonChoice === 'Other' && (
                <label className="guard-custom-reason">
                  <span className="guard-sr-only">{gt('Reason')}</span>
                  <textarea
                    ref={reasonInput}
                    placeholder={t('Enter a short reason')}
                    aria-label={t('Reason')}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    rows={2}
                  />
                </label>
              )}
            </div>
            {mode === 'BACKFILL' && (
              <label>
                {gt('Admission time (Vietnam, UTC+7)')}
                <input
                  type="datetime-local"
                  value={occurredAt}
                  onChange={(event) => setOccurredAt(event.target.value)}
                  required
                />
              </label>
            )}
            {error && <p role="alert">{gt(error)}</p>}
            <div className="guard-actions">
              <button
                className="guard-primary"
                type="submit"
                disabled={!selected || (mode === 'OPEN' && !selected.active)}
              >
                {gt(busy ? 'Submitting…' : mode === 'OPEN' ? 'Open gate' : 'Record admission')}
              </button>
              <button
                type="button"
                className="guard-backfill-toggle"
                onClick={() => setMode(mode === 'OPEN' ? 'BACKFILL' : 'OPEN')}
              >
                {gt(mode === 'OPEN' ? 'Record an earlier manual admission' : 'Open gate now')}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

function GuardConsole({
  gates,
  session,
  onEnd,
}: {
  gates: GuardGate[];
  session: Session;
  onEnd: () => void;
}) {
  const t = useGuardString();
  const [filters, setFilters] = useState<LogFilters>(() => ({
    from: vietnamDay(),
    through: vietnamDay(),
    gateId: '',
    outcome: '',
  }));
  const [applied, setApplied] = useState(() => logQuery(filters)!.toString());
  const [filterError, setFilterError] = useState('');
  const [override, setOverride] = useState(true);
  const [tab, setTab] = useState<'control' | 'log'>('control');
  const [revision, setRevision] = useState(0);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const query = logQuery(filters);
    if (!query) return setFilterError('Choose a valid date range of at most 31 days.');
    setFilterError('');
    setApplied(query.toString());
    setRevision((value) => value + 1);
  };
  return (
    <>
      <div className="guard-tabs" role="tablist" aria-label={t('Gate operations')}>
        <button
          role="tab"
          id="control-tab"
          aria-selected={tab === 'control'}
          aria-controls="control-panel"
          onClick={() => {
            setTab('control');
            setOverride(true);
          }}
        >
          {gt('Gate control')}
        </button>
        <button
          role="tab"
          id="log-tab"
          aria-selected={tab === 'log'}
          aria-controls="log-panel"
          onClick={() => setTab('log')}
        >
          {gt('Access log')}
        </button>
      </div>
      <p className="guard-scope-note">
        {gt('Access is limited to the factories assigned to your account.')}
      </p>
      {gates.length === 0 && (
        <p>{gt('No gates are assigned to this account. Contact your administrator.')}</p>
      )}
      <details className="guard-card" hidden={tab !== 'log'}>
        <summary>{gt('Gate status at page load')}</summary>
        <ul>
          {gates.map((gate) => (
            <li key={gate.id}>
              {gate.name} · {gate.factoryId} · {gate.direction} ·{' '}
              {gate.active ? gate.status : 'INACTIVE'}
            </li>
          ))}
        </ul>
        <p>
          {gt(
            'Reload the page for current gate status. Events from offline edges may appear after synchronization.',
          )}
        </p>
      </details>
      <div className="guard-tab-panels">
        <div
          id="control-panel"
          role="tabpanel"
          aria-labelledby="control-tab"
          hidden={tab !== 'control'}
        >
          {override && gates.length > 0 && (
            <OverrideForm
              gates={gates}
              token={session.token}
              onEnd={onEnd}
              onRecorded={() => setRevision((value) => value + 1)}
              onClose={() => {
                setOverride(false);
                setTab('log');
              }}
            />
          )}
        </div>
        <div id="log-panel" role="tabpanel" aria-labelledby="log-tab" hidden={tab !== 'log'}>
          <section className="guard-card guard-log-card" aria-labelledby="access-log-heading">
            <h3 id="access-log-heading">{gt('Access log')}</h3>
            <form className="guard-filters" onSubmit={apply}>
              <label>
                {gt('From (Vietnam day)')}
                <input
                  type="date"
                  required
                  value={filters.from}
                  onChange={(event) => setFilters({ ...filters, from: event.target.value })}
                />
              </label>
              <label>
                {gt('Through (Vietnam day)')}
                <input
                  type="date"
                  required
                  value={filters.through}
                  onChange={(event) => setFilters({ ...filters, through: event.target.value })}
                />
              </label>
              <label>
                {gt('Gate')}
                <select
                  aria-label={t('Gate')}
                  value={filters.gateId}
                  onChange={(event) => setFilters({ ...filters, gateId: event.target.value })}
                >
                  <option value="">{t('All assigned gates')}</option>
                  {gates.map((gate) => (
                    <option key={gate.id} value={gate.id}>
                      {gate.name} · {gate.factoryId}
                      {!gate.active ? t(' · Inactive') : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {gt('Outcome')}
                <select
                  aria-label={t('Outcome')}
                  value={filters.outcome}
                  onChange={(event) =>
                    setFilters({ ...filters, outcome: event.target.value as Outcome | '' })
                  }
                >
                  <option value="">{t('All outcomes')}</option>
                  <option value="GRANTED">GRANTED</option>
                  <option value="DENIED">DENIED</option>
                  <option value="PENDING">PENDING</option>
                </select>
              </label>
              <button type="submit">{gt('Apply filters')}</button>
            </form>
            {filterError && <p role="alert">{gt(filterError)}</p>}
            <AccessLog
              key={`${applied}:${revision}`}
              token={session.token}
              query={applied}
              onEnd={onEnd}
            />
          </section>
        </div>
      </div>
    </>
  );
}

function GuardPanel({ session, onEnd }: { session: Session; onEnd: () => void }) {
  const [gates, setGates] = useState<ApiResult<GuardGate[]> | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void fetchGuardGates(session.token).then((result) => {
      if (!current) return;
      if (result.kind === 'signed-out') onEnd();
      else setGates(result);
    });
    return () => {
      current = false;
    };
  }, [session.token, onEnd, retry]);
  useEffect(() => {
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    const timer = setTimeout(onEnd, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [session.expiresAt, onEnd]);
  return (
    <>
      {!gates && <p role="status">{gt('Checking guard access…')}</p>}
      {gates?.kind === 'error' && (
        <>
          <p role="alert">{gt(gates.message)}</p>
          {gates.code === 'NOTICE_REQUIRED' && (
            <GuardNotice
              token={session.token}
              onEnd={onEnd}
              onDone={() => {
                setGates(null);
                setRetry((value) => value + 1);
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              setGates(null);
              setRetry((value) => value + 1);
            }}
          >
            {gt('Retry')}
          </button>
        </>
      )}
      {gates?.kind === 'ok' && <GuardConsole gates={gates.data} session={session} onEnd={onEnd} />}
    </>
  );
}

/** Guard operations (FR-4.4, FR-2.5 / UC-4); the server enforces role and factory scope. */
export function GuardPage() {
  const [language, setLanguage] = useState<GuardLanguage>('vi');
  const [session, setSession] = useState(() => loadSession());
  const end = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);
  return (
    <GuardLanguageContext.Provider value={language}>
      <main className="guard-page" lang={language}>
        <header className="guard-header">
          <div className="guard-header-brand">
            <span className="guard-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="3">
                <rect x="5" y="5" width="13" height="13" rx="1" />
                <rect x="30" y="5" width="13" height="13" rx="1" />
                <rect x="5" y="30" width="13" height="13" rx="1" />
                <path d="M29 25v9h-6m20-10H35v11h8v8H26v-5M24 5v13M5 24h13" />
              </svg>
            </span>
            <div>
              <p className="guard-brand">TMC ATTENDANCE</p>
              <h1>{gt('Guard console')}</h1>
              <p>{gt('Access log & manual override')}</p>
            </div>
          </div>
          <nav
            className="guard-header-actions"
            aria-label={language === 'vi' ? 'Điều hướng' : 'Navigation'}
          >
            <button
              type="button"
              className="guard-language"
              onClick={() => setLanguage(language === 'vi' ? 'en' : 'vi')}
            >
              {language === 'vi' ? 'English' : 'Tiếng Việt'}
            </button>
            <Link to="/staff">{gt('Staff home')}</Link>
            {session && (
              <button
                type="button"
                onClick={() => {
                  void signOut(session);
                  end();
                }}
              >
                {gt('Sign out')}
              </button>
            )}
          </nav>
        </header>
        <div className={`guard-content ${!session ? 'guard-auth-content' : ''}`}>
          {session ? (
            <GuardPanel session={session} onEnd={end} />
          ) : (
            <>
              <section className="guard-welcome">
                <p className="guard-role">{gt('Guard account required')}</p>
                <h2>{gt('Gate operations')}</h2>
                <p>{gt('Monitor access and assist employees when scanning is unavailable.')}</p>
                <div className="guard-welcome-features">
                  <span>{gt('Access log')}</span>
                  <span>{gt('Manual override')}</span>
                </div>
              </section>
              <div className="guard-login">
                <SignInForm
                  heading="Sign in to monitor gates"
                  translate={gt}
                  onSignedIn={setSession}
                />
              </div>
            </>
          )}
        </div>
      </main>
    </GuardLanguageContext.Provider>
  );
}
