import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccessLogTable, OverrideStatus } from './GuardPage';
import type { AccessRow, OverrideInput } from './guard-api';

const row: AccessRow = {
  eventId: 'qr-1',
  occurredAt: '2026-11-11T01:20:30Z',
  gateId: 'gate-1',
  gateName: 'Entrance',
  factoryId: 'bd',
  method: 'QR',
  outcome: 'DENIED',
  denyReason: 'REVOKED',
  guardId: null,
  overrideReason: null,
  employeeCode: 'BD-001',
  firstName: '<script>An</script>',
};
const input: OverrideInput = {
  eventId: 'manual-1',
  employeeId: 'emp-1',
  reason: 'Phone broken',
  mode: 'OPEN',
};

describe('guard access-log display', () => {
  it('shows denied QR, manual overrides and pending events with Vietnam times and traceable IDs', () => {
    const page = renderToString(
      <AccessLogTable
        rows={[
          row,
          {
            ...row,
            eventId: 'manual-1',
            method: 'MANUAL',
            outcome: 'GRANTED',
            denyReason: null,
            guardId: 'guard-1',
            overrideReason: 'Phone broken',
          },
          {
            ...row,
            eventId: 'pending-1',
            outcome: 'PENDING',
            firstName: null,
            employeeCode: null,
            gateName: null,
          },
        ]}
      />,
    );
    for (const text of [
      '08:20:30',
      'BD-001',
      'Entrance',
      'REVOKED',
      'Phone broken',
      'guard-1',
      'qr-1',
      'manual-1',
      'pending-1',
      'DENIED',
      'GRANTED',
      'PENDING',
      'Unidentified',
      'gate-1',
    ]) {
      expect(page).toContain(text);
    }
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;');
  });
  it('explains an empty result', () => {
    expect(renderToString(<AccessLogTable rows={[]} />)).toContain('No access events match');
  });
});

describe('override outcome display', () => {
  it('does not claim the gate opened when the response was lost', () => {
    const page = renderToString(<OverrideStatus input={input} result={{ kind: 'unknown' }} />);
    expect(page).toContain('Outcome unknown');
    expect(page).toContain('Do not repeat');
    expect(page).toContain('manual-1');
    expect(page).not.toContain('confirmed opening');
  });
  it('distinguishes a backfill from a physical open', () => {
    const page = renderToString(
      <OverrideStatus
        input={{ ...input, mode: 'BACKFILL' }}
        result={{ kind: 'decided', outcome: 'GRANTED' }}
      />,
    );
    expect(page).toContain('Admission recorded. No open command was sent.');
  });
  it('does not grant attendance on a TCS denial', () => {
    expect(
      renderToString(
        <OverrideStatus input={input} result={{ kind: 'decided', outcome: 'DENIED' }} />,
      ),
    ).toContain('No attendance was granted.');
  });
});
