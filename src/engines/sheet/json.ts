/**
 * JSON <-> tables.
 *
 * Accepted JSON shapes (the first match wins):
 *   [ {..}, {..} ]            records  -> one sheet, columns = union of keys in first-seen order
 *   [ [..], [..] ]            rows     -> one sheet, rows kept as they are
 *   [ 1, "a", ..mixed.. ]     values   -> one sheet with a "value" column
 *   { "A": [..], "B": [..] }  sheets   -> one sheet per key (every value must be an array)
 *   { ..a single record.. }   record   -> one sheet with one row
 *   scalar                    value    -> one sheet with one cell
 * A nested object/array inside a cell is stored as compact JSON text.
 */
import { type Cell, type Table, LIMITS, assertCells, cellJson, cellText, fmtInt } from './model';

type Json = unknown;
const isRecord = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toCell(v: Json): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

function arrayToTable(name: string, arr: Json[], onRows: (n: number) => void): Table {
  const BATCH = 2048;
  const n = arr.length;
  if (n === 0) return { name, rows: [], cols: 0 };

  let allRecords = true;
  let allRows = true;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (!isRecord(v)) allRecords = false;
    if (!Array.isArray(v)) allRows = false;
    if (!allRecords && !allRows) break;
  }

  if (allRecords) {
    const keys = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      for (const k of Object.keys(arr[i] as Record<string, Json>)) if (!keys.has(k)) keys.set(k, keys.size);
      if (keys.size > 1_000_000) break;
    }
    assertCells(n + 1, keys.size, 'The JSON data');
    const header = [...keys.keys()];
    const rows: Cell[][] = new Array(n + 1);
    rows[0] = header;
    for (let i = 0; i < n; i++) {
      const rec = arr[i] as Record<string, Json>;
      const row: Cell[] = new Array(header.length).fill(null);
      for (const k of Object.keys(rec)) row[keys.get(k)!] = toCell(rec[k]);
      rows[i + 1] = row;
      if ((i + 1) % BATCH === 0) onRows(BATCH);
    }
    onRows(n % BATCH);
    return { name, rows, cols: header.length };
  }

  if (allRows) {
    let cols = 0;
    for (let i = 0; i < n; i++) cols = Math.max(cols, (arr[i] as Json[]).length);
    assertCells(n, cols, 'The JSON data');
    const rows: Cell[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      rows[i] = (arr[i] as Json[]).map(toCell);
      if ((i + 1) % BATCH === 0) onRows(BATCH);
    }
    onRows(n % BATCH);
    return { name, rows, cols };
  }

  const rows: Cell[][] = new Array(n + 1);
  rows[0] = ['value'];
  for (let i = 0; i < n; i++) {
    rows[i + 1] = [toCell(arr[i])];
    if ((i + 1) % BATCH === 0) onRows(BATCH);
  }
  onRows(n % BATCH);
  return { name, rows, cols: 1 };
}

/** Total array elements to be flattened (for measured progress). */
export function jsonWorkUnits(value: Json): number {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) {
    const vals = Object.values(value);
    if (vals.length > 0 && vals.every(Array.isArray)) return vals.reduce((n, a) => n + (a as Json[]).length, 0);
  }
  return 1;
}

export function jsonToTables(value: Json, onRows: (n: number) => void): Table[] {
  let tables: Table[];
  if (Array.isArray(value)) {
    tables = [arrayToTable('Sheet1', value, onRows)];
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0 && entries.every(([, v]) => Array.isArray(v))) {
      if (entries.length > LIMITS.sheets) {
        throw new Error(`The JSON object has ${fmtInt(entries.length)} sheets (keys); at most ${LIMITS.sheets} are supported.`);
      }
      tables = entries.map(([name, v]) => arrayToTable(name, v as Json[], onRows));
    } else {
      tables = [arrayToTable('Sheet1', [value], onRows)];
    }
  } else {
    tables = [{ name: 'Sheet1', rows: [['value'], [toCell(value)]], cols: 1 }];
    onRows(1);
  }
  if (tables.every((t) => t.rows.length === 0)) throw new Error('The JSON contains no rows to convert.');
  return tables;
}

/* ------------------------------------------------------------------ output */

/** Column names from a header row: empty -> "Column N", duplicates -> "name_2". */
export function headerNames(first: readonly Cell[] | undefined, width: number): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    let base = first && i < first.length ? cellText(first[i]!).trim() : '';
    if (!base) base = `Column ${i + 1}`;
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base}_${k}`;
    used.add(name);
    out.push(name);
  }
  return out;
}

const J = (v: unknown) => JSON.stringify(v);

/** One table as a JSON array text, one row per line. `indent` is the nesting prefix. */
function tableJsonParts(t: Table, header: boolean, indent: string, onRows: (n: number) => void): string[] {
  const parts: string[] = [];
  const rows = t.rows;
  const body = header ? rows.slice(1) : rows;
  if (body.length === 0 && (!header || rows.length <= 1)) {
    onRows(rows.length);
    return ['[]'];
  }
  const keys = header ? headerNames(rows[0], t.cols).map((k) => J(k)) : [];
  const inner = indent + '  ';
  parts.push('[\n');
  const BATCH = 2048;
  let pending = header ? 1 : 0;
  for (let i = 0; i < body.length; i++) {
    const row = body[i]!;
    let line: string;
    if (header) {
      const fields: string[] = new Array(keys.length);
      for (let c = 0; c < keys.length; c++) fields[c] = `${keys[c]}:${J(cellJson(row[c]))}`;
      line = `{${fields.join(',')}}`;
    } else {
      const items: string[] = new Array(Math.max(row.length, t.cols));
      for (let c = 0; c < items.length; c++) items[c] = J(cellJson(row[c]));
      line = `[${items.join(',')}]`;
    }
    parts.push(inner + line + (i < body.length - 1 ? ',\n' : '\n'));
    if (++pending >= BATCH) {
      onRows(pending);
      pending = 0;
    }
  }
  if (pending) onRows(pending);
  parts.push(indent + ']');
  return parts;
}

/** Tables -> JSON text parts. One table: a bare array; several: an object keyed by sheet name. */
export function tablesToJsonParts(tables: Table[], header: boolean, onRows: (n: number) => void): string[] {
  if (tables.length === 1) return [...tableJsonParts(tables[0]!, header, '', onRows), '\n'];
  const parts: string[] = ['{\n'];
  tables.forEach((t, i) => {
    parts.push(`  ${J(t.name)}: `, ...tableJsonParts(t, header, '  ', onRows), i < tables.length - 1 ? ',\n' : '\n');
  });
  parts.push('}\n');
  return parts;
}
