import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CorrectableRecord } from './corrections';
import { CorrectionHistory, RecordsTable } from './CorrectionsScreen';

const record: CorrectableRecord = {
  recordId: 'emp-1_2026-11-07',
  day: '2026-11-06T17:00:00.000Z',
  firstIn: '2026-11-07T00:58:00.000Z',
  lastOut: null,
  hours: 0,
  missingPunch: true,
};

describe('RecordsTable', () => {
  const render = (records: CorrectableRecord[]) =>
    renderToString(<RecordsTable records={records} onOpen={() => {}} />);

  it('shows the day in Vietnam time and flags a missing punch', () => {
    const page = render([record]);
    for (const text of ['07/11/2026', '07:58', '–', 'Missing punch', 'Correct']) {
      expect(page).toContain(text);
    }
  });

  it('shows hours and marks a corrected day', () => {
    const page = render([
      {
        ...record,
        lastOut: '2026-11-07T10:03:00.000Z',
        hours: 9.08,
        missingPunch: false,
        corrected: true,
      },
    ]);
    expect(page).toContain('17:03');
    expect(page).toContain('9.08');
    expect(page).toContain('Corrected');
    expect(page).not.toContain('Missing punch');
  });

  it('says so when the range is empty', () => {
    expect(render([])).toContain('No daily records in this range.');
  });
});

describe('CorrectionHistory', () => {
  it('keeps the original value and the reason in view (FR-3.6)', () => {
    const page = renderToString(
      <CorrectionHistory
        entries={[
          {
            field: 'FIRST_IN',
            originalValue: '2026-11-07T00:58:00.000Z',
            correctedValue: '2026-11-07T01:00:00.000Z',
            reason: 'Wrong gate clock',
            correctedBy: 'hr-1',
            createdAt: '2026-11-08T01:00:00.000Z',
          },
        ]}
      />,
    );
    for (const text of ['First in', '07:58', '08:00', 'Wrong gate clock']) {
      expect(page).toContain(text);
    }
  });

  it('shows a dash when the day had no last out before', () => {
    const page = renderToString(
      <CorrectionHistory
        entries={[
          {
            field: 'LAST_OUT',
            originalValue: null,
            correctedValue: '2026-11-07T10:00:00.000Z',
            reason: 'Forgot',
            correctedBy: 'hr-1',
            createdAt: '2026-11-08T01:00:00.000Z',
          },
        ]}
      />,
    );
    expect(page).toContain('–');
  });

  it('says when nothing was corrected', () => {
    expect(renderToString(<CorrectionHistory entries={[]} />)).toContain('Not corrected yet');
  });
});
