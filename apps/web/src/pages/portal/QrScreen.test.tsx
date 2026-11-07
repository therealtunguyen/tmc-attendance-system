import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QrView, ShownQr } from './live-qr';
import { QrScreen } from './QrScreen';

const qr: ShownQr = {
  token: 'eyJhbGciOiJFZERTQSJ9.e30.AAAA',
  firstName: 'Lan',
  lastName: 'Nguyen',
  code: 'BD-0001',
  showUntil: 100,
};
const render = (view: QrView) => renderToString(<QrScreen view={view} />);

describe('QrScreen', () => {
  it('draws the QR with the name and code', () => {
    const page = render({ kind: 'showing', qr, offline: false });
    expect(page).toContain('<svg');
    expect(page).toContain('Nguyen');
    expect(page).toContain('BD-0001');
    expect(page).not.toContain('No connection');
  });

  it('says so when it is the last token', () => {
    const page = render({ kind: 'showing', qr, offline: true });
    expect(page).toContain('<svg');
    expect(page).toContain('No connection');
  });

  it.each<[QrView, string]>([
    [{ kind: 'denied', reason: 'REVOKED' }, 'revoked'],
    [{ kind: 'denied', reason: 'INACTIVE' }, 'inactive'],
    [{ kind: 'denied', reason: 'UNKNOWN' }, 'not found'],
    [{ kind: 'denied', reason: 'NO_EMPLOYEE' }, 'no employee record'],
    [{ kind: 'expired' }, 'No connection'],
    [{ kind: 'loading' }, 'Loading'],
    [{ kind: 'signed-out' }, 'session has ended'],
  ])('draws no QR for %j', (view, message) => {
    const page = render(view);
    expect(page).toContain(message);
    expect(page).not.toContain('<svg');
  });
});
