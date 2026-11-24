/**
 * SheetJS bridge: read XLSX/XLS/ODS safely into dense worksheets, turn them
 * into plain tables, and write tables or worksheets back out as XLSX/ODS.
 *
 * Dates are never converted through JS Date objects (that makes results depend
 * on the viewer's time zone): numeric cells with a date number format are
 * formatted straight from the serial number.
 */
import * as XLSX from 'xlsx';
import { fmtN } from '../../core/structure/text';
import { checkOdsRepeats, isCfb, isZip, scanZip } from './guard';
import { type Cell, type FmtNum, type Table, LIMITS, assertCells } from './model';

type Ws = XLSX.WorkSheet & { '!data'?: (XLSX.CellObject | undefined)[][] };

export interface SheetInfo {
  name: string;
  ws: Ws;
  /** Extent of cells that exist (what a pass-through write must cover). */
  rows: number;
  cols: number;
  /** Extent of cells that hold a value (what text outputs use). */
  dataRows: number;
  dataCols: number;
  nonEmpty: boolean;
}

export interface WbSource {
  wb: XLSX.WorkBook;
  sheets: SheetInfo[];
  date1904: boolean;
  formulaWithoutValue: number;
}

const ERR: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

export const WB_LABEL = { xlsx: 'XLSX', xls: 'XLS', ods: 'ODS' } as const;

function friendly(e: unknown, label: string): Error {
  const m = e instanceof Error ? e.message : String(e);
  if (/password|encrypt/i.test(m)) return new Error(`This ${label} file is password-protected. Remove the password and try again.`);
  if (/Cancelled/.test(m)) return e as Error;
  return new Error(`Could not read this file as ${label}: ${m}`);
}

export function readWorkbook(bytes: Uint8Array, from: 'xlsx' | 'xls' | 'ods', keepFormulas: boolean): WbSource {
  const label = WB_LABEL[from];
  if (isZip(bytes)) {
    const scan = scanZip(bytes, { wantContentXml: true });
    if (scan.contentXml) checkOdsRepeats(scan.contentXml);
  } else if (!isCfb(bytes) && from !== 'xls') {
    throw new Error(`This does not look like an ${label} file (it is not a ZIP container). Check the file type.`);
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, {
      type: 'array',
      dense: true,
      cellNF: true,
      cellText: false,
      cellHTML: false,
      cellFormula: keepFormulas,
      cellDates: false,
      sheetRows: LIMITS.rows + 1,
    });
  } catch (e) {
    throw friendly(e, label);
  }
  if (wb.SheetNames.length > LIMITS.sheets) {
    throw new Error(`The workbook has ${fmtN(wb.SheetNames.length)} sheets; at most ${LIMITS.sheets} are supported.`);
  }

  const sheets: SheetInfo[] = [];
  let formulaWithoutValue = 0;
  let cellBudget = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name] as Ws | undefined;
    if (!ws || ws['!type'] === 'chart') continue;
    const data = ws['!data'] ?? (ws['!data'] = []);
    let rows = 0;
    let cols = 0;
    let dataRows = 0;
    let dataCols = 0;
    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      if (!row) continue;
      let any = false;
      let last = -1;
      let lastData = -1;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!cell) continue;
        any = true;
        last = c;
        if (cell.t === 'z') continue;
        if (cell.v === undefined || cell.v === null || cell.v === '') {
          if (cell.f) formulaWithoutValue++;
          continue;
        }
        lastData = c;
      }
      if (any) {
        rows = r + 1;
        if (last + 1 > cols) cols = last + 1;
      }
      if (lastData >= 0) {
        dataRows = r + 1;
        if (lastData + 1 > dataCols) dataCols = lastData + 1;
      }
    }
    if (rows > LIMITS.rows) {
      throw new Error(`Sheet "${name}" has more than ${fmtN(LIMITS.rows)} rows, which is more than this converter handles.`);
    }
    if (cols > LIMITS.cols) {
      throw new Error(`Sheet "${name}" has ${fmtN(cols)} columns; at most ${fmtN(LIMITS.cols)} are supported.`);
    }
    cellBudget += dataRows * dataCols;
    assertCells(1, cellBudget, 'The workbook');
    // A hostile file can declare a huge range; replace it with the real extent.
    ws['!ref'] = rows > 0 && cols > 0 ? XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows - 1, c: cols - 1 } }) : undefined;
    sheets.push({ name, ws, rows, cols, dataRows, dataCols, nonEmpty: dataRows > 0 });
  }
  if (sheets.length === 0) throw new Error('The workbook has no sheets.');
  return { wb, sheets, date1904: !!wb.Workbook?.WBProps?.date1904, formulaWithoutValue };
}

/* -------------------------------------------------------------- cell values */

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function isoFromSerial(v: number, z: string, date1904: boolean): string | null {
  const stripped = z.replace(/"[^"]*"|\\.|\[(?![hms]+\])[^\]]*\]/gi, '');
  if (/\[(?:h+|m+|s+)\]/i.test(z)) {
    // Elapsed-time format ([h]:mm:ss): a duration, not a point in time.
    const total = Math.round(v * 86400);
    const sign = total < 0 ? '-' : '';
    const t = Math.abs(total);
    return `${sign}${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
  }
  const d = XLSX.SSF.parse_date_code(v, { date1904 });
  if (!d) return null;
  const hasTime = /[hs]|AM\/PM|A\/P/i.test(stripped);
  const hasDate = /[yd]/i.test(stripped) || (/m/i.test(stripped) && !/[hs]/i.test(stripped));
  const time = `${pad(d.H)}:${pad(d.M)}:${pad(d.S)}`;
  if (!hasDate && v < 1) return time;
  if (d.d < 1) return null;
  const date = `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;
  return hasTime || (!hasDate && v >= 1) ? `${date}T${time}` : date;
}

export function cellValue(c: XLSX.CellObject | undefined, date1904: boolean): Cell {
  if (!c) return null;
  switch (c.t) {
    case 'n': {
      const v = c.v as number | undefined;
      if (v === undefined || v === null) return null;
      if (typeof c.z === 'string' && c.z !== 'General' && XLSX.SSF.is_date(c.z)) {
        const iso = isoFromSerial(v, c.z, date1904);
        if (iso !== null) return iso;
      }
      return v;
    }
    case 's':
      return c.v === undefined || c.v === null ? null : String(c.v);
    case 'b':
      return c.v === undefined || c.v === null ? null : !!c.v;
    case 'e':
      return typeof c.v === 'number' ? (ERR[c.v] ?? '#ERROR!') : c.v === undefined ? null : String(c.v);
    case 'd': {
      const v = c.v as unknown;
      if (v instanceof Date) return v.toISOString().replace(/\.000Z$/, '').replace(/T00:00:00$/, '');
      return v === undefined || v === null ? null : String(v);
    }
    default:
      return null;
  }
}

/** Sheet -> table of plain values over its data extent. `onRows` reports rows done. */
export function sheetToTable(info: SheetInfo, date1904: boolean, onRows: (n: number) => void): Table {
  const data = info.ws['!data'] ?? [];
  const rows: Cell[][] = new Array(info.dataRows);
  const BATCH = 2048;
  let pending = 0;
  for (let r = 0; r < info.dataRows; r++) {
    const out: Cell[] = new Array(info.dataCols).fill(null);
    const src = data[r];
    if (src) {
      const n = Math.min(src.length, info.dataCols);
      for (let c = 0; c < n; c++) {
        const cell = src[c];
        if (cell) out[c] = cellValue(cell, date1904);
      }
    }
    rows[r] = out;
    if (++pending === BATCH) {
      onRows(pending);
      pending = 0;
    }
  }
  if (pending) onRows(pending);
  return { name: info.name, rows, cols: info.dataCols };
}

/* ---------------------------------------------------------------- writing */

const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;

/** Excel sheet names: 1-31 chars, none of \ / ? * [ ] :, no leading/trailing apostrophe, unique ignoring case. */
export function safeSheetName(raw: string, used: Set<string>, index: number): string {
  let n = raw.replace(INVALID_SHEET_CHARS, '_').replace(/[\u0000-\u001f]/g, '').trim().replace(/^'+|'+$/g, '');
  if (!n) n = `Sheet${index + 1}`;
  n = n.slice(0, 31);
  let candidate = n;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    candidate = n.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

const colName = (c: number) => XLSX.utils.encode_col(c);

export function checkTableFits(t: Table, target: 'xlsx' | 'ods') {
  const label = target === 'xlsx' ? 'XLSX' : 'ODS';
  if (t.rows.length > LIMITS.rows) {
    throw new Error(
      `Sheet "${t.name}" has ${fmtN(t.rows.length)} rows; ${label} holds at most ${fmtN(LIMITS.rows)}. Nothing was cut off: split the data or choose CSV/JSON.`,
    );
  }
  if (t.cols > LIMITS.cols) {
    throw new Error(
      `Sheet "${t.name}" has ${fmtN(t.cols)} columns; ${label} holds at most ${fmtN(LIMITS.cols)} (column XFD). Nothing was cut off: split the data or choose JSON.`,
    );
  }
}

/** Typed table -> dense worksheet. Strings are always `t:'s'` cells: nothing becomes a formula. */
export function tableToWorksheet(t: Table, target: 'xlsx' | 'ods', onRows: (n: number) => void): Ws {
  checkTableFits(t, target);
  const data: (XLSX.CellObject | undefined)[][] = new Array(t.rows.length);
  const widths: number[] = new Array(t.cols).fill(0);
  const BATCH = 2048;
  let pending = 0;
  for (let r = 0; r < t.rows.length; r++) {
    const src = t.rows[r]!;
    const out: (XLSX.CellObject | undefined)[] = new Array(src.length);
    for (let c = 0; c < src.length; c++) {
      const v = src[c];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'string') {
        if (target === 'xlsx' && v.length > LIMITS.xlsxCellChars) {
          throw new Error(
            `Cell ${colName(c)}${r + 1} in "${t.name}" has ${fmtN(v.length)} characters; XLSX cells hold at most ${fmtN(LIMITS.xlsxCellChars)}. Nothing was cut off: choose ODS, CSV or JSON instead.`,
          );
        }
        out[c] = { t: 's', v };
        if (r < 500 && v.length > widths[c]!) widths[c] = v.length;
      } else if (typeof v === 'number') {
        out[c] = Number.isFinite(v) ? { t: 'n', v } : { t: 's', v: String(v) };
      } else if (typeof v === 'boolean') {
        out[c] = { t: 'b', v };
      } else {
        const f: FmtNum = v;
        out[c] = { t: 'n', v: f.n, z: f.z };
      }
    }
    data[r] = out;
    if (++pending === BATCH) {
      onRows(pending);
      pending = 0;
    }
  }
  if (pending) onRows(pending);
  const ws = { '!data': data } as unknown as Ws;
  if (t.rows.length > 0 && t.cols > 0) {
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: t.rows.length - 1, c: t.cols - 1 } });
    ws['!cols'] = widths.map((w) => ({ wch: Math.min(60, Math.max(8, w + 2)) }));
  }
  return ws;
}

export function tablesToWorkbook(tables: Table[], target: 'xlsx' | 'ods', onRows: (n: number) => void): XLSX.WorkBook {
  if (tables.length > LIMITS.sheets) throw new Error(`There are ${fmtN(tables.length)} sheets; at most ${LIMITS.sheets} are supported.`);
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  tables.forEach((t, i) => {
    const name = safeSheetName(t.name, used, i);
    XLSX.utils.book_append_sheet(wb, tableToWorksheet(t, target, onRows) as XLSX.WorkSheet, name);
  });
  return wb;
}

/* ODS: SheetJS CE's ODS writer drops unquoted date separators ("yyyy-mm-dd" loses its dashes). */
const odsFormats = new Map<string, string>();
export function odsSafeDateFormat(z: string): string {
  const cached = odsFormats.get(z);
  if (cached !== undefined) return cached;
  let s = z.split(';')[0]!.replace(/\[\$[^\]]*\]/g, '').replace(/\[(?:red|green|blue|black|white|cyan|magenta|yellow|color\d+)\]/gi, '');
  let o = '';
  let frac = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      const stop = end < 0 ? s.length : end;
      o += s.slice(i, stop + 1);
      i = stop;
      frac = false;
    } else if (ch === '\\') {
      o += ch + (s[i + 1] ?? '');
      i++;
      frac = false;
    } else if (/[A-Za-z]/.test(ch)) {
      o += ch.toLowerCase();
      frac = false;
    } else if (ch === '/' || ch === ':' || ch === '[' || ch === ']') {
      o += ch;
      frac = false;
    } else if (ch === '.' && o.endsWith('s') && s[i + 1] === '0') {
      o += ch;
      frac = true;
    } else if (ch === '0' && frac) {
      o += ch;
    } else {
      o += `"${ch}"`;
      frac = false;
    }
  }
  s = o;
  odsFormats.set(z, s);
  return s;
}

/** Make a SheetJS-read workbook safe for the ODS writer (date formats, error cells). */
export function prepareForOds(src: WbSource): void {
  for (const sh of src.sheets) {
    for (const row of sh.ws['!data'] ?? []) {
      if (!row) continue;
      for (const cell of row) {
        if (!cell) continue;
        if (cell.t === 'n' && typeof cell.z === 'string' && cell.z !== 'General' && XLSX.SSF.is_date(cell.z)) {
          cell.z = odsSafeDateFormat(cell.z);
        } else if (cell.t === 'e') {
          // The ODS writer would drop error cells entirely; keep the error text instead.
          const v = cell.v;
          delete cell.f;
          cell.t = 's';
          cell.v = typeof v === 'number' ? (ERR[v] ?? '#ERROR!') : String(v ?? '#ERROR!');
        }
      }
    }
  }
}

export function writeWorkbook(wb: XLSX.WorkBook, bookType: 'xlsx' | 'ods'): Uint8Array {
  const out = XLSX.write(wb, { bookType, type: 'array', compression: true, bookSST: bookType === 'xlsx' }) as ArrayBuffer | Uint8Array;
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

