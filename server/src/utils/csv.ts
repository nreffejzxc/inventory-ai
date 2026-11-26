/**
 * Dependency-free CSV reader for the bulk product import (FW-01).
 *
 * The file is untrusted: it comes from a customer's spreadsheet. This parser
 * therefore keeps the raw text in memory only up to a hard byte cap, refuses an
 * unterminated quote, and bounds the row/column counts before the import service
 * ever looks at a value. It supports the RFC 4180 forms the feature needs:
 * quoted fields, doubled quotes inside a quoted field, commas and newlines
 * inside quotes, CRLF or LF line endings, and a UTF-8 BOM.
 *
 * The result is keyed by NORMALISED header names (`unitPrice` and
 * `unit_price` both become `unitprice`) so the service has one contract to
 * validate. Header problems are returned as data, never thrown: the controller
 * turns them into a row-level report.
 */

export const CSV_MAX_BYTES = 512 * 1024;
export const CSV_MAX_ROWS = 500;
export const CSV_MAX_COLUMNS = 30;

export type CsvProblem = {
  line: number;
  field: string | null;
  code: string;
  message: string;
};

export type CsvRow = {
  /** 1-based physical line where the data row starts. The header is line 1. */
  line: number;
  values: Record<string, string>;
};

export type CsvTable = {
  headers: string[];
  rows: CsvRow[];
};

export type CsvParseResult = {
  table?: CsvTable;
  problems: CsvProblem[];
};

const normaliseHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function problem(line: number, field: string | null, code: string, message: string): CsvProblem {
  return { line, field, code, message };
}

/**
 * Parse a bounded CSV. The first non-empty row is the header. Empty rows are
 * skipped but their physical line numbers are preserved, so a later error
 * points at the line the operator can open in a spreadsheet.
 */
export function parseCsv(text: unknown): CsvParseResult {
  const problems: CsvProblem[] = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { problems: [problem(1, null, 'CSV_EMPTY', 'The CSV file is empty.')] };
  }

  if (Buffer.byteLength(text, 'utf8') > CSV_MAX_BYTES) {
    return {
      problems: [
        problem(
          1,
          null,
          'CSV_TOO_LARGE',
          `The CSV file must be at most ${Math.floor(CSV_MAX_BYTES / 1024)} KiB.`,
        ),
      ],
    };
  }

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  type RawRow = { line: number; cells: string[] };
  const rawRows: RawRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterClosingQuote = false;
  let physicalLine = 1;
  let rowLine = 1;
  let fieldCount = 0;

  const pushField = () => {
    cells.push(field);
    field = '';
    afterClosingQuote = false;
    fieldCount += 1;
  };

  const pushRow = () => {
    pushField();
    if (cells.some((cell) => cell.trim() !== '')) {
      rawRows.push({ line: rowLine, cells });
    }
    cells = [];
    fieldCount = 0;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else {
        if (ch === '\n') physicalLine += 1;
        field += ch;
      }
      continue;
    }

    if (afterClosingQuote) {
      if (ch === ',') {
        pushField();
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && source[i + 1] === '\n') i += 1;
        pushRow();
        physicalLine += 1;
        rowLine = physicalLine;
        continue;
      }
      return {
        problems: [
          problem(
            physicalLine,
            null,
            'CSV_MALFORMED',
            'A quoted field must be followed by a comma or the end of the line.',
          ),
        ],
      };
    }

    if (ch === '"') {
      if (field.trim() !== '') {
        return {
          problems: [
            problem(
              physicalLine,
              null,
              'CSV_MALFORMED',
              'A quote may only start a field, not appear in the middle of an unquoted value.',
            ),
          ],
        };
      }
      field = '';
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      pushField();
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      pushRow();
      physicalLine += 1;
      rowLine = physicalLine;
      continue;
    }

    // An unquoted field that starts with whitespace and later contains a quote
    // is caught above. Keep the value intact; the service trims it.
    field += ch;
    if (fieldCount >= CSV_MAX_COLUMNS) {
      return {
        problems: [
          problem(
            physicalLine,
            null,
            'CSV_TOO_MANY_COLUMNS',
            `A row may have at most ${CSV_MAX_COLUMNS} columns.`,
          ),
        ],
      };
    }
  }

  if (inQuotes) {
    return {
      problems: [problem(rowLine, null, 'CSV_MALFORMED', 'A quoted field is not closed.')],
    };
  }
  if (field !== '' || cells.length > 0) {
    pushRow();
  }

  if (rawRows.length === 0) {
    return { problems: [problem(1, null, 'CSV_EMPTY', 'The CSV file does not contain a header row.')] };
  }

  const headerRow = rawRows[0];
  if (!headerRow) {
    return { problems: [problem(1, null, 'CSV_EMPTY', 'The CSV file does not contain a header row.')] };
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < headerRow.cells.length; index += 1) {
    const raw = (headerRow.cells[index] ?? '').trim();
    const header = normaliseHeader(raw);
    if (!header) {
      problems.push(problem(headerRow.line, null, 'CSV_HEADER_EMPTY', `Column ${index + 1} has no name.`));
      continue;
    }
    if (seen.has(header)) {
      problems.push(
        problem(headerRow.line, header, 'CSV_DUPLICATE_COLUMN', `The column "${raw}" appears more than once.`),
      );
      continue;
    }
    seen.add(header);
    headers.push(header);
  }

  const dataRows = rawRows.slice(1);
  if (dataRows.length === 0) {
    problems.push(problem(headerRow.line, null, 'CSV_NO_ROWS', 'The CSV file has a header but no data rows.'));
  }
  if (dataRows.length > CSV_MAX_ROWS) {
    problems.push(
      problem(
        headerRow.line,
        null,
        'CSV_TOO_MANY_ROWS',
        `The CSV file may contain at most ${CSV_MAX_ROWS} data rows.`,
      ),
    );
  }

  const rows: CsvRow[] = [];
  for (const raw of dataRows) {
    if (raw.cells.length > headers.length) {
      problems.push(
        problem(
          raw.line,
          null,
          'CSV_TOO_MANY_FIELDS',
          `This row has ${raw.cells.length} fields but the header defines ${headers.length}.`,
        ),
      );
      continue;
    }
    const values: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header) values[header] = raw.cells[index] ?? '';
    }
    rows.push({ line: raw.line, values });
  }

  if (problems.length) return { problems };
  return { table: { headers, rows }, problems: [] };
}

export default { parseCsv, CSV_MAX_BYTES, CSV_MAX_ROWS, CSV_MAX_COLUMNS };
