import { Link, Route, Routes } from 'react-router';
import { KioskPage } from './pages/kiosk/KioskPage';
import { PortalPage } from './pages/portal/PortalPage';
import { StaffPage } from './pages/staff/StaffPage';

function Home() {
  return (
    <main>
      <h1>TMC Attendance</h1>
      <nav>
        <ul>
          <li>
            <Link to="/kiosk">Kiosk</Link>
          </li>
          <li>
            <Link to="/portal">Employee portal</Link>
          </li>
          <li>
            <Link to="/staff">Staff</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/kiosk/*" element={<KioskPage />} />
      <Route path="/portal/*" element={<PortalPage />} />
      <Route path="/staff/*" element={<StaffPage />} />
    </Routes>
  );
}
