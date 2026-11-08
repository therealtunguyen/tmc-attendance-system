import { Link, Route, Routes } from 'react-router';
import { QrPage } from './QrPage';

/** Employee portal (phone-friendly): own QR, profile and attendance history (FR-1.3, FR-1.6). */
export function PortalPage() {
  return (
    <main style={{ padding: 16, maxWidth: 480, margin: '0 auto', fontFamily: 'system-ui' }}>
      <h1>Employee portal</h1>
      <Routes>
        <Route index element={<Link to="qr">My QR code</Link>} />
        <Route path="qr" element={<QrPage />} />
      </Routes>
    </main>
  );
}
