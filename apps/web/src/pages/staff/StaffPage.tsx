import { Link, Route, Routes } from 'react-router';
import { CorrectionsPage } from './CorrectionsPage';

/** HR, supervisors, guards, admins and executives; screens are shown by role. */
export function StaffPage() {
  return (
    <main style={{ padding: 16, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui' }}>
      <h1>Staff</h1>
      <Routes>
        <Route index element={<Link to="corrections">Correct attendance</Link>} />
        <Route path="corrections" element={<CorrectionsPage />} />
      </Routes>
    </main>
  );
}
