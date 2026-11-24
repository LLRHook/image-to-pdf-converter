/**
 * Sheet engine: xlsx / xls / ods / csv / tsv / json -> xlsx / ods / csv / tsv / json.
 *
 * Runs inside the worker host. Pipeline per job (stages match edges.ts):
 *   read -> decode -> [transform] -> encode -> [package]
 *
 * Options (all optional): `bom` ('auto' | true | false, CSV only), `escapeFormulae`
 * (true prefixes CSV/TSV text that starts with = + - @ with an apostrophe),
 * `header` (false: JSON output is an array of arrays instead of row objects).
 */
import { zipSync } from 'fflate';
import { formatInfo, type FormatId } from '../../core/formats';
import type { ConvertRequest, ConvertResult, Engine, EngineContext } from '../../core/types';
import { DELIM, parseDelimited, serializeDelimited } from './csv';
import { decodeText, readBlob } from './io';
import { jsonToTables, jsonWorkUnits, tablesToJsonParts } from './json';
import {
  type Cell,
  type Table,
  LIMITS,
  fmtInt,
  inferCell,
  previewGrid,
  tableIsEmpty,
} from './model';
import {
  type WbSource,
  checkTableFits,
  prepareForOds,
  readWorkbook,
  sheetToTable,
  tablesToWorkbook,
  writeWorkbook,
} from './workbook';

type Kind = 'book' | 'text' | 'json';
const kindOf = (f: FormatId): Kind => (f === 'csv' || f === 'tsv' ? 'text' : f === 'json' ? 'json' : 'book');

interface Opts {
  bom: 'auto' | boolean;
  escapeFormulae: boolean;
  header: boolean;
}
function parseOptions(o: Readonly<Record<string, unknown>>): Opts {
  return {
    bom: o.bom === true || o.bom === false ? o.bom : 'auto',
    escapeFormulae: o.escapeFormulae === true,
    header: o.header !== false,
  };
}

/** Progress helper: `step(n)` adds n finished units out of `total`. */
function counter(ctx: EngineContext, total: number) {
  let done = 0;
  const denom = Math.max(1, total);
  return (n: number) => {
    done += n;
    ctx.progress(Math.min(1, done / denom));
  };
}

const safeFileName = (name: string, used: Set<string>, ext: string, index: number): string => {
  let base = name
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  if (!base) base = `Sheet${index + 1}`;
  let file = `${base}.${ext}`;
  for (let i = 2; used.has(file.toLowerCase()); i++) file = `${base} (${i}).${ext}`;
  used.add(file.toLowerCase());
  return file;
};

function setFactsAndPreview(ctx: EngineContext, tables: Table[], sheets = tables.length) {
  const rows = tables.reduce((n, t) => n + t.rows.length, 0);
  const cols = tables.reduce((n, t) => Math.max(n, t.cols), 0);
  ctx.facts({ kind: 'table', sheets, rows, cols });
  const first = tables.find((t) => t.rows.length > 0) ?? tables[0];
  ctx.preview({ kind: 'grid', rows: previewGrid(first) });
}

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  const { from, to } = req;
  const fromKind = kindOf(from);
  const toBook = to === 'xlsx' || to === 'ods';
  const opts = parseOptions(req.options);

  if (req.input.size === 0) throw new Error('The file is empty.');
  if (req.input.size > LIMITS.inputBytes) {
    throw new Error(
      `The file is ${fmtInt(Math.round(req.input.size / 1048576))} MB; the limit for converting in the browser is ${LIMITS.inputBytes / 1048576} MB.`,
    );
  }

  try {
    return await run(req, ctx, from, to, fromKind, toBook, opts);
  } catch (e) {
    if (e instanceof RangeError && /call stack/i.test(e.message)) {
      throw new Error('The data is nested too deeply to convert.');
    }
    if (e instanceof RangeError && /string length|array length|allocation/i.test(e.message)) {
      throw new Error('The result is too large for the browser to build in memory (spreadsheet formats are written as one piece). Try a smaller file, or CSV/JSON.');
    }
    throw e;
  }
}

async function run(
  req: ConvertRequest,
  ctx: EngineContext,
  from: FormatId,
  to: FormatId,
  fromKind: Kind,
  toBook: boolean,
  opts: Opts,
): Promise<ConvertResult> {
  /* ---- read ---- */
  ctx.stage('read');
  const bytes = await readBlob(req.input, ctx);

  /* ---- decode ---- */
  ctx.stage('decode');
  let book: WbSource | null = null;
  let tables: Table[] = [];
  let json: unknown;

  if (fromKind === 'book') {
    book = readWorkbook(bytes, from as 'xlsx' | 'xls' | 'ods', toBook);
    if (!toBook && !book.sheets.some((s) => s.nonEmpty)) throw new Error('The workbook has no data to convert.');
    const dataRows = book.sheets.reduce((n, s) => n + s.dataRows, 0);
    const dataCols = book.sheets.reduce((n, s) => Math.max(n, s.dataCols), 0);
    ctx.facts({ kind: 'table', sheets: book.sheets.length, rows: dataRows, cols: dataCols });
    const first = book.sheets.find((s) => s.nonEmpty) ?? book.sheets[0]!;
    const head: Table = sheetToTable({ ...first, dataRows: Math.min(first.dataRows, 12) }, book.date1904, () => {});
    ctx.preview({ kind: 'grid', rows: previewGrid(head) });
    if (book.formulaWithoutValue > 0) {
      ctx.log(`${fmtInt(book.formulaWithoutValue)} formula cell(s) have no saved result in the file, so they have no value.`);
    }
  } else if (fromKind === 'text') {
    const { text, encoding } = decodeText(bytes);
    if (encoding === 'Windows-1252') ctx.log('The file is not valid UTF-8; read as Windows-1252.');
    const parsed = parseDelimited(text, from as 'csv' | 'tsv', (f) => ctx.progress(f), {
      rows: toBook ? LIMITS.rows : undefined,
      target: to === 'xlsx' ? 'XLSX' : 'ODS',
    });
    tables = [{ name: 'Sheet1', rows: parsed.rows as Cell[][], cols: parsed.cols }];
    if (toBook) checkTableFits(tables[0]!, to as 'xlsx' | 'ods');
    setFactsAndPreview(ctx, tables);
  } else {
    const { text } = decodeText(bytes);
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`This is not valid JSON: ${(e as Error).message}`);
    }
  }

  /* ---- transform ---- */
  if (fromKind === 'book' && !toBook) {
    ctx.stage('transform');
    const live = book!.sheets.filter((s) => s.nonEmpty);
    const step = counter(ctx, live.reduce((n, s) => n + s.dataRows, 0));
    tables = live.map((s) => sheetToTable(s, book!.date1904, step));
  } else if (fromKind === 'text' && (toBook || to === 'json')) {
    ctx.stage('transform');
    const t = tables[0]!;
    const step = counter(ctx, t.rows.length);
    for (let i = 0; i < t.rows.length; i++) {
      const src = t.rows[i] as unknown as string[];
      const row: Cell[] = new Array(src.length);
      for (let c = 0; c < src.length; c++) row[c] = inferCell(src[c]!, toBook);
      t.rows[i] = row;
      if ((i & 2047) === 2047) step(2048);
    }
    step(t.rows.length & 2047);
  } else if (fromKind === 'json') {
    ctx.stage('transform');
    const step = counter(ctx, jsonWorkUnits(json));
    tables = jsonToTables(json, step);
    json = undefined;
    if (toBook) for (const t of tables) checkTableFits(t, to as 'xlsx' | 'ods');
    setFactsAndPreview(ctx, tables);
  }

  /* ---- encode (+ package) ---- */
  ctx.stage('encode');
  const info = formatInfo(to);

  if (toBook) {
    if (book) prepareForOdsIf(book, to);
    const wb = book ? book.wb : tablesToWorkbook(tables, to as 'xlsx' | 'ods', () => {});
    const out = writeWorkbook(wb, to as 'xlsx' | 'ods');
    return { output: out, ext: info.exts[0]!, mime: info.mime };
  }

  if (to === 'json') {
    const live = tables.filter((t) => t.rows.length > 0 || tables.length === 1);
    const step = counter(ctx, live.reduce((n, t) => n + t.rows.length, 0));
    const parts = tablesToJsonParts(live.length ? live : tables, opts.header, step);
    return { output: new Blob(parts, { type: info.mime }), ext: 'json', mime: info.mime };
  }

  // csv / tsv
  const delimiter = DELIM[to as 'csv' | 'tsv'];
  const newline = to === 'csv' ? '\r\n' : '\n';
  const live = fromKind === 'text' ? tables : tables.filter((t) => !tableIsEmpty(t));
  if (live.length === 0) throw new Error('There is no data to convert.');
  const step = counter(ctx, live.reduce((n, t) => n + t.rows.length, 0));
  const rendered = live.map((t) => serializeDelimited(t, delimiter, newline, opts.escapeFormulae, step));
  const wantBom = to === 'csv' && (opts.bom === true || (opts.bom === 'auto' && rendered.some((parts) => parts.some(hasNonAscii))));

  if (fromKind !== 'text') ctx.stage('package');
  if (live.length === 1) {
    const parts = rendered[0]!;
    return { output: new Blob(wantBom ? ['﻿', ...parts] : parts, { type: info.mime }), ext: info.exts[0]!, mime: info.mime };
  }
  const enc = new TextEncoder();
  const used = new Set<string>();
  const files: Record<string, Uint8Array> = {};
  live.forEach((t, i) => {
    const text = (wantBom ? '﻿' : '') + rendered[i]!.join('');
    files[safeFileName(t.name, used, info.exts[0]!, i)] = enc.encode(text);
  });
  const zip = zipSync(files, { level: 6 });
  return { output: zip, ext: 'zip', mime: 'application/zip', bundle: { count: live.length, ext: info.exts[0]! } };
}

function prepareForOdsIf(book: WbSource, to: FormatId) {
  if (to === 'ods') prepareForOds(book);
}

function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return true;
  return false;
}

export default { convert } satisfies Engine;
