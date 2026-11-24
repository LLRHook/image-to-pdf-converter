import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { runEngine, testContext } from '../../core/testing';
import type { FormatId } from '../../core/formats';
import { expandEdges } from '../../core/graph';
import { edges, stagesFor } from './edges';
import engine from './engine';
import { scanZip } from './guard';
import { inferCell, LIMITS } from './model';

/* ------------------------------------------------------------------ helpers */

async function run(from: FormatId, to: FormatId, input: Uint8Array | string, options: Record<string, unknown> = {}) {
  const { result, ctx, bytes } = await runEngine(engine, { input, name: `input.${from}`, from, to, options });
  return { result, ctx, bytes, text: () => new TextDecoder().decode(bytes) };
}

const readWb = (bytes: Uint8Array) => XLSX.read(bytes, { type: 'array', dense: true, cellNF: true, cellFormula: true });
const dense = (wb: XLSX.WorkBook, name: string) => (wb.Sheets[name] as any)['!data'] as XLSX.CellObject[][];

function makeWb(bookType: 'xlsx' | 'xls' | 'ods', sheets: Record<string, XLSX.WorkSheet | unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, s] of Object.entries(sheets)) {
    const ws = Array.isArray(s) ? XLSX.utils.aoa_to_sheet(s) : (s as XLSX.WorkSheet);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const out = XLSX.write(wb, { bookType, type: 'array', compression: true }) as ArrayBuffer;
  return new Uint8Array(out);
}

/** A sheet with a real date serial (2024-01-15 12:30:00), a time, a boolean, a formula with cached value and an error. */
function typedSheet(): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([['name', 'when', 'day', 'at', 'ok', 'calc', 'err', 'pct']], { dense: true });
  (ws as any)['!data'].push([
    { t: 's', v: 'Ann' },
    { t: 'n', v: 45306.5208333333, z: 'yyyy-mm-dd hh:mm:ss' },
    { t: 'n', v: 45306, z: 'yyyy-mm-dd' },
    { t: 'n', v: 0.25, z: 'h:mm:ss' },
    { t: 'b', v: true },
    { t: 'n', v: 4, f: 'A2*2' },
    { t: 'e', v: 0x07 },
    { t: 'n', v: 0.25, z: '0%' },
  ]);
  ws['!ref'] = 'A1:H2';
  return ws;
}

const EXPECT_TYPED_ROW = ['Ann', '2024-01-15T12:30:00', '2024-01-15', '06:00:00', 'TRUE', '4', '#DIV/0!', '0.25'];

/* --------------------------------------------------------------- inference */

describe('inferCell', () => {
  it('keeps risky text as text and converts only canonical numbers/booleans', () => {
    expect(inferCell('42', false)).toBe(42);
    expect(inferCell('-3.5', false)).toBe(-3.5);
    expect(inferCell('007', false)).toBe('007');
    expect(inferCell('+1', false)).toBe('+1');
    expect(inferCell('1e3', false)).toBe('1e3');
    expect(inferCell(' 5', false)).toBe(' 5');
    expect(inferCell('4111111111111111', false)).toBe('4111111111111111'); // 16 digits: would show as 4.11E+15
    expect(inferCell('123456789012345', false)).toBe(123456789012345);
    expect(inferCell('-0', false)).toBe('-0');
    expect(inferCell('=1+1', true)).toBe('=1+1');
    expect(inferCell('true', false)).toBe(true);
    expect(inferCell('FALSE', false)).toBe(false);
    expect(inferCell('truthy', false)).toBe('truthy');
    expect(inferCell('', false)).toBeNull();
  });
  it('keeps trailing decimal zeros as a number format only when asked', () => {
    expect(inferCell('1.50', true)).toEqual({ n: 1.5, z: '0.00' });
    expect(inferCell('1.50', false)).toBe(1.5);
    expect(inferCell('2.0', true)).toEqual({ n: 2, z: '0.0' });
    expect(inferCell('3.14', true)).toBe(3.14);
  });
});

/* ------------------------------------------------------- CSV / TSV -> sheets */

describe('csv -> xlsx / ods', () => {
  const csv = 'id,name,price,flag,zip,formula,note\n1,Ann,1.50,true,007,=1+1,"line1\nline2"\n2,"Bob, Jr.",2,FALSE,01234,"=HYPERLINK(""http://x"")",\n';

  for (const to of ['xlsx', 'ods'] as const) {
    it(`types cells and never creates formulas (${to})`, async () => {
      const { bytes, result, ctx } = await run('csv', to, csv);
      expect(result.ext).toBe(to);
      expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]); // PK
      const wb = readWb(bytes);
      expect(wb.SheetNames).toEqual(['Sheet1']);
      const d = dense(wb, 'Sheet1');
      expect(d[0]!.map((c) => c.v)).toEqual(['id', 'name', 'price', 'flag', 'zip', 'formula', 'note']);
      expect(d[1]![0]).toMatchObject({ t: 'n', v: 1 });
      expect(d[1]![2]).toMatchObject({ t: 'n', v: 1.5 });
      expect(d[1]![3]).toMatchObject({ t: 'b', v: true });
      expect(d[1]![4]).toMatchObject({ t: 's', v: '007' });
      expect(d[1]![5]).toMatchObject({ t: 's', v: '=1+1' });
      expect(d[1]![5]!.f).toBeUndefined();
      expect(d[1]![6]!.v).toBe('line1\nline2');
      expect(d[2]![1]!.v).toBe('Bob, Jr.');
      expect(d[2]![3]).toMatchObject({ t: 'b', v: false });
      expect(d[2]![4]).toMatchObject({ t: 's', v: '01234' });
      expect(d[2]![5]).toMatchObject({ t: 's' });
      expect(String(d[2]![5]!.v)).toBe('=HYPERLINK("http://x")');
      expect(d[2]![5]!.f).toBeUndefined();
      expect(d[2]![6]).toBeUndefined();
      // trailing zeros keep their display
      expect(String(d[1]![2]!.z)).toMatch(/0\.00/);
      expect(ctx.stages).toEqual(['read', 'decode', 'transform', 'encode']);
    });
  }

  it('stores "=1+1" as a string cell in the XLSX XML (no <f> element)', async () => {
    const { bytes } = await run('csv', 'xlsx', 'a\n=1+1\n=cmd|\' /C calc\'!A0\n');
    const parts = unzipSync(bytes);
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']!);
    expect(sheet).not.toContain('<f>');
    expect(sheet).not.toContain('<f ');
    expect(sheet).toContain('t="s"');
    expect(strFromU8(parts['xl/sharedStrings.xml']!)).toContain('=1+1');
  });

  it('detects semicolon and tab delimiters, strips a BOM, keeps quoted delimiters', async () => {
    const semi = '﻿a;b;c\n1;"x;y";3\n';
    const { text } = await run('csv', 'json', strToU8(semi));
    expect(JSON.parse(text())).toEqual([{ a: 1, b: 'x;y', c: 3 }]);
    const tab = 'a\tb\n1\t2\n';
    expect(JSON.parse((await run('csv', 'json', tab)).text())).toEqual([{ a: 1, b: 2 }]);
  });

  it('reads Windows-1252 text that is not valid UTF-8', async () => {
    const bytes = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a]); // "name\ncafé"
    const { text, ctx } = await run('csv', 'json', bytes);
    expect(JSON.parse(text())).toEqual([{ name: 'café' }]);
    expect(ctx.logs.join(' ')).toMatch(/Windows-1252/);
  });

  it('decodes UTF-16LE with a BOM', async () => {
    const u16 = new Uint8Array([0xff, 0xfe, ...[...'a,b\n1,é\n'].flatMap((ch) => [ch.charCodeAt(0) & 255, ch.charCodeAt(0) >> 8])]);
    expect(JSON.parse((await run('csv', 'json', u16)).text())).toEqual([{ a: 1, b: 'é' }]);
  });

  it('reports facts, a 12x8 / 24-char preview and measured progress', async () => {
    const rows = ['c1,c2,c3,c4,c5,c6,c7,c8,c9,c10'];
    for (let i = 0; i < 30; i++) rows.push(Array.from({ length: 10 }, (_, c) => (c === 0 ? 'x'.repeat(40) : `${i}-${c}`)).join(','));
    const { ctx } = await run('csv', 'xlsx', rows.join('\n'));
    expect(ctx.factsSeen[0]).toEqual({ kind: 'table', sheets: 1, rows: 31, cols: 10 });
    const p = ctx.previews[0]!;
    expect(p.kind).toBe('grid');
    if (p.kind === 'grid') {
      expect(p.rows).toHaveLength(12);
      expect(p.rows.every((r) => r.length === 8)).toBe(true);
      expect(Math.max(...p.rows.flat().map((c) => c.length))).toBeLessThanOrEqual(24);
      expect(p.rows[1]![0]!.endsWith('…')).toBe(true);
    }
    expect(ctx.progressValues.length).toBeGreaterThan(0);
    expect(ctx.progressValues.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('header-only and single-column files convert; a file with no rows is rejected', async () => {
    expect(JSON.parse((await run('csv', 'json', 'a,b\n')).text())).toEqual([]);
    expect(dense(readWb((await run('csv', 'xlsx', 'a,b\n')).bytes), 'Sheet1')[0]!.map((c) => c.v)).toEqual(['a', 'b']);
    expect(JSON.parse((await run('csv', 'json', 'only\nx\n\ny\n')).text())).toEqual([{ only: 'x' }, { only: 'y' }]);
    await expect(run('csv', 'json', '\n\n')).rejects.toThrow(/no rows/);
  });

  it('tsv -> xlsx parses tabs only', async () => {
    const { bytes } = await run('tsv', 'xlsx', 'a,b\tc\n1,2\t3\n');
    const d = dense(readWb(bytes), 'Sheet1');
    expect(d[0]!.map((c) => c.v)).toEqual(['a,b', 'c']);
    expect(d[1]![0]).toMatchObject({ t: 's', v: '1,2' });
    expect(d[1]![1]).toMatchObject({ t: 'n', v: 3 });
  });
});

describe('csv <-> tsv', () => {
  it('converts delimiters, keeping quoting and values verbatim (no type inference)', async () => {
    const csv = 'a,b,c\n007,"x,y","say ""hi"""\n1.50,"two\nlines",\n';
    const tsv = (await run('csv', 'tsv', csv)).text();
    expect(tsv).toBe('a\tb\tc\n007\tx,y\t"say ""hi"""\n1.50\t"two\nlines"\t\n');
    const back = (await run('tsv', 'csv', tsv)).text();
    expect(back).toBe('a,b,c\r\n007,"x,y","say ""hi"""\r\n1.50,"two\nlines",\r\n');
  });
});

/* ---------------------------------------------------- workbook -> csv / json */

describe('workbook -> csv / tsv', () => {
  const bookTypes = ['xlsx', 'ods', 'xls'] as const;
  for (const bt of bookTypes) {
    it(`single sheet ${bt} -> csv keeps types and writes dates as ISO text`, async () => {
      const bytes = makeWb(bt, { Data: typedSheet() });
      const { text, result, ctx } = await run(bt, 'csv', bytes);
      expect(result.ext).toBe('csv');
      expect(result.bundle).toBeUndefined();
      const lines = text().trimEnd().split('\r\n');
      expect(lines[0]).toBe('name,when,day,at,ok,calc,err,pct');
      // SheetJS CE cannot write error cells to ODS, so that fixture has an empty cell there.
      expect(lines[1]!.split(',')).toEqual(bt === 'ods' ? EXPECT_TYPED_ROW.map((v) => (v === '#DIV/0!' ? '' : v)) : EXPECT_TYPED_ROW);
      expect(ctx.stages).toEqual(['read', 'decode', 'transform', 'encode', 'package']);
    });
  }

  it('several sheets -> ZIP with one CSV per non-empty sheet; empty sheets are skipped', async () => {
    const bytes = makeWb('xlsx', {
      'First Sheet': [['a', 'b'], [1, 2]],
      Second: [['c'], ['x']],
      Empty: XLSX.utils.aoa_to_sheet([]),
    });
    const { result, bytes: zip } = await run('xlsx', 'csv', bytes);
    expect(result.ext).toBe('zip');
    expect(result.bundle).toEqual({ count: 2, ext: 'csv' });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['First Sheet.csv', 'Second.csv']);
    expect(strFromU8(files['First Sheet.csv']!)).toBe('a,b\r\n1,2\r\n');
    expect(strFromU8(files['Second.csv']!)).toBe('c\r\nx\r\n');
  });

  it('a workbook with one non-empty sheet among empty ones gives a single file', async () => {
    const bytes = makeWb('xlsx', { A: XLSX.utils.aoa_to_sheet([]), B: [['k'], ['v']] });
    const { result, text } = await run('xlsx', 'tsv', bytes);
    expect(result.ext).toBe('tsv');
    expect(text()).toBe('k\nv\n');
  });

  it('CSV BOM: added only for non-ASCII content, overridable; never for TSV', async () => {
    const ascii = makeWb('xlsx', { S: [['a'], ['b']] });
    const uni = makeWb('xlsx', { S: [['a'], ['é']] });
    expect((await run('xlsx', 'csv', ascii)).bytes.slice(0, 3)).toEqual(new Uint8Array([0x61, 0x0d, 0x0a]));
    expect(Array.from((await run('xlsx', 'csv', uni)).bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from((await run('xlsx', 'csv', uni, { bom: false })).bytes.slice(0, 3))).toEqual([0x61, 0x0d, 0x0a]);
    expect(Array.from((await run('xlsx', 'csv', ascii, { bom: true })).bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from((await run('xlsx', 'tsv', uni)).bytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('ZIP entries get the BOM too when needed', async () => {
    const bytes = makeWb('xlsx', { A: [['é']], B: [['b']] });
    const files = unzipSync((await run('xlsx', 'csv', bytes)).bytes);
    for (const f of Object.values(files)) expect(Array.from(f.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('escapeFormulae prefixes risky text but leaves numbers alone', async () => {
    const bytes = makeWb('xlsx', { S: [['v'], ['=1+1'], ['@x'], [-5], ['plain']] });
    expect((await run('xlsx', 'csv', bytes)).text()).toBe('v\r\n=1+1\r\n@x\r\n-5\r\nplain\r\n');
    expect((await run('xlsx', 'csv', bytes, { escapeFormulae: true })).text()).toBe("v\r\n'=1+1\r\n'@x\r\n-5\r\nplain\r\n");
  });

  it('facts and preview describe the real workbook; formulas use their saved result', async () => {
    const bytes = makeWb('xlsx', { S: typedSheet(), T: [['x'], [1], [2]] });
    const { ctx } = await run('xlsx', 'json', bytes);
    expect(ctx.factsSeen[0]).toEqual({ kind: 'table', sheets: 2, rows: 5, cols: 8 });
    const p = ctx.previews[0]!;
    expect(p.kind === 'grid' && p.rows[1]![1]).toBe('2024-01-15T12:30:00');
  });
});

describe('workbook -> json', () => {
  it('one sheet -> array of row objects with typed values and ISO dates', async () => {
    const bytes = makeWb('xlsx', { Data: typedSheet() });
    const out = JSON.parse((await run('xlsx', 'json', bytes)).text());
    expect(out).toEqual([
      { name: 'Ann', when: '2024-01-15T12:30:00', day: '2024-01-15', at: '06:00:00', ok: true, calc: 4, err: '#DIV/0!', pct: 0.25 },
    ]);
  });

  it('several sheets -> object keyed by sheet name; empty cells are null; blank/duplicate headers are repaired', async () => {
    const bytes = makeWb('xlsx', {
      People: [['name', 'name', ''], ['Ann', 'B', 1], ['Cy']],
      __proto__x: [['k'], ['v']],
    });
    const out = JSON.parse((await run('xlsx', 'json', bytes)).text());
    expect(Object.keys(out)).toEqual(['People', '__proto__x']);
    expect(out.People).toEqual([
      { name: 'Ann', name_2: 'B', 'Column 3': 1 },
      { name: 'Cy', name_2: null, 'Column 3': null },
    ]);
  });

  it('header:false gives arrays of arrays', async () => {
    const bytes = makeWb('xlsx', { S: [['a', 'b'], [1, 2]] });
    expect(JSON.parse((await run('xlsx', 'json', bytes, { header: false })).text())).toEqual([['a', 'b'], [1, 2]]);
  });

  it('csv -> json: empty cells are null, types inferred, ragged rows padded', async () => {
    const out = JSON.parse((await run('csv', 'json', 'a,b,c\n1,,x\n2\n')).text());
    expect(out).toEqual([
      { a: 1, b: null, c: 'x' },
      { a: 2, b: null, c: null },
    ]);
  });
});

/* ------------------------------------------------------ workbook <-> workbook */

describe('workbook -> workbook', () => {
  it('xlsx -> ods -> xlsx keeps values, formulas, booleans and date formats', async () => {
    const src = makeWb('xlsx', { Data: typedSheet(), Two: [['k'], ['v']] });
    const ods = await run('xlsx', 'ods', src);
    expect(ods.ctx.stages).toEqual(['read', 'decode', 'encode']);
    const odsWb = readWb(ods.bytes);
    expect(odsWb.SheetNames).toEqual(['Data', 'Two']);
    const back = await run('ods', 'xlsx', ods.bytes);
    const wb = readWb(back.bytes);
    const d = dense(wb, 'Data');
    expect(d[1]![0]).toMatchObject({ t: 's', v: 'Ann' });
    expect(d[1]![1]!.v).toBeCloseTo(45306.5208333333, 6);
    expect(XLSX.SSF.is_date(d[1]![1]!.z as string)).toBe(true);
    expect(d[1]![4]).toMatchObject({ t: 'b', v: true });
    expect(d[1]![5]!.f).toBe('A2*2');
    // and the dates still come out ISO through the whole chain
    const files = unzipSync((await run('xlsx', 'csv', back.bytes)).bytes);
    const csv = strFromU8(files['Data.csv']!).split('\r\n');
    expect(csv[1]!.split(',').slice(0, 5)).toEqual(['Ann', '2024-01-15T12:30:00', '2024-01-15', '06:00:00', 'TRUE']);
  });

  it('ODS output keeps date separators (SheetJS CE drops unquoted "-")', async () => {
    const ods = await run('xlsx', 'ods', makeWb('xlsx', { D: typedSheet() }));
    const parts = unzipSync(ods.bytes);
    const styles = strFromU8(parts['content.xml']!);
    expect(styles).toContain('<number:text>-</number:text>');
  });

  it('xls (BIFF8) reads', async () => {
    const xls = makeWb('xls', { Old: [['a', 'b'], [1, 'two']] });
    const out = await run('xls', 'xlsx', xls);
    const d = dense(readWb(out.bytes), 'Old');
    expect(d[1]![1]!.v).toBe('two');
  });

  it('dates come out identical in every time zone', async () => {
    const src = makeWb('xlsx', { D: typedSheet() });
    const previous = process.env.TZ;
    const seen = new Set<string>();
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        seen.add((await run('xlsx', 'csv', src)).text());
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
    expect(seen.size).toBe(1);
  });
});

/* ------------------------------------------------------------- JSON -> sheets */

describe('json -> sheets', () => {
  const records = [
    { id: 1, name: 'Ann', tags: ['a', 'b'], meta: { x: 1 }, ok: true },
    { id: 2, name: 'Bob', extra: null },
    { name: '=SUM(A1)', id: '007' },
  ];

  it('array of records -> xlsx: union of keys, typed values, nested as JSON text, no formulas', async () => {
    const { bytes, ctx } = await run('json', 'xlsx', JSON.stringify(records));
    const d = dense(readWb(bytes), 'Sheet1');
    expect(d[0]!.map((c) => c.v)).toEqual(['id', 'name', 'tags', 'meta', 'ok', 'extra']);
    expect(d[1]![0]).toMatchObject({ t: 'n', v: 1 });
    expect(d[1]![2]!.v).toBe('["a","b"]');
    expect(d[1]![3]!.v).toBe('{"x":1}');
    expect(d[1]![4]).toMatchObject({ t: 'b', v: true });
    expect(d[2]![5]).toBeUndefined();
    expect(d[3]![0]).toMatchObject({ t: 's', v: '007' }); // JSON strings are never re-typed
    expect(d[3]![1]).toMatchObject({ t: 's', v: '=SUM(A1)' });
    expect(d[3]![1]!.f).toBeUndefined();
    expect(ctx.stages).toEqual(['read', 'decode', 'transform', 'encode']);
    expect(ctx.factsSeen[0]).toEqual({ kind: 'table', sheets: 1, rows: 4, cols: 6 });
  });

  it('object of arrays -> one sheet per key, with Excel-safe unique names', async () => {
    const data = { 'Sales/2024': [{ q: 1 }], 'Sales:2024': [{ q: 2 }], [`x`.repeat(40)]: [[1, 2]], '': [{ z: 1 }] };
    const { bytes } = await run('json', 'ods', JSON.stringify(data));
    const wb = readWb(bytes);
    expect(wb.SheetNames).toHaveLength(4);
    expect(new Set(wb.SheetNames.map((n) => n.toLowerCase())).size).toBe(4);
    expect(wb.SheetNames.every((n) => n.length <= 31 && !/[\\/?*[\]:]/.test(n))).toBe(true);
    expect(wb.SheetNames[0]).toBe('Sales_2024');
  });

  it('array of arrays, array of scalars, single record and scalar all produce a sheet', async () => {
    expect(dense(readWb((await run('json', 'xlsx', '[[1,2],[3]]')).bytes), 'Sheet1')[1]![0]!.v).toBe(3);
    expect(dense(readWb((await run('json', 'xlsx', '[1,null,"a"]')).bytes), 'Sheet1').map((r) => r[0]?.v)).toEqual(['value', 1, undefined, 'a']);
    expect(dense(readWb((await run('json', 'xlsx', '{"a":1,"b":"x"}')).bytes), 'Sheet1')[1]!.map((c) => c.v)).toEqual([1, 'x']);
    expect(dense(readWb((await run('json', 'xlsx', '42')).bytes), 'Sheet1')[1]![0]!.v).toBe(42);
  });

  it('json -> csv (one file), -> csv ZIP for a sheet map, -> tsv', async () => {
    const one = await run('json', 'csv', JSON.stringify([{ a: 1, b: 'x,y' }, { a: 2, b: null }]));
    expect(one.text()).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
    expect(one.ctx.stages).toEqual(['read', 'decode', 'transform', 'encode', 'package']);
    const many = await run('json', 'csv', JSON.stringify({ A: [{ k: 1 }], B: [{ k: 2 }] }));
    expect(many.result.ext).toBe('zip');
    expect(many.result.bundle).toEqual({ count: 2, ext: 'csv' });
    expect(Object.keys(unzipSync(many.bytes)).sort()).toEqual(['A.csv', 'B.csv']);
    expect((await run('json', 'tsv', '[{"a":1,"b":2}]')).text()).toBe('a\tb\n1\t2\n');
  });

  it('ZIP entry names are safe: no path separators, no traversal, unique ignoring case', async () => {
    const data = { 'a/b': [{ k: 1 }], '../evil': [{ k: 2 }], 'A:B': [{ k: 3 }], 'A:b': [{ k: 4 }], '': [{ k: 5 }], '..': [{ k: 6 }] };
    const names = Object.keys(unzipSync((await run('json', 'csv', JSON.stringify(data))).bytes));
    expect(names).toHaveLength(6);
    for (const n of names) {
      expect(n).not.toMatch(/[\\/:]|^\./);
      expect(n.endsWith('.csv')).toBe(true);
    }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(6);
  });

  it('round trip json -> xlsx -> json preserves records', async () => {
    const data = [{ id: 1, name: 'Ann', ok: true, score: 1.5 }, { id: 2, name: 'Bob', ok: false, score: null }];
    const xlsx = await run('json', 'xlsx', JSON.stringify(data));
    expect(JSON.parse((await run('xlsx', 'json', xlsx.bytes)).text())).toEqual(data);
  });

  it('rejects invalid or empty JSON clearly', async () => {
    await expect(run('json', 'xlsx', '{oops')).rejects.toThrow(/not valid JSON/);
    await expect(run('json', 'xlsx', '[]')).rejects.toThrow(/no rows/);
  });
});

/* ------------------------------------------------------------------- limits */

describe('limits and hostile input', () => {
  it('rejects more rows than XLSX/ODS can hold instead of truncating', async () => {
    const csv = 'a\n' + '1\n'.repeat(LIMITS.rows); // header + 1,048,576 rows = one over
    await expect(run('csv', 'xlsx', csv)).rejects.toThrow(/more than 1,048,576 rows/);
    // the same data is fine as JSON
    const ok = await run('csv', 'json', 'a\n' + '1\n'.repeat(1000));
    expect(JSON.parse(ok.text())).toHaveLength(1000);
  });

  it('accepts exactly the XLSX row limit', async () => {
    const csv = 'a\n' + '1\n'.repeat(LIMITS.rows - 1);
    const { bytes } = await run('csv', 'ods', csv.slice(0, 20_000_000));
    expect(bytes.length).toBeGreaterThan(100);
  }, 120_000);

  it('rejects more columns than XLSX/ODS can hold', async () => {
    const wide = JSON.stringify([Object.fromEntries(Array.from({ length: LIMITS.cols + 1 }, (_, i) => [`c${i}`, i]))]);
    await expect(run('json', 'xlsx', wide)).rejects.toThrow(/16,385 columns; XLSX holds at most 16,384/);
    await expect(run('csv', 'xlsx', Array.from({ length: LIMITS.cols + 1 }, (_, i) => i).join(',') + '\n')).rejects.toThrow(/columns/);
    const ok = await run('json', 'csv', wide);
    expect(ok.text().split('\r\n')[0]!.split(',')).toHaveLength(LIMITS.cols + 1);
  });

  it('rejects a cell too long for XLSX but allows it in ODS and CSV', async () => {
    const big = 'x'.repeat(LIMITS.xlsxCellChars + 1);
    await expect(run('json', 'xlsx', JSON.stringify([{ a: big }]))).rejects.toThrow(/32,768 characters; XLSX cells hold at most 32,767/);
    expect((await run('json', 'ods', JSON.stringify([{ a: big }]))).bytes.length).toBeGreaterThan(100);
    expect((await run('json', 'csv', JSON.stringify([{ a: big }]))).text()).toContain(big);
  });

  it('rejects absurdly sparse JSON records (cell budget)', async () => {
    const recs = Array.from({ length: 8000 }, (_, i) => ({ [`k${i}`]: i }));
    await expect(run('json', 'csv', JSON.stringify(recs))).rejects.toThrow(/too large/); // 8001 x 8000 = 64M cells > 50M
  }, 120_000);

  it('rejects oversized input and empty input', async () => {
    const ctx = testContext();
    const fake = { size: LIMITS.inputBytes + 1 } as Blob;
    await expect(engine.convert({ input: fake, name: 'x.csv', from: 'csv', to: 'json', options: {} }, ctx)).rejects.toThrow(/limit/);
    await expect(run('csv', 'json', '')).rejects.toThrow(/empty/);
  });

  it('rejects a non-ZIP file named .xlsx / .ods, and garbage .xls', async () => {
    await expect(run('xlsx', 'csv', 'a,b\n1,2\n')).rejects.toThrow(/not a ZIP container/);
    await expect(run('ods', 'csv', strToU8('hello'))).rejects.toThrow(/not a ZIP container/);
  });

  it('zip guard counts real inflated bytes and entries', () => {
    const zeros = new Uint8Array(5 * 1024 * 1024);
    const bomb = zipSync({ 'a.xml': zeros, 'b.xml': zeros }, { level: 9 });
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => scanZip(bomb, { limits: { total: 4 * 1024 * 1024 } })).toThrow(/expands to more than/);
    expect(() => scanZip(bomb, { limits: { entry: 1024 * 1024 } })).toThrow(/expands to more than/);
    expect(scanZip(bomb).inflatedBytes).toBe(10 * 1024 * 1024);
    const many = zipSync(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.txt`, strToU8('x')])));
    expect(() => scanZip(many, { limits: { entries: 10 } })).toThrow(/internal parts/);
  });

  it('engine rejects a zip with too many parts end to end', async () => {
    const many = zipSync(Object.fromEntries(Array.from({ length: LIMITS.zipEntries + 1 }, (_, i) => [`f${i}.xml`, new Uint8Array(1)])), { level: 0 });
    await expect(run('xlsx', 'csv', many)).rejects.toThrow(/internal parts/);
  }, 60_000);

  it('ODS repeat bomb is rejected before SheetJS expands it; ordinary padding is fine', async () => {
    const base = unzipSync(makeWb('ods', { S: [['a', 'b'], [1, 2]] }));
    const content = strFromU8(base['content.xml']!);
    const bombRow = content.replace(/<table:table-row>/, '<table:table-row table:number-rows-repeated="1000000000">');
    expect(bombRow).not.toBe(content);
    const bomb = zipSync({ ...base, 'content.xml': strToU8(bombRow) });
    await expect(run('ods', 'csv', bomb)).rejects.toThrow(/repeats cells/);

    const bombCol = content.replace(/<table:table-cell /, '<table:table-cell table:number-columns-repeated="16384" ');
    const bomb2 = zipSync({ ...base, 'content.xml': strToU8(bombRow.replace(/rows-repeated="1000000000"/, 'rows-repeated="5000"') + bombCol.slice(0, 0)) });
    await expect(run('ods', 'csv', bomb2)).resolves.toBeDefined(); // 5000 x 1 valued cell is fine

    const padded = content.replace('</table:table>', '<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>');
    expect(padded).not.toBe(content);
    const ok = await run('ods', 'csv', zipSync({ ...base, 'content.xml': strToU8(padded) }));
    expect(ok.text()).toBe('a,b\r\n1,2\r\n');
  });

  it('a hostile declared range does not make pass-through hang (ref is recomputed)', async () => {
    const parts = unzipSync(makeWb('xlsx', { S: [['a'], [1]] }));
    const sheetXml = strFromU8(parts['xl/worksheets/sheet1.xml']!).replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>');
    expect(sheetXml).toContain('XFD1048576');
    const src = zipSync({ ...parts, 'xl/worksheets/sheet1.xml': strToU8(sheetXml) });
    const t0 = Date.now();
    const out = await run('xlsx', 'ods', src);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(dense(readWb(out.bytes), 'S')[1]![0]!.v).toBe(1);
  });
});

/* ---------------------------------------------------------- edges / stages */

describe('edges', () => {
  const hops = expandEdges(edges.map((e) => ({ ...e, engine: 'sheet' })));
  const pairs = hops.map((h) => `${h.from}->${h.to}`);

  it('declares the documented matrix', () => {
    expect(pairs.sort()).toEqual(
      [
        ...['xlsx', 'xls', 'ods'].flatMap((f) => ['xlsx', 'ods', 'csv', 'tsv', 'json'].filter((t) => t !== f).map((t) => `${f}->${t}`)),
        ...['csv', 'tsv'].flatMap((f) => ['xlsx', 'ods', 'csv', 'tsv', 'json'].filter((t) => t !== f).map((t) => `${f}->${t}`)),
        ...['xlsx', 'ods', 'csv', 'tsv'].map((t) => `json->${t}`),
      ].sort(),
    );
    expect(pairs.filter((p) => p.endsWith('->xls'))).toEqual([]);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('bundling edges are exactly the multi-file ones', () => {
    for (const h of hops) {
      const multi = (['xlsx', 'xls', 'ods', 'json'] as string[]).includes(h.from) && (h.to === 'csv' || h.to === 'tsv');
      expect(h.mayBundle, `${h.from}->${h.to}`).toBe(multi);
    }
  });

  it('every pair reports exactly the declared stages, in order', async () => {
    const fixtures: Partial<Record<FormatId, Uint8Array | string>> = {
      xlsx: makeWb('xlsx', { A: [['a'], [1]], B: [['b'], [2]] }),
      xls: makeWb('xls', { A: [['a'], [1]] }),
      ods: makeWb('ods', { A: [['a'], [1]], B: [['b'], [2]] }),
      csv: 'a,b\n1,2\n',
      tsv: 'a\tb\n1\t2\n',
      json: '[{"a":1}]',
    };
    for (const h of hops) {
      const { ctx, result } = await run(h.from, h.to, fixtures[h.from]!);
      const declared = stagesFor(h.from, h.to).map((s) => s.id);
      expect(ctx.stages, `${h.from}->${h.to}`).toEqual(declared);
      expect(h.stages.map((s) => s.id)).toEqual(declared);
      expect(result.ext === h.to || result.ext === 'zip', `${h.from}->${h.to} ext ${result.ext}`).toBe(true);
      expect(ctx.progressValues.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(ctx.factsSeen.length).toBe(1);
      expect(ctx.previews.length).toBe(1);
    }
  }, 120_000);

  it('stage labels are specific and unique per hop', () => {
    for (const h of hops) {
      const labels = h.stages.map((s) => s.label);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels.every((l) => l.length > 8)).toBe(true);
    }
  });
});
