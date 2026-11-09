import { formatDay, formatTime } from '../portal/history';
import type { CorrectableRecord, CorrectionEntry, CorrectionField } from './corrections';

const cell = { padding: '6px 8px', textAlign: 'left' as const };

export const FIELD_LABEL: Record<CorrectionField, string> = {
  FIRST_IN: 'First in',
  LAST_OUT: 'Last out',
};

/** An employee's daily records, each with the button that opens it for correction. */
export function RecordsTable({
  records,
  onOpen,
}: {
  records: CorrectableRecord[];
  onOpen: (record: CorrectableRecord) => void;
}) {
  if (records.length === 0) return <p>No daily records in this range.</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={cell}>Day</th>
          <th style={cell}>First in</th>
          <th style={cell}>Last out</th>
          <th style={cell}>Hours</th>
          <th style={cell} />
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={record.recordId}>
            <td style={cell}>{formatDay(record.day)}</td>
            <td style={cell}>{formatTime(record.firstIn)}</td>
            <td style={cell}>{formatTime(record.lastOut)}</td>
            <td style={cell}>
              {record.missingPunch ? <strong>Missing punch</strong> : record.hours}
              {record.corrected && <small> Corrected</small>}
            </td>
            <td style={cell}>
              <button type="button" onClick={() => onOpen(record)}>
                Correct
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every change to one record, so the original values stay visible (FR-3.6). */
export function CorrectionHistory({ entries }: { entries: CorrectionEntry[] }) {
  if (entries.length === 0) return <p>Not corrected yet. The values above come from the scans.</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={cell}>Value</th>
          <th style={cell}>Original</th>
          <th style={cell}>Corrected</th>
          <th style={cell}>Reason</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.createdAt + entry.field}>
            <td style={cell}>{FIELD_LABEL[entry.field]}</td>
            <td style={cell}>{formatTime(entry.originalValue)}</td>
            <td style={cell}>{formatTime(entry.correctedValue)}</td>
            <td style={cell}>{entry.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
