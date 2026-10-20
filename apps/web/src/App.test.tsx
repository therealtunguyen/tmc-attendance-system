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
});
