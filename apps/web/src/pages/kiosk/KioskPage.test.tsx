import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { KioskPage, KioskStatus } from './KioskPage';
import type { KioskView } from './kiosk-scan';

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
    expect(page).not.toContain('id="scanner-input"');
  });

  it('keeps a labelled hardware-scanner input without manual entry', () => {
    const page = renderPage('/kiosk?gateId=gate-1');
    expect(page).toContain('gate-1');
    expect(page).toContain('Quét mã QR');
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
    [{ kind: 'idle' }, 'Scan QR'],
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
    expect(page).toContain('DENIED');
    expect(page).not.toContain('kiosk-name');
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
});
