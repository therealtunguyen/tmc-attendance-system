import { describe, expect, it } from 'vitest';
import { toCsv, type CsvColumn } from './reporting.csv.js';

interface Row {
  name: string | null;
  n: number;
  ok?: boolean;
}
const columns: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'N', value: (r) => r.n },
];

describe('toCsv (FR-4.2)', () => {
  it('writes a header and one CRLF-terminated line per row, in order', () => {
    const csv = toCsv(columns, [
      { name: 'An', n: 1 },
      { name: 'Binh', n: 2.5 },
    ]);
    expect(csv).toBe('Name,N\r\nAn,1\r\nBinh,2.5\r\n');
  });

  it('writes only the header for zero rows', () => {
    expect(toCsv(columns, [])).toBe('Name,N\r\n');
  });

  it('writes booleans and null', () => {
    const cols: CsvColumn<Row>[] = [
      { header: 'Name', value: (r) => r.name },
      { header: 'Ok', value: (r) => r.ok ?? null },
    ];
    expect(toCsv(cols, [{ name: null, n: 0, ok: true }])).toBe('Name,Ok\r\n,true\r\n');
  });

  it('quotes commas, quotes and newlines and doubles the quotes', () => {
    const csv = toCsv(columns, [{ name: 'Nguyễn, "Lan"\nB', n: 1 }]);
    expect(csv).toBe('Name,N\r\n"Nguyễn, ""Lan""\nB",1\r\n');
  });

  it('quotes a field with a carriage return', () => {
    expect(toCsv(columns, [{ name: 'a\rb', n: 1 }])).toBe('Name,N\r\n"a\rb",1\r\n');
  });

  it('passes Vietnamese text unchanged', () => {
    expect(toCsv(columns, [{ name: 'Trần Thị Ngọc Ánh', n: 1 }])).toBe(
      'Name,N\r\nTrần Thị Ngọc Ánh,1\r\n',
    );
  });

  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tx', "'\tx"],
    [' =1+1', "' =1+1"],
    ['   @SUM(A1)', "'   @SUM(A1)"],
    ['\u00a0=1', "'\u00a0=1"],
    [' -', "' -"],
    [' plain', ' plain'],
  ])('writes %j as the guarded cell', (name, written) => {
    expect(toCsv(columns, [{ name, n: 1 }])).toBe(`Name,N\r\n${written},1\r\n`);
  });

  it('guards a header cell with a leading space before =', () => {
    const cols: CsvColumn<Row>[] = [{ header: ' =evil', value: (r) => r.n }];
    expect(toCsv(cols, [])).toBe("' =evil\r\n");
  });

  it('guards the header cells too', () => {
    const cols: CsvColumn<Row>[] = [{ header: '=evil', value: (r) => r.n }];
    expect(toCsv(cols, [])).toBe("'=evil\r\n");
  });

  it('leaves a negative number alone', () => {
    expect(toCsv(columns, [{ name: 'An', n: -3 }])).toBe('Name,N\r\nAn,-3\r\n');
  });

  it('does not guard a dash inside the text', () => {
    expect(toCsv(columns, [{ name: 'a-b', n: 1 }])).toBe('Name,N\r\na-b,1\r\n');
  });

  it('guards first, then quotes', () => {
    expect(toCsv(columns, [{ name: '=1,2', n: 1 }])).toBe('Name,N\r\n"\'=1,2",1\r\n');
  });
});
