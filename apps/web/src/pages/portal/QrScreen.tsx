import { QRCodeSVG } from 'qrcode.react';
import type { DenyReason, QrView } from './live-qr';

const DENIED: Record<DenyReason, string> = {
  REVOKED: 'Your QR code has been revoked. Contact HR.',
  INACTIVE: 'Your employee record is inactive. Contact HR.',
  UNKNOWN: 'Your employee record was not found. Contact HR.',
  NO_EMPLOYEE: 'This account has no employee record, so it has no QR code.',
  OTHER: 'Your QR code is not available right now. If this keeps happening, contact HR.',
};

const quiet = { color: '#555' };

/** What the page shows for each state. No QR unless it would be accepted at a gate. */
export function QrScreen({ view }: { view: QrView }) {
  switch (view.kind) {
    case 'loading':
      return <p>Loading your QR code…</p>;
    case 'denied':
      return <p role="alert">{DENIED[view.reason]}</p>;
    case 'expired':
      return <p role="alert">No connection, and no valid QR code saved here. Check your signal.</p>;
    case 'signed-out':
      return <p>Your session has ended.</p>;
    case 'showing':
      return (
        <section>
          <h2 style={{ marginBottom: 0 }}>
            {view.qr.firstName} {view.qr.lastName}
          </h2>
          <p style={{ ...quiet, marginTop: 4 }}>{view.qr.code}</p>
          {/* White box and quiet zone in dark mode too: a scanner needs them. */}
          <div
            style={{ background: '#fff', display: 'inline-block', lineHeight: 0, maxWidth: '100%' }}
          >
            <QRCodeSVG
              value={view.qr.token}
              size={320}
              level="L"
              marginSize={4}
              style={{ width: '100%', height: 'auto' }}
            />
          </div>
          {view.offline ? (
            <p role="status">No connection. This is your last QR code, still valid for now.</p>
          ) : (
            <p style={quiet}>This code changes by itself. A screenshot will not work.</p>
          )}
        </section>
      );
  }
}
