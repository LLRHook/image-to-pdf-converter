import Papa from 'papaparse';
import { fmtN } from '../../core/structure/text';
import { type Cell, type Table, LIMITS, assertCells, cellText } from './model';

export const DELIM = { csv: ',', tsv: '\t' } as const;

/**
 * Parse delimited text into rows of strings. Streams in ~4 MB chunks so
 * progress is the real fraction of the text consumed. CSV auto-detects
 * `, ; | tab`; TSV is always tab. Rows may be ragged (kept as they are).
 */
export function parseDelimited(
  text: string,
  kind: 'csv' | 'tsv',
  onProgress: (fraction: number) => void,
  limits: { rows?: number; target?: string } = {},
): { rows: string[][]; delimiter: string; cols: number } {
  const rows: string[][] = [];
  let delimiter: string = DELIM[kind];
  let error: string | null = null;
  let widestRow = 0;
  const total = text.length || 1;
  const config = {
    delimiter: kind === 'tsv' ? '\t' : '',
    delimitersToGuess: [',', ';', '\t', '|'],
    skipEmptyLines: true,
    chunkSize: 4 * 1024 * 1024,
    chunk: (res: Papa.ParseResult<string[]>, parser: Papa.Parser) => {
      delimiter = res.meta.delimiter || delimiter;
      const data = res.data;
      for (let i = 0; i < data.length; i++) {
        const r = data[i]!;
        if (r.length > widestRow) widestRow = r.length;
        rows.push(r);
      }
      if (limits.rows && rows.length > limits.rows) {
        error = `The file has more than ${fmtN(limits.rows)} rows, which ${limits.target ?? 'the target format'} cannot hold. Nothing was cut off: choose CSV or JSON, or split the file.`;
        parser.abort();
        return;
      }
      if (widestRow > 0 && rows.length * widestRow > LIMITS.cells) {
        error = `The file is too large to convert in the browser (more than ${fmtN(LIMITS.cells)} cells).`;
        parser.abort();
        return;
      }
      onProgress(Math.min(1, res.meta.cursor / total));
    },
  };
  // PapaParse streams a string in chunks when `chunk` is set; its typings only declare that for files.
  Papa.parse(text, config as unknown as Papa.ParseConfig<string[]>);
  if (error) throw new Error(error);
  if (rows.length === 0) throw new Error('The file has no rows.');
  assertCells(rows.length, widestRow, 'The file');
  return { rows, delimiter, cols: widestRow };
}

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/;

/** Text of one cell; with `escapeFormulae`, text a spreadsheet would run as a formula gets a leading apostrophe. */
function cellString(c: Cell, escapeFormulae: boolean): string {
  const s = cellText(c);
  if (escapeFormulae && typeof c === 'string' && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) return "'" + s;
  return s;
}

/** Serialize a table as delimited text; progress is rows written / `totalRows`. */
export function serializeDelimited(
  table: Table,
  delimiter: string,
  newline: string,
  escapeFormulae: boolean,
  onRows: (n: number) => void,
): string[] {
  const parts: string[] = [];
  const rows = table.rows;
  const BATCH = 5000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch: string[][] = [];
    const end = Math.min(rows.length, i + BATCH);
    for (let r = i; r < end; r++) batch.push(rows[r]!.map((c) => cellString(c, escapeFormulae)));
    parts.push(
      Papa.unparse(batch, { delimiter, newline, quotes: false, skipEmptyLines: false }),
      end < rows.length ? newline : '',
    );
    onRows(end - i);
  }
  if (rows.length > 0) parts.push(newline);
  return parts;
}

