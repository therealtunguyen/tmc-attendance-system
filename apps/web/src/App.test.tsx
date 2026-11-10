import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from './App';

const renderAt = (path: string) =>
  renderToString(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );

describe('AppRoutes', () => {
  it.each([
    ['/kiosk', 'Kiosk'],
    ['/portal', 'Employee portal'],
    ['/staff', 'Staff'],
  ])('renders %s', (path, heading) => {
    expect(renderAt(path)).toContain(heading);
  });

  it('links the portal to the QR page', () => {
    expect(renderAt('/portal')).toContain('href="/portal/qr"');
  });

  it('asks for a sign-in on the QR page, which is where the email links', () => {
    const page = renderAt('/portal/qr');
    expect(page).toContain('Employee portal');
    expect(page).toContain('Sign in to see your QR code');
  });
});
