// What Python's csv.writer (default dialect, QUOTE_MINIMAL) writes for a row
// of the values the backend passes it: str() of each value, None as an empty
// field, quoted only when it holds the delimiter, the quote character or a
// line break, and "\r\n" after every row.
import { PyFloat } from '../parse/pyJson';
import { pyFloatRepr, pyIntRepr } from '../parse/pyNumber';

/** str() of one csv cell. A plain number is an int when integral (use PyFloat or csvFloat for floats). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === 'number') return Number.isInteger(value) ? pyIntRepr(value) : pyFloatRepr(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** A Python float's csv cell (repr: 1.0, 1e-05, nan). */
export const csvFloat = pyFloatRepr;

/** A Python int's csv cell. */
export const csvInt = pyIntRepr;

const NEEDS_QUOTES = /[",\r\n]/;

/** One row, terminator included, from cells already turned into text. */
export function csvRowText(cells: readonly string[]): string {
  // csv writes a lone empty field as "" so the row is not mistaken for a blank line.
  if (cells.length === 1 && cells[0] === '') return '""\r\n';
  let out = '';
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (i) out += ',';
    out += NEEDS_QUOTES.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  }
  return `${out}\r\n`;
}

/** csv.writer(...).writerow(values). */
export function csvRow(values: readonly unknown[]): string {
  return csvRowText(values.map(csvCell));
}

/**
 * csv.reader over text (default dialect), enough for reading back what the
 * writer produces and the hand-made files the timeline accepts: quoted fields,
 * doubled quotes, \r\n / \n / \r line ends.
 */
export function csvParse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '' && !quoted) {
      inQuotes = true;
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      // A blank line is no row at all, as in csv.reader.
      if (row.length === 0 && field === '' && !quoted) {
        rows.push([]);
      } else {
        endRow();
      }
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || quoted || row.length) endRow();
  return rows;
}
