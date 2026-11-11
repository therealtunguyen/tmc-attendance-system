import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KioskPage, KioskStatus } from './KioskPage';
import type { KioskView } from './kiosk-scan';
import {
  readDisplayMode,
  saveDisplayMode,
  readLanguage,
  readCameraFacing,
  saveDeviceSettings,
} from './kiosk-settings';

afterEach(() => vi.unstubAllGlobals());

const renderPage = (url: string) =>
  renderToString(
    <MemoryRouter initialEntries={[url]}>
      <KioskPage />
    </MemoryRouter>,
  );

describe('kiosk screen', () => {
  it('asks for configuration instead of scanning at an unspecified gate', () => {
    expect(renderPage('/kiosk')).toContain('chưa được cấu hình cổng');
    expect(renderPage('/kiosk?gateId=%20')).not.toContain('<form');
    expect(renderPage('/kiosk?gateId=invalid%2Fgate')).not.toContain('<form');
  });

  it('opens display settings with both modes without submitting a scan', () => {
    const page = renderPage('/kiosk/settings?gateId=gate-1');
    expect(page).toContain('Chế độ hiển thị');
    expect(page).toContain('Tiêu chuẩn');
    expect(page).toContain('Chỉ vùng quét');
    expect(page).toContain('Lưu và quay lại');
    expect(page).toContain('Cài đặt kiosk');
    expect(page).toContain('Thiết bị');
    expect(page).toContain('Xem trước');
    expect(page).toContain('kiosk-locked-gate');
    expect(page).not.toContain('<video');
    expect(page).not.toContain('id="scanner-input"');
  });

  it('keeps a labelled hardware-scanner input without manual entry', () => {
    const page = renderPage('/kiosk?gateId=gate-1');
    expect(page).toContain('gate-1');
    expect(page).not.toContain('Quét Mã QR');
    expect(page).not.toContain('Scan QR');
    expect(page).toContain('<video');
    expect(page).toContain('autoPlay=');
    expect(page).not.toContain('Sẵn sàng nhận mã');
    expect(page).not.toContain('Đưa mã trước máy quét.');
    expect(page).not.toContain('Máy quét tự động nhận mã');
    expect(page).toContain('for="scanner-input"');
    expect(page).toContain('type="password"');
    expect(page).toContain('autoComplete="off"');
    expect(page).toContain('inputMode="none"');
    expect(page).toContain('kiosk-scanner-capture');
    expect(page).not.toContain('kiosk-entry-panel');
    expect(page).not.toContain('placeholder=');
    expect(page).not.toContain('kiosk-sidebar');
    expect(page).toContain('English');
    expect(page).toContain('lang="vi"');
  });

  it.each<[KioskView, string]>([
    [{ kind: 'processing' }, 'Checking'],
    [
      { kind: 'result', decision: { eventId: 'edge-event', result: 'GRANTED', firstName: 'Lan' } },
      'GRANTED',
    ],
    [
      { kind: 'result', decision: { eventId: 'edge-event', result: 'DENIED', firstName: 'An' } },
      'DENIED',
    ],
    [{ kind: 'unknown' }, 'Unable to confirm the result'],
  ])('announces %j using text, not color alone', (view, message) => {
    const page = renderToString(<KioskStatus view={view} language="en" />);
    expect(page).toContain(message);
    expect(page).toContain('role="status"');
    if (view.kind === 'result') expect(page).toContain(view.decision.firstName!);
  });

  it('shows an unidentified denial without inventing a name', () => {
    const page = renderToString(
      <KioskStatus
        view={{ kind: 'result', decision: { eventId: 'edge-event', result: 'DENIED' } }}
      />,
    );
    expect(page).toContain('<span lang="vi" aria-hidden="false">Từ chối</span>');
    expect(page).not.toContain('kiosk-name');
  });

  it.each([
    ['en', 'GRANTED', 'GRANTED', 'You may pass through the gate', 'Please contact the guard.'],
    ['en', 'DENIED', 'DENIED', 'Please contact the guard.', 'You may pass through the gate'],
    ['vi', 'GRANTED', 'Cho phép', 'Được phép qua cổng', 'Vui lòng liên hệ bảo vệ.'],
    ['vi', 'DENIED', 'Từ chối', 'Vui lòng liên hệ bảo vệ.', 'Được phép qua cổng'],
  ] as const)(
    'shows the %s %s headline and matching sub-text',
    (language, result, headline, hint, wrongHint) => {
      const page = renderToString(
        <KioskStatus
          language={language}
          view={{ kind: 'result', decision: { eventId: 'edge-event', result, firstName: 'Lan' } }}
        />,
      );
      const heading = page.match(/<h2>(.*?)<\/h2>/)?.[1];
      expect(heading).toContain(`<span lang="${language}" aria-hidden="false">${headline}</span>`);
      expect(page).toContain(`<span lang="${language}" aria-hidden="false">${hint}</span>`);
      expect(page).not.toContain(wrongHint);
    },
  );

  it.each([
    ['vi', 'REVOKED', 'Mã đã bị thu hồi'],
    ['vi', 'EXPIRED', 'Mã đã hết hạn'],
    ['en', 'REVOKED', 'Code revoked'],
    ['en', 'EXPIRED', 'Code expired'],
  ] as const)('explains %s %s denials', (language, reason, message) => {
    const page = renderToString(
      <KioskStatus
        language={language}
        view={{ kind: 'result', decision: { eventId: 'edge-event', result: 'DENIED', reason } }}
      />,
    );
    expect(page).toContain('kiosk-denial-reason');
    expect(page).toContain(`<span lang="${language}" aria-hidden="false">${message}</span>`);
  });

  it.each([undefined, 'NEW_REASON', 'toString', '<script>alert(1)</script>'])(
    'keeps the guard instruction for an absent or unrecognized denial reason %s',
    (reason) => {
      const page = renderToString(
        <KioskStatus
          language="en"
          view={{ kind: 'result', decision: { eventId: 'edge-event', result: 'DENIED', reason } }}
        />,
      );
      expect(page).toContain('Please contact the guard.');
      expect(page).not.toContain('kiosk-denial-reason');
      expect(page).not.toContain('You may pass through the gate');
    },
  );

  it('does not show a denial reason on a grant', () => {
    const page = renderToString(
      <KioskStatus
        view={{
          kind: 'result',
          decision: { eventId: 'e', result: 'GRANTED', firstName: 'Lan', reason: 'REVOKED' },
        }}
      />,
    );
    expect(page).not.toContain('kiosk-denial-reason');
  });

  it('escapes API names rather than treating them as HTML', () => {
    const page = renderToString(
      <KioskStatus
        view={{
          kind: 'result',
          decision: {
            eventId: 'edge-event',
            result: 'GRANTED',
            firstName: '<script>alert(1)</script>',
          },
        }}
      />,
    );
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;');
  });

  it('labels the local response time and only displays available employee details', () => {
    const receivedAt = new Date('2026-11-11T12:00:00Z');
    const page = renderToString(
      <KioskStatus
        receivedAt={receivedAt}
        language="en"
        view={{
          kind: 'result',
          decision: { result: 'GRANTED', eventId: 'private-event', firstName: 'An' },
        }}
      />,
    );
    expect(page).toContain('Response time');
    expect(page).toContain('dateTime="2026-11-11T12:00:00.000Z"');
    expect(page).toContain('Employee');
    expect(page).toContain('class="kiosk-name">An</dd>');
    expect(page).not.toContain('private-event');
    expect(page).not.toContain('Employee code');
  });
});

describe('kiosk settings persistence', () => {
  it('restores language and camera preferences on a fresh settings page', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    });
    saveDeviceSettings('en', 'environment');
    expect(readLanguage()).toBe('en');
    expect(readCameraFacing()).toBe('environment');
    const page = renderPage('/kiosk/settings?gateId=gate-1');
    expect(page).toContain('Kiosk settings');
    expect(page).toMatch(/aria-pressed="true"[^>]*>English<[/]button>/);
    expect(page).toMatch(
      /aria-pressed="true"[^>]*><span class="kiosk-translated">.*?Rear<[/]span>/,
    );
  });

  it.each([null, '', '{broken', 'unknown', 'EN', 'rear'])(
    'falls back to Vietnamese and front camera for invalid preferences %s',
    (value) => {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(readLanguage()).toBe('vi');
      expect(readCameraFacing()).toBe('user');
    },
  );

  it('tolerates blocked device preference storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Blocked');
      },
      setItem: () => {
        throw new Error('Full');
      },
    });
    expect(readLanguage()).toBe('vi');
    expect(readCameraFacing()).toBe('user');
    expect(() => saveDeviceSettings('en', 'environment')).not.toThrow();
  });
  it.each(['guided', 'scan-only'] as const)('saves and restores %s on a fresh page', (mode) => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    });
    saveDisplayMode('scan-only');
    saveDisplayMode(mode);
    expect(data.get('tmc.kiosk.displayMode')).toBe(mode);
    expect(readDisplayMode()).toBe(mode);
    const page = renderPage('/kiosk?gateId=gate-1');
    expect(page.includes('kiosk-scan-only')).toBe(mode === 'scan-only');
    const settings = renderPage('/kiosk/settings?gateId=gate-1');
    const selected = settings
      .match(/<input[^>]*>/g)
      ?.find((input) => input.includes(`value="${mode}"`));
    expect(selected).toContain('checked=""');
    expect(settings).not.toContain('kiosk-scan-only');
  });

  it.each([null, '', 'broken data', '{', 'null', '{"mode":"scan-only"}', 'SCAN-ONLY', ' guided '])(
    'falls back to guided for missing, corrupt or invalid storage: %s',
    (value) => {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(readDisplayMode()).toBe('guided');
      expect(renderPage('/kiosk?gateId=gate-1')).not.toContain('kiosk-scan-only');
    },
  );

  it('works when localStorage is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readDisplayMode()).toBe('guided');
    expect(() => saveDisplayMode('scan-only')).not.toThrow();
    expect(renderPage('/kiosk?gateId=gate-1')).not.toContain('kiosk-scan-only');
  });

  it('falls back on read errors and tolerates write errors', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Storage blocked');
      },
      setItem: () => {
        throw new Error('Storage quota exceeded');
      },
    });
    expect(readDisplayMode()).toBe('guided');
    expect(() => saveDisplayMode('scan-only')).not.toThrow();
    expect(renderPage('/kiosk?gateId=gate-1')).not.toContain('kiosk-scan-only');
  });
});
