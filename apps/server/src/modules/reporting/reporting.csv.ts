// CSV writer (FR-4.2). Pure: no I/O, so it is tested alone.

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null;
}

/** Characters that make a spreadsheet read a text cell as a formula (OWASP "CSV injection"). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Text cells are guarded against formula injection; numbers, booleans and null never are. */
const cell = (value: string | number | boolean | null, isText: boolean): string => {
  if (value === null) return '';
  const text = String(value);
  const safe = isText && FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** RFC 4180 CSV (FR-4.2): header row, CRLF line ends, guarded against formula injection. */
export const toCsv = <T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string => {
  const lines = [columns.map((c) => cell(c.header, true)).join(',')];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const v = c.value(row);
          return cell(v, typeof v === 'string');
        })
        .join(','),
    );
  }
  return lines.map((line) => `${line}\r\n`).join('');
};
