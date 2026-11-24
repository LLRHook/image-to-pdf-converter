/**
 * Shared model for the sheet engine: one in-memory representation (a list of
 * named tables of typed cells) that every reader produces and every writer
 * consumes, plus the hard limits applied to hostile input.
 */
import { fmtN } from '../../core/structure/text';

/** A number whose text had trailing decimal zeros ("1.50"): keeps its display format in XLSX/ODS. */
export interface FmtNum {
  readonly n: number;
  readonly z: string;
}
export type Cell = string | number | boolean | null | FmtNum;

export interface Table {
  name: string;
  rows: Cell[][];
  /** Widest row. */
  cols: number;
}

export const LIMITS = {
  /** Largest accepted input file. */
  inputBytes: 200 * 1024 * 1024,
  /** Excel / LibreOffice row and column limits; XLSX and ODS output beyond this is rejected. */
  rows: 1_048_576,
  cols: 16_384,
  /** In-memory cell budget (rows x cols summed over sheets), so a hostile file cannot exhaust memory. */
  cells: 50_000_000,
  /** A single XLSX cell holds at most this many characters. */
  xlsxCellChars: 32_767,
  sheets: 256,
  /** ZIP containers (XLSX/ODS): real inflated bytes, counted while inflating. */
  zipTotalBytes: 1024 * 1024 * 1024,
  zipEntryBytes: 400 * 1024 * 1024,
  zipEntries: 2_000,
} as const;

export function cellText(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'number') return String(c);
  if (typeof c === 'boolean') return c ? 'TRUE' : 'FALSE';
  return String(c.n);
}

export function cellIsEmpty(c: Cell | undefined): boolean {
  return c === null || c === undefined || c === '';
}

export function tableIsEmpty(t: Table): boolean {
  for (const row of t.rows) for (const c of row) if (!cellIsEmpty(c)) return false;
  return true;
}

/** Plain value for JSON output. */
export function cellJson(c: Cell | undefined): string | number | boolean | null {
  if (c === undefined || c === null || c === '') return null;
  if (typeof c === 'object') return c.n;
  return c;
}

export function previewCell(c: Cell | undefined, max = 24): string {
  const s = c === undefined ? '' : cellText(c).replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function previewGrid(t: Table | undefined, rows = 12, cols = 8): string[][] {
  if (!t) return [];
  return t.rows.slice(0, rows).map((r) => r.slice(0, cols).map((c) => previewCell(c)));
}

/**
 * Infer a typed cell from CSV text. Conservative: only plain decimal numbers
 * with at most 15 significant digits become numbers, so "007", "+1", "1e3",
 * " 5" and 16+ digit IDs stay text. `keepFmt` retains trailing decimal zeros
 * ("1.50") as a number format so the display is unchanged.
 */
const NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;
export function inferCell(s: string, keepFmt: boolean): Cell {
  if (s === '') return null;
  const c = s.charCodeAt(0);
  const numeric = c === 45 || (c >= 48 && c <= 57);
  if (numeric) {
    if (!NUM.test(s)) return s;
    if (s.replace(/^-/, '').replace('.', '').replace(/^0+(?=\d)/, '').length > 15) return s;
    const n = Number(s);
    if (String(n) === s) return n;
    // Same value written with trailing zeros ("1.50", "2.0") or exponent-only JS form ("0.0000001").
    if (Object.is(n, -0) || !s.includes('.')) return s;
    return keepFmt ? { n, z: '0.' + '0'.repeat(s.length - s.indexOf('.') - 1) } : n;
  }
  if (c === 116 || c === 84) return s === 'true' || s === 'TRUE' || s === 'True' ? true : s;
  if (c === 102 || c === 70) return s === 'false' || s === 'FALSE' || s === 'False' ? false : s;
  return s;
}

export function assertCells(rows: number, cols: number, what: string) {
  if (rows * cols > LIMITS.cells) {
    throw new Error(
      `${what} is too large to convert in the browser (${fmtN(rows)} rows x ${fmtN(cols)} columns; the limit is ${fmtN(LIMITS.cells)} cells).`,
    );
  }
}
