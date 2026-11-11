import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { GATE_ID_RE, KioskScanner, type KioskView } from './kiosk-scan';
import './kiosk.css';

type Language = 'vi' | 'en';
const copy = {
  vi: {
    title: 'Chấm công tại cổng',
    settings: 'Cài đặt',
    displayMode: 'Chế độ hiển thị',
    guided: 'Tiêu chuẩn',
    guidedHint: 'Thanh tiêu đề và vùng quét lớn.',
    scanOnly: 'Chỉ vùng quét',
    scanOnlyHint: 'Ẩn tiêu đề, tối đa diện tích quét.',
    save: 'Lưu và quay lại',
    cancel: 'Quay lại',
    attendance: 'Điểm danh',
    access: 'Hệ thống kiểm soát ra vào',
    support: 'Cần hỗ trợ?',
    supportHint: 'Vui lòng liên hệ bảo vệ tại cổng.',
    automatic: 'Máy quét tự động nhận mã',
    gate: 'Cổng',
    ready: 'Sẵn sàng nhận mã',
    scan: 'Quét mã QR',
    hint: 'Đưa mã trước máy quét.',
    checking: 'Đang kiểm tra…',
    wait: 'Vui lòng chờ kết quả trước khi đi qua cổng.',
    granted: 'Được phép qua cổng',
    denied: 'Vui lòng liên hệ bảo vệ.',
    unknown: 'Chưa xác nhận được kết quả',
    unknownHint: 'Vui lòng liên hệ bảo vệ trước khi quét lại.',
    reset: 'Màn hình sẽ tự trở về trạng thái chờ.',
    input: 'Nội dung mã QR',
    submit: 'Kiểm tra mã',
    missing: 'Kiosk chưa được cấu hình cổng. Vui lòng liên hệ bảo vệ.',
  },
  en: {
    title: 'Gate attendance',
    settings: 'Settings',
    displayMode: 'Display mode',
    guided: 'Standard',
    guidedHint: 'Header and large scan area.',
    scanOnly: 'Scan area only',
    scanOnlyHint: 'Hide the header to maximize the scan area.',
    save: 'Save and return',
    cancel: 'Back',
    attendance: 'Check-in',
    access: 'Access control system',
    support: 'Need a hand?',
    supportHint: 'Please contact the guard at this gate.',
    automatic: 'The scanner reads your code automatically',
    gate: 'Gate',
    ready: 'Ready to scan',
    scan: 'Scan QR',
    hint: 'Hold your code at the scanner.',
    checking: 'Checking…',
    wait: 'Please wait for the result before passing through the gate.',
    granted: 'You may pass through the gate',
    denied: 'Please contact the guard.',
    unknown: 'Unable to confirm the result',
    unknownHint: 'Please contact the guard before scanning again.',
    reset: 'The screen will return to ready automatically.',
    input: 'QR code contents',
    submit: 'Check code',
    missing: 'This kiosk has no gate configured. Please contact the guard.',
  },
};

type TextKey = keyof typeof copy.vi;

/** Both translations reserve the same space; only the active one is visible/announced. */
function BilingualText({ vi, en, language }: { vi: string; en: string; language: Language }) {
  return (
    <span className="kiosk-translated">
      <span
        lang="vi"
        aria-hidden={language !== 'vi'}
        className={language !== 'vi' ? 'kiosk-translation-reserve' : undefined}
      >
        {vi}
      </span>
      <span
        lang="en"
        aria-hidden={language !== 'en'}
        className={language !== 'en' ? 'kiosk-translation-reserve' : undefined}
      >
        {en}
      </span>
    </span>
  );
}

const label = (key: TextKey, language: Language) => (
  <BilingualText vi={copy.vi[key]} en={copy.en[key]} language={language} />
);

function QrIcon() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="13" height="13" rx="1" />
      <rect x="30" y="5" width="13" height="13" rx="1" />
      <rect x="5" y="30" width="13" height="13" rx="1" />
      <path d="M29 25v9h-6m20-10H35v11h8v8H26v-5M24 5v13M5 24h13" />
    </svg>
  );
}

function ScanIllustration() {
  return (
    <div className="kiosk-scan-illustration" aria-hidden="true">
      <div className="kiosk-scan-frame">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="kiosk-phone">
        <span />
        <QrIcon />
        <div />
      </div>
      <div className="kiosk-scan-line" />
    </div>
  );
}

export function KioskStatus({ view, language = 'vi' }: { view: KioskView; language?: Language }) {
  const result = view.kind === 'result' ? view.decision.result : null;
  return (
    <section
      className={`kiosk-status kiosk-${result?.toLowerCase() ?? view.kind}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      lang={language}
    >
      {view.kind === 'idle' && <ScanIllustration />}
      {view.kind !== 'idle' && (
        <div
          className={`kiosk-icon ${view.kind === 'processing' ? 'kiosk-spinner' : ''}`}
          aria-hidden="true"
        >
          {result === 'GRANTED'
            ? '✓'
            : result === 'DENIED'
              ? '✕'
              : view.kind === 'unknown'
                ? '!'
                : null}
        </div>
      )}
      {view.kind === 'idle' && (
        <>
          <p className="kiosk-eyebrow">{label('ready', language)}</p>
          <h2>{label('scan', language)}</h2>
          <p>{label('hint', language)}</p>
        </>
      )}
      {view.kind === 'processing' && (
        <>
          <h2>{label('checking', language)}</h2>
          <p>{label('wait', language)}</p>
        </>
      )}
      {view.kind === 'result' && (
        <>
          <h2>{result}</h2>
          {view.decision.firstName && <p className="kiosk-name">{view.decision.firstName}</p>}
          <p>{label(result === 'GRANTED' ? 'granted' : 'denied', language)}</p>
        </>
      )}
      {view.kind === 'unknown' && (
        <>
          <h2>{label('unknown', language)}</h2>
          <p>{label('unknownHint', language)}</p>
        </>
      )}
      {(view.kind === 'result' || view.kind === 'unknown') && (
        <p className="kiosk-reset">{label('reset', language)}</p>
      )}
    </section>
  );
}

/** Offscreen input captures hardware scanner keystrokes; there is no manual-entry UI. */
function ConfiguredKiosk({
  gateId,
  language,
  onBusyChange,
}: {
  gateId: string;
  language: Language;
  onBusyChange: (busy: boolean) => void;
}) {
  const [view, setView] = useState<KioskView>({ kind: 'idle' });
  const [token, setToken] = useState('');
  const scanner = useRef<KioskScanner | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const idle = view.kind === 'idle';

  useEffect(() => {
    const current = new KioskScanner(gateId, (next) => {
      setView(next);
      onBusyChange(next.kind !== 'idle');
    });
    scanner.current = current;
    return () => {
      current.stop();
      scanner.current = null;
      onBusyChange(false);
    };
  }, [gateId, onBusyChange]);

  useEffect(() => {
    const focus = () => {
      if (idle) input.current?.focus({ preventScroll: true });
    };
    focus();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [idle, language]);

  return (
    <>
      <div className="kiosk-workspace">
        <div className="kiosk-scan-panel">
          <div className="kiosk-panel-top">
            <span className="kiosk-gate">
              {label('gate', language)} <strong>{gateId}</strong>
            </span>
            <QrIcon />
          </div>
          <KioskStatus view={view} language={language} />
          <p className="kiosk-automatic">
            <span aria-hidden="true">⌁</span> {label('automatic', language)}
          </p>
        </div>
        <form
          className="kiosk-scanner-capture"
          onSubmit={(event) => {
            event.preventDefault();
            if (!idle) return;
            void scanner.current?.scan(token);
            setToken('');
          }}
        >
          <label htmlFor="scanner-input">{label('input', language)}</label>
          <input
            ref={input}
            id="scanner-input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={!idle}
            inputMode="none"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            onBlur={(event) => {
              if (idle && event.relatedTarget === null)
                input.current?.focus({ preventScroll: true });
            }}
          />
          <button type="submit" tabIndex={-1}>
            {label('submit', language)}
          </button>
        </form>
      </div>
    </>
  );
}

type DisplayMode = 'guided' | 'scan-only';
const DISPLAY_KEY = 'tmc.kiosk.displayMode';
const readDisplayMode = (): DisplayMode => {
  try {
    return localStorage.getItem(DISPLAY_KEY) === 'scan-only' ? 'scan-only' : 'guided';
  } catch {
    return 'guided';
  }
};

function KioskSettings({
  mode,
  language,
  onSave,
  onCancel,
}: {
  mode: DisplayMode;
  language: Language;
  onSave: (mode: DisplayMode) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(mode);
  return (
    <form
      className="kiosk-settings"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <fieldset>
        <legend>{label('displayMode', language)}</legend>
        {(['guided', 'scan-only'] as const).map((value) => (
          <label
            className={`kiosk-mode-option ${draft === value ? 'is-selected' : ''}`}
            key={value}
          >
            <input
              type="radio"
              name="display-mode"
              value={value}
              checked={draft === value}
              onChange={() => setDraft(value)}
            />
            <span>
              <strong>{label(value === 'guided' ? 'guided' : 'scanOnly', language)}</strong>
              <span>{label(value === 'guided' ? 'guidedHint' : 'scanOnlyHint', language)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="kiosk-settings-actions">
        <button type="button" onClick={onCancel}>
          {label('cancel', language)}
        </button>
        <button type="submit">{label('save', language)}</button>
      </div>
    </form>
  );
}

export function KioskPage() {
  const [params] = useSearchParams();
  const [language, setLanguage] = useState<Language>('vi');
  const [mode, setMode] = useState<DisplayMode>(readDisplayMode);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const settings = useLocation().pathname === '/kiosk/settings';
  const go = (path: string) =>
    navigate({ pathname: path, search: params.toString() ? `?${params.toString()}` : '' });
  const gateId = params.get('gateId')?.trim();
  return (
    <main
      className={`kiosk ${!settings && mode === 'scan-only' ? 'kiosk-scan-only' : ''}`}
      lang={language}
    >
      <div className="kiosk-shell">
        <div className="kiosk-content">
          <header className="kiosk-header">
            <div className="kiosk-header-brand">
              <span className="kiosk-brand-mark" aria-hidden="true">
                <QrIcon />
              </span>
              <div>
                <p className="kiosk-section-label">TMC ATTENDANCE</p>
                <h1>{label(settings ? 'settings' : 'title', language)}</h1>
              </div>
            </div>
            <div className="kiosk-toolbar">
              <button
                type="button"
                className="kiosk-language"
                onClick={() => setLanguage(language === 'vi' ? 'en' : 'vi')}
              >
                <span aria-hidden="true">◎</span>{' '}
                <BilingualText vi="English" en="Tiếng Việt" language={language} />
              </button>
              <button
                type="button"
                className="kiosk-settings-toggle"
                disabled={busy || settings}
                onClick={() => go('/kiosk/settings')}
              >
                <span aria-hidden="true">⚙</span> {label('settings', language)}
              </button>
            </div>
          </header>
          {settings ? (
            <KioskSettings
              mode={mode}
              language={language}
              onCancel={() => go('/kiosk')}
              onSave={(next) => {
                setMode(next);
                try {
                  localStorage.setItem(DISPLAY_KEY, next);
                } catch {
                  /* Keep the choice for this session if storage is blocked. */
                }
                go('/kiosk');
              }}
            />
          ) : gateId && GATE_ID_RE.test(gateId) ? (
            <ConfiguredKiosk
              key={gateId}
              gateId={gateId}
              language={language}
              onBusyChange={setBusy}
            />
          ) : (
            <p className="kiosk-config-error" role="alert">
              {label('missing', language)}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
