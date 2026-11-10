import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Profile } from './history';
import { HistoryScreen, type HistoryView } from './HistoryScreen';

const profile: Profile = {
  code: 'BD-0001',
  firstName: 'Lan',
  lastName: 'Nguyen',
  email: 'lan@example.com',
  factoryId: 'binh-duong',
  teamId: 'bd-line-1',
};
const render = (view: HistoryView) => renderToString(<HistoryScreen view={view} />);

describe('HistoryScreen', () => {
  it('shows the profile and each day with first in, last out and hours', () => {
    const page = render({
      kind: 'ok',
      profile,
      records: [
        {
          day: '2026-11-06T17:00:00.000Z',
          firstIn: '2026-11-07T00:58:00.000Z',
          lastOut: '2026-11-07T10:03:00.000Z',
          hours: 9.08,
          missingPunch: false,
        },
      ],
    });
    for (const text of [
      'Nguyen',
      'BD-0001',
      'lan@example.com',
      'binh-duong',
      'bd-line-1',
      '07/11/2026',
      '07:58',
      '17:03',
      '9.08',
    ]) {
      expect(page).toContain(text);
    }
    expect(page).not.toContain('Missing punch');
  });

  it('flags a missing punch instead of showing 0 hours', () => {
    const page = render({
      kind: 'ok',
      profile,
      records: [
        {
          day: '2026-11-06T17:00:00.000Z',
          firstIn: '2026-11-07T00:58:00.000Z',
          lastOut: null,
          hours: 0,
          missingPunch: true,
        },
      ],
    });
    expect(page).toContain('Missing punch');
    expect(page).toContain('–');
  });

  it('says so when there is nothing yet, still showing the profile', () => {
    const page = render({ kind: 'ok', profile, records: [] });
    expect(page).toContain('No attendance recorded yet.');
    expect(page).toContain('BD-0001');
  });

  it.each([
    [{ kind: 'loading' }, 'Loading your attendance'],
    [{ kind: 'down' }, 'Could not load your attendance'],
    [{ kind: 'signed-out' }, 'Your session has ended'],
    [{ kind: 'denied', reason: 'NO_EMPLOYEE' }, 'no employee record'],
    [{ kind: 'denied', reason: 'NOTICE_REQUIRED' }, 'privacy notice'],
    [{ kind: 'denied', reason: 'OTHER' }, 'contact HR'],
  ] as [HistoryView, string][])('shows state %j', (view, text) => {
    expect(render(view)).toContain(text);
  });
});
