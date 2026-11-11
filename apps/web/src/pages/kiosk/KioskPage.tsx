import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { GATE_ID_RE, KioskScanner, type KioskView } from './kiosk-scan';
import {
  readDisplayMode,
  saveDisplayMode,
  readLanguage,
  readCameraFacing,
  saveDeviceSettings,
  type DisplayMode,
  type Language,
  type CameraFacing,
} from './kiosk-settings';
import { KioskCameraPreview } from './KioskCameraPreview';
import './kiosk.css';

const copy = {
  vi: {
    title: 'Chấm công tại cổng',
    settings: 'Cài đặt',
    settingsTitle: 'Cài đặt kiosk',
    discard: 'Hủy thay đổi',
    device: 'Thiết bị',
    language: 'Ngôn ngữ',
    camera: 'Camera',
    front: 'Trước',
    rear: 'Sau',
    preview: 'Xem trước',
    unconfigured: 'Chưa cấu hình',
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
    hint: 'Đưa mã trước máy quét.',
    checking: 'Đang kiểm tra…',
    wait: 'Vui lòng chờ kết quả trước khi đi qua cổng.',
    grantedHeadline: 'Cho phép',
    deniedHeadline: 'Từ chối',
    granted: 'Được phép qua cổng',
    denied: 'Vui lòng liên hệ bảo vệ.',
    unknown: 'Chưa xác nhận được kết quả',
    unknownHint: 'Vui lòng liên hệ bảo vệ trước khi quét lại.',
    reset: 'Trở về màn hình quét sau 3 giây',
    employee: 'Nhân viên',
    responseTime: 'Thời gian phản hồi',
    input: 'Nội dung mã QR',
    submit: 'Kiểm tra mã',
    missing: 'Kiosk chưa được cấu hình cổng. Vui lòng liên hệ bảo vệ.',
  },
  en: {
    title: 'Gate attendance',
    settings: 'Settings',
    settingsTitle: 'Kiosk settings',
    discard: 'Discard changes',
    device: 'Device',
    language: 'Language',
    camera: 'Camera',
    front: 'Front',
    rear: 'Rear',
    preview: 'Preview',
    unconfigured: 'Not configured',
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
    hint: 'Hold your code at the scanner.',
    checking: 'Checking…',
    wait: 'Please wait for the result before passing through the gate.',
    grantedHeadline: 'GRANTED',
    deniedHeadline: 'DENIED',
    granted: 'You may pass through the gate',
    denied: 'Please contact the guard.',
    unknown: 'Unable to confirm the result',
    unknownHint: 'Please contact the guard before scanning again.',
    reset: 'Returning to scan in 3 seconds',
    employee: 'Employee',
    responseTime: 'Response time',
    input: 'QR code contents',
    submit: 'Check code',
    missing: 'This kiosk has no gate configured. Please contact the guard.',
  },
};

type TextKey = keyof typeof copy.vi;

const denialReasons = {
  REVOKED: { vi: 'Mã đã bị thu hồi', en: 'Code revoked' },
  EXPIRED: { vi: 'Mã đã hết hạn', en: 'Code expired' },
  INVALID_SIGNATURE: { vi: 'Mã không hợp lệ', en: 'Invalid code' },
  UNKNOWN: { vi: 'Không tìm thấy nhân viên', en: 'Employee not found' },
  INACTIVE: { vi: 'Nhân viên đã ngừng hoạt động', en: 'Employee inactive' },
  REPLAYED: { vi: 'Mã đã được sử dụng', en: 'Code already used' },
  NO_SNAPSHOT: { vi: 'Dữ liệu cổng chưa sẵn sàng', en: 'Gate data unavailable' },
  TCS_UNAVAILABLE: { vi: 'Không thể mở cổng', en: 'Unable to open gate' },
  INTERNAL_ERROR: { vi: 'Lỗi hệ thống', en: 'System error' },
};

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

export function KioskStatus({
  view,
  language = 'vi',
  receivedAt,
}: {
  view: KioskView;
  language?: Language;
  receivedAt?: Date | null;
}) {
  const result = view.kind === 'result' ? view.decision.result : null;
  const reason = view.kind === 'result' && result === 'DENIED' ? view.decision.reason : undefined;
  const reasonCopy =
    reason && Object.hasOwn(denialReasons, reason)
      ? denialReasons[reason as keyof typeof denialReasons]
      : undefined;
  return (
    <section
      className={['kiosk-status', 'kiosk-' + (result?.toLowerCase() ?? view.kind)].join(' ')}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      lang={language}
    >
      {view.kind !== 'idle' && (
        <div className="kiosk-result-card">
          <div
            className={view.kind === 'processing' ? 'kiosk-icon kiosk-spinner' : 'kiosk-icon'}
            aria-hidden="true"
          >
            {result && (
              <svg
                viewBox="0 0 64 64"
                fill="none"
                stroke="currentColor"
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {result === 'GRANTED' ? (
                  <path d="M10 33 25 48 54 17" />
                ) : (
                  <path d="m16 16 32 32m0-32L16 48" />
                )}
              </svg>
            )}
            {view.kind === 'unknown' && '!'}
          </div>
          {view.kind === 'processing' && (
            <>
              <h2>{label('checking', language)}</h2>
              <p>{label('wait', language)}</p>
            </>
          )}
          {view.kind === 'result' && (
            <>
              <h2>
                {label(result === 'GRANTED' ? 'grantedHeadline' : 'deniedHeadline', language)}
              </h2>
              <p>{label(result === 'GRANTED' ? 'granted' : 'denied', language)}</p>
              {reasonCopy && (
                <p className="kiosk-denial-reason">
                  <BilingualText {...reasonCopy} language={language} />
                </p>
              )}
              <dl className="kiosk-result-details">
                {receivedAt && (
                  <div>
                    <dt>{label('responseTime', language)}</dt>
                    <dd className="kiosk-result-time">
                      <time dateTime={receivedAt.toISOString()}>
                        {receivedAt.toLocaleTimeString(language === 'vi' ? 'vi-VN' : 'en-GB', {
                          hour12: false,
                        })}
                      </time>
                    </dd>
                  </div>
                )}
                {view.decision.firstName && (
                  <div>
                    <dt>{label('employee', language)}</dt>
                    <dd className="kiosk-name">{view.decision.firstName}</dd>
                  </div>
                )}
              </dl>
            </>
          )}
          {view.kind === 'unknown' && (
            <>
              <h2>{label('unknown', language)}</h2>
              <p>{label('unknownHint', language)}</p>
            </>
          )}
        </div>
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
  cameraFacing,
}: {
  gateId: string;
  language: Language;
  onBusyChange: (busy: boolean) => void;
  cameraFacing: CameraFacing;
}) {
  const [view, setView] = useState<KioskView>({ kind: 'idle' });
  const [token, setToken] = useState('');
  const [receivedAt, setReceivedAt] = useState<Date | null>(null);
  const scanner = useRef<KioskScanner | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const idle = view.kind === 'idle';
  const available = useRef(true);
  const accept = useCallback((code: string) => {
    if (!available.current || !scanner.current || !code.trim()) return false;
    void scanner.current.scan(code);
    return true;
  }, []);

  useEffect(() => {
    const current = new KioskScanner(gateId, (next) => {
      available.current = next.kind === 'idle';
      setView(next);
      setReceivedAt(next.kind === 'result' ? new Date() : null);
      onBusyChange(next.kind !== 'idle');
    });
    available.current = true;
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
          <div className={idle ? 'kiosk-camera-stage' : 'kiosk-camera-stage kiosk-camera-busy'}>
            <KioskCameraPreview language={language} accept={accept} facing={cameraFacing} />
            <KioskStatus view={view} language={language} receivedAt={receivedAt} />
          </div>
        </div>
        <form
          className="kiosk-scanner-capture"
          onSubmit={(event) => {
            event.preventDefault();
            if (!idle) return;
            accept(token);
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

function KioskSettings({
  mode,
  language,
  cameraFacing,
  gateId,
  onSave,
  onCancel,
}: {
  mode: DisplayMode;
  language: Language;
  cameraFacing: CameraFacing;
  gateId?: string;
  onSave: (mode: DisplayMode, language: Language, facing: CameraFacing) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(mode);
  const [draftLanguage, setDraftLanguage] = useState(language);
  const [draftCamera, setDraftCamera] = useState(cameraFacing);
  const text = (key: TextKey) => label(key, draftLanguage);
  return (
    <form
      className="kiosk-settings"
      lang={draftLanguage}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft, draftLanguage, draftCamera);
      }}
    >
      <header className="kiosk-settings-header">
        <button
          type="button"
          className="kiosk-back"
          aria-label={copy[draftLanguage].cancel}
          onClick={onCancel}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="m12 5-7 7 7 7M5 12h15" />
          </svg>
        </button>
        <h1>{text('settingsTitle')}</h1>
      </header>
      <div className="kiosk-settings-body">
        <div className="kiosk-settings-controls">
          <fieldset>
            <legend>{text('displayMode')}</legend>
            <div className="kiosk-settings-card">
              {(['guided', 'scan-only'] as const).map((value) => (
                <label
                  className={
                    draft === value ? 'kiosk-mode-option is-selected' : 'kiosk-mode-option'
                  }
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
                    <strong>{text(value === 'guided' ? 'guided' : 'scanOnly')}</strong>
                    <span>{text(value === 'guided' ? 'guidedHint' : 'scanOnlyHint')}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <section className="kiosk-device-settings" aria-labelledby="kiosk-device-title">
            <h2 id="kiosk-device-title">{text('device')}</h2>
            <div className="kiosk-settings-card">
              <div className="kiosk-device-row">
                <span id="kiosk-language-label">{text('language')}</span>
                <div
                  className="kiosk-segmented"
                  role="group"
                  aria-labelledby="kiosk-language-label"
                >
                  {(['vi', 'en'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={draftLanguage === value}
                      onClick={() => setDraftLanguage(value)}
                    >
                      {value === 'vi' ? 'Tiếng Việt' : 'English'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="kiosk-device-row">
                <span id="kiosk-camera-label">{text('camera')}</span>
                <div className="kiosk-segmented" role="group" aria-labelledby="kiosk-camera-label">
                  {(['user', 'environment'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={draftCamera === value}
                      onClick={() => setDraftCamera(value)}
                    >
                      {text(value === 'user' ? 'front' : 'rear')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="kiosk-device-row">
                <span>{text('gate')}</span>
                <div className="kiosk-locked-gate">
                  <strong>{gateId || text('unconfigured')}</strong>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <rect x="5" y="10" width="14" height="11" rx="2" />
                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                  </svg>
                </div>
              </div>
            </div>
          </section>
        </div>
        <section className="kiosk-settings-preview" aria-labelledby="kiosk-preview-title">
          <h2 id="kiosk-preview-title">{text('preview')}</h2>
          <div
            className={
              draft === 'guided' ? 'kiosk-mini-screen' : 'kiosk-mini-screen kiosk-mini-scan-only'
            }
            aria-hidden="true"
          >
            <div className="kiosk-mini-header">
              <div className="kiosk-mini-brand">
                <QrIcon />
                <span>
                  TMC Attendance
                  <br />
                  <strong>{gateId}</strong>
                </span>
              </div>
              <span className="kiosk-mini-toolbar">
                <span>{draftLanguage === 'vi' ? 'EN' : 'VI'}</span>
                <i />
              </span>
            </div>
            <div className="kiosk-mini-camera">
              <div className="kiosk-mini-qr">
                <QrIcon />
              </div>
            </div>
          </div>
          <p>{text(draft === 'guided' ? 'guided' : 'scanOnly')}</p>
        </section>
      </div>
      <footer className="kiosk-settings-actions">
        <button type="button" onClick={onCancel}>
          {text('discard')}
        </button>
        <button type="submit">{text('save')}</button>
      </footer>
    </form>
  );
}

export function KioskPage() {
  const [params] = useSearchParams();
  const [language, setLanguage] = useState<Language>(readLanguage);
  const [mode, setMode] = useState<DisplayMode>(readDisplayMode);
  const [busy, setBusy] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>(readCameraFacing);
  const navigate = useNavigate();
  const settings = useLocation().pathname === '/kiosk/settings';
  const go = (path: string) =>
    navigate({ pathname: path, search: params.toString() ? `?${params.toString()}` : '' });
  const gateId = params.get('gateId')?.trim();
  return (
    <main
      className={`kiosk ${settings ? 'kiosk-settings-page' : ''} ${!settings && mode === 'scan-only' ? 'kiosk-scan-only' : ''}`}
      lang={language}
    >
      <div className="kiosk-shell">
        <div className="kiosk-content">
          {!settings && (
            <header className="kiosk-header">
              <div className="kiosk-header-brand">
                <span className="kiosk-brand-mark" aria-hidden="true">
                  <QrIcon />
                </span>
                <div>
                  <p className="kiosk-section-label">TMC Attendance</p>
                  <h1>
                    {settings ? (
                      label('settings', language)
                    ) : gateId ? (
                      <>
                        {label('gate', language)} {gateId}
                      </>
                    ) : (
                      label('title', language)
                    )}
                  </h1>
                </div>
              </div>
              <div className="kiosk-toolbar">
                <button
                  type="button"
                  className="kiosk-language"
                  aria-label={language === 'vi' ? 'English' : 'Tiếng Việt'}
                  onClick={() => {
                    const next = language === 'vi' ? 'en' : 'vi';
                    setLanguage(next);
                    saveDeviceSettings(next, cameraFacing);
                  }}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
                  </svg>
                  <span>{language === 'vi' ? 'EN' : 'VI'}</span>
                </button>
                <button
                  type="button"
                  className="kiosk-settings-toggle"
                  aria-label={copy[language].settings}
                  disabled={busy || settings}
                  onClick={() => go('/kiosk/settings')}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </div>
            </header>
          )}
          {settings ? (
            <KioskSettings
              mode={mode}
              language={language}
              cameraFacing={cameraFacing}
              gateId={gateId}
              onCancel={() => go('/kiosk')}
              onSave={(next, nextLanguage, nextCamera) => {
                setMode(next);
                setLanguage(nextLanguage);
                setCameraFacing(nextCamera);
                saveDisplayMode(next);
                saveDeviceSettings(nextLanguage, nextCamera);
                go('/kiosk');
              }}
            />
          ) : gateId && GATE_ID_RE.test(gateId) ? (
            <ConfiguredKiosk
              key={gateId}
              gateId={gateId}
              language={language}
              onBusyChange={setBusy}
              cameraFacing={cameraFacing}
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
