import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { GATE_ID_RE, KioskScanner, type KioskView } from './kiosk-scan';
import './kiosk.css';

type Language = 'vi' | 'en';
const copy = {
  vi: {
    title: 'Điểm quét mã QR',
    gate: 'Cổng',
    ready: 'Sẵn sàng nhận mã',
    scan: 'Đưa mã QR trước máy quét',
    hint: 'Mở mã QR trên điện thoại. Máy quét sẽ tự nhận mã.',
    checking: 'Đang kiểm tra…',
    wait: 'Vui lòng chờ kết quả trước khi đi qua cổng.',
    granted: 'Được phép qua cổng',
    denied: 'Vui lòng liên hệ bảo vệ.',
    unknown: 'Chưa xác nhận được kết quả',
    unknownHint: 'Vui lòng liên hệ bảo vệ trước khi quét lại.',
    reset: 'Màn hình sẽ tự trở về trạng thái chờ.',
    manual: 'Nhập mã thủ công',
    close: 'Đóng phần nhập thủ công',
    manualHint: 'Dán nội dung mã QR nếu không có máy quét.',
    input: 'Nội dung mã QR',
    submit: 'Kiểm tra mã',
    missing: 'Kiosk chưa được cấu hình cổng. Vui lòng liên hệ bảo vệ.',
  },
  en: {
    title: 'QR scan station',
    gate: 'Gate',
    ready: 'Ready to scan',
    scan: 'Hold your QR code in front of the scanner',
    hint: 'Open your QR on your phone. The scanner reads it automatically.',
    checking: 'Checking…',
    wait: 'Please wait for the result before passing through the gate.',
    granted: 'You may pass through the gate',
    denied: 'Please contact the guard.',
    unknown: 'Unable to confirm the result',
    unknownHint: 'Please contact the guard before scanning again.',
    reset: 'The screen will return to ready automatically.',
    manual: 'Enter a code manually',
    close: 'Close manual entry',
    manualHint: 'Paste the QR contents if no scanner is available.',
    input: 'QR code contents',
    submit: 'Check code',
    missing: 'This kiosk has no gate configured. Please contact the guard.',
  },
};

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

export function KioskStatus({ view, language = 'vi' }: { view: KioskView; language?: Language }) {
  const text = copy[language];
  const result = view.kind === 'result' ? view.decision.result : null;
  return (
    <section
      className={`kiosk-status kiosk-${result?.toLowerCase() ?? view.kind}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      lang={language}
    >
      <div
        className={`kiosk-icon ${view.kind === 'processing' ? 'kiosk-spinner' : ''}`}
        aria-hidden="true"
      >
        {view.kind === 'idle' ? (
          <QrIcon />
        ) : result === 'GRANTED' ? (
          '✓'
        ) : result === 'DENIED' ? (
          '✕'
        ) : view.kind === 'unknown' ? (
          '!'
        ) : null}
      </div>
      {view.kind === 'idle' && (
        <>
          <p className="kiosk-eyebrow">{text.ready}</p>
          <h2>{text.scan}</h2>
          <p>{text.hint}</p>
        </>
      )}
      {view.kind === 'processing' && (
        <>
          <h2>{text.checking}</h2>
          <p>{text.wait}</p>
        </>
      )}
      {view.kind === 'result' && (
        <>
          <h2>{result}</h2>
          {view.decision.firstName && <p className="kiosk-name">{view.decision.firstName}</p>}
          <p>{result === 'GRANTED' ? text.granted : text.denied}</p>
        </>
      )}
      {view.kind === 'unknown' && (
        <>
          <h2>{text.unknown}</h2>
          <p>{text.unknownHint}</p>
        </>
      )}
      {(view.kind === 'result' || view.kind === 'unknown') && (
        <p className="kiosk-reset">{text.reset}</p>
      )}
    </section>
  );
}

/** Keep the input mounted for keyboard scanners; enable the OS keyboard only for manual entry. */
function ConfiguredKiosk({ gateId, language }: { gateId: string; language: Language }) {
  const [view, setView] = useState<KioskView>({ kind: 'idle' });
  const [token, setToken] = useState('');
  const [manual, setManual] = useState(false);
  const scanner = useRef<KioskScanner | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const idle = view.kind === 'idle';
  const text = copy[language];

  useEffect(() => {
    const current = new KioskScanner(gateId, setView);
    scanner.current = current;
    return () => {
      current.stop();
      scanner.current = null;
    };
  }, [gateId]);

  useEffect(() => {
    const focus = () => {
      if (idle) input.current?.focus({ preventScroll: true });
    };
    focus();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [idle, manual, language]);

  return (
    <>
      <p className="kiosk-gate">
        {text.gate}: <strong>{gateId}</strong>
      </p>
      <KioskStatus view={view} language={language} />
      <div className="kiosk-entry">
        <button
          type="button"
          className="kiosk-manual-toggle"
          disabled={!idle}
          aria-expanded={manual}
          aria-controls="manual-entry"
          onClick={() => {
            setManual(!manual);
            setToken('');
          }}
        >
          {manual ? text.close : text.manual}
        </button>
        <form
          id="manual-entry"
          className={manual ? 'kiosk-manual' : 'kiosk-scanner-capture'}
          onSubmit={(event) => {
            event.preventDefault();
            if (!idle) return;
            void scanner.current?.scan(token);
            setToken('');
          }}
        >
          {manual && <p>{text.manualHint}</p>}
          <label htmlFor="scanner-input">{text.input}</label>
          <div className="kiosk-input-row">
            <input
              ref={input}
              id="scanner-input"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={!idle}
              inputMode={manual ? 'text' : 'none'}
              enterKeyHint="go"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              onBlur={(event) => {
                if (idle && event.relatedTarget === null)
                  input.current?.focus({ preventScroll: true });
              }}
            />
            <button type="submit" disabled={!idle || !token.trim()}>
              {text.submit}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

export function KioskPage() {
  const [params] = useSearchParams();
  const [language, setLanguage] = useState<Language>('vi');
  const gateId = params.get('gateId')?.trim();
  const text = copy[language];
  return (
    <main className="kiosk" lang={language}>
      <div className="kiosk-shell">
        <header className="kiosk-header">
          <div>
            <p className="kiosk-brand">TMC ATTENDANCE</p>
            <h1>
              Kiosk <span>· {text.title}</span>
            </h1>
          </div>
          <button
            type="button"
            className="kiosk-language"
            onClick={() => setLanguage(language === 'vi' ? 'en' : 'vi')}
          >
            {language === 'vi' ? 'English' : 'Tiếng Việt'}
          </button>
        </header>
        {gateId && GATE_ID_RE.test(gateId) ? (
          <ConfiguredKiosk key={gateId} gateId={gateId} language={language} />
        ) : (
          <p className="kiosk-config-error" role="alert">
            {text.missing}
          </p>
        )}
      </div>
    </main>
  );
}
