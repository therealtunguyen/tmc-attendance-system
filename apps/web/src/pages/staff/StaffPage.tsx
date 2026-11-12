import { Link, Route, Routes } from 'react-router';
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
            <Link to="guard">Guard: access log and override</Link>
          </main>
        }
      />
      <Route path="guard" element={<GuardPage />} />
    </Routes>
  );
}
