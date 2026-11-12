import { formatDay, formatTime, type HistoryDenyReason, type HistoryFetch } from './history';

const DENIED: Record<HistoryDenyReason, string> = {
  NO_EMPLOYEE: 'This account has no employee record, so it has no attendance history.',
  NOTICE_REQUIRED: 'Please acknowledge the privacy notice before viewing your attendance.',
  OTHER: 'Your attendance is not available right now. If this keeps happening, contact HR.',
};

const quiet = { color: '#555' };
const cell = { padding: '6px 8px', textAlign: 'left' as const };

export type HistoryView = HistoryFetch | { kind: 'loading' };

/** What the page shows for each state. */
export function HistoryScreen({ view }: { view: HistoryView }) {
  switch (view.kind) {
    case 'loading':
      return <p>Loading your attendance…</p>;
    case 'denied':
      return <p role="alert">{DENIED[view.reason]}</p>;
    case 'down':
      return <p role="alert">Could not load your attendance. Check your signal and try again.</p>;
    case 'signed-out':
      return <p>Your session has ended.</p>;
    case 'ok':
      return (
        <>
          <section>
            <h2 style={{ marginBottom: 0 }}>
              {view.profile.firstName} {view.profile.lastName}
            </h2>
            <p style={{ ...quiet, marginTop: 4 }}>{view.profile.code}</p>
            <p style={quiet}>
              {view.profile.email}
              <br />
              Factory: {view.profile.factoryId}
              {view.profile.teamId && ` · Team: ${view.profile.teamId}`}
            </p>
          </section>
          <section>
            <h2>Attendance history</h2>
            {view.records.length === 0 ? (
              <p>No attendance recorded yet.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={cell}>Day</th>
                    <th style={cell}>First in</th>
                    <th style={cell}>Last out</th>
                    <th style={cell}>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {view.records.map((record) => (
                    <tr key={record.day}>
                      <td style={cell}>{formatDay(record.day)}</td>
                      <td style={cell}>{formatTime(record.firstIn)}</td>
                      <td style={cell}>{formatTime(record.lastOut)}</td>
                      <td style={cell}>
                        {record.missingPunch ? <strong>Missing punch</strong> : record.hours}
                        {record.corrected && <small style={quiet}> Corrected by HR</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      );
  }
}
