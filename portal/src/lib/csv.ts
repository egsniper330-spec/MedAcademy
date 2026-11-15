/**
 * Small CSV reader used by course import.
 *
 * Handles UTF-8 BOM, CRLF/LF, quoted fields, escaped quotes and commas inside
 * descriptions. It never evaluates cell content; callers send parsed strings to
 * the server, which validates them again.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function parseCsv(input: string): ParsedCsv {
  const text = stripBom(input);
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      record.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(cell);
      cell = '';
      if (record.some((value) => value.trim() !== '')) records.push(record);
      record = [];
    } else {
      cell += char;
    }
  }

  if (quoted) {
    return { headers: [], rows: [], errors: ['The file has an unterminated quoted field.'] };
  }
  record.push(cell);
  if (record.some((value) => value.trim() !== '')) records.push(record);

  if (records.length === 0) {
    return { headers: [], rows: [], errors: ['The file is empty.'] };
  }

  const headers = records[0].map((header) => header.trim().toLowerCase());
  if (!headers.includes('title')) {
    return { headers, rows: [], errors: ['The file must contain a "title" column.'] };
  }

  const errors: string[] = [];
  const rows: Record<string, string>[] = [];
  for (let index = 1; index < records.length; index++) {
    const values = records[index];
    if (values.length !== headers.length) {
      errors.push(`Row ${index + 1}: expected ${headers.length} columns, found ${values.length}.`);
      continue;
    }
    const row: Record<string, string> = {};
    headers.forEach((header, column) => { row[header] = values[column].trim(); });
    rows.push(row);
  }

  return { headers, rows, errors };
}

export const COURSE_CSV_HEADERS = [
  'title',
  'short_description',
  'full_description',
  'language',
  'price_egp',
] as const;

export function courseCsvTemplate(): string {
  return [
    COURSE_CSV_HEADERS.join(','),
    'Clinical Pharmacology,One-line summary,"Full description, with commas",Arabic,0',
  ].join('\r\n');
}
