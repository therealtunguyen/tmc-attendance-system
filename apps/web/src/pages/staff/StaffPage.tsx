import { Link, Route, Routes } from 'react-router';
import { CorrectionsPage } from './CorrectionsPage';
import { GuardPage } from './guard/GuardPage';

/** Each staff screen owns its layout and verifies its own access. */
export function StaffPage() {
  return (
    <Routes>
      <Route
        index
        element={
          <main>
            <h1>Staff</h1>
            <ul>
              <li>
                <Link to="guard">Guard: access log and override</Link>
              </li>
              <li>
                <Link to="corrections">Correct attendance</Link>
              </li>
            </ul>
          </main>
        }
      />
      <Route path="guard" element={<GuardPage />} />
      <Route
        path="corrections"
        element={
          <main style={{ padding: 16, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui' }}>
            <CorrectionsPage />
          </main>
        }
      />
    </Routes>
  );
}
