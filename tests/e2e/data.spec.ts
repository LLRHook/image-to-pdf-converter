/**
 * Spreadsheet + structured-data engines (sheet, datatree) in real browsers:
 * real Workers, real runner, through the dev harness. Fixtures are generated
 * here with SheetJS / fflate; outputs are parsed back and compared.
 */
import { expect, test } from '@playwright/test';
import * as XLSX from 'xlsx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import YAML from 'yaml';
import { bytes, convert, openHarness } from './helpers';

const b64 = (data: Uint8Array | string) => Buffer.from(typeof data === 'string' ? strToU8(data) : data).toString('base64');
const OK = (r: any) => {
  expect(r.error, r.error).toBeUndefined();
  expect(r.ok).toBe(true);
  return r;
};
const outBytes = (r: any) => new Uint8Array(bytes(r.base64));
const outText = (r: any) => strFromU8(outBytes(r));
const stageIds = (r: any, hop = 0) => r.events.filter((e: any) => e.type === 'stage' && e.hop === hop).map((e: any) => e.stage);

function sheetBytes(bookType: 'xlsx' | 'xls' | 'ods', sheets: Record<string, XLSX.WorkSheet | unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, s] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, Array.isArray(s) ? XLSX.utils.aoa_to_sheet(s) : (s as XLSX.WorkSheet), name);
  }
  return new Uint8Array(XLSX.write(wb, { bookType, type: 'array', compression: true }));
}
const dense = (b: Uint8Array, name: string) =>
  ((XLSX.read(b, { type: 'array', dense: true, cellNF: true }).Sheets[name] as any)['!data'] as XLSX.CellObject[][]);

function typedSheet(): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([['name', 'when', 'day', 'ok', 'calc']], { dense: true });
  (ws as any)['!data'].push([
    { t: 's', v: 'Ann' },
    { t: 'n', v: 45306.5208333333, z: 'yyyy-mm-dd hh:mm:ss' },
    { t: 'n', v: 45306, z: 'yyyy-mm-dd' },
    { t: 'b', v: true },
    { t: 'n', v: 4, f: 'A2*2' },
  ]);
  ws['!ref'] = 'A1:E2';
  return ws;
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

/* ------------------------------------------------------------------ routing */

test('registry exposes both engines and plans multi-hop routes across them', async ({ page }) => {
  const r = await page.evaluate(() => ({
    csv: (window as any).harness.routes('csv'),
    json: (window as any).harness.routes('json'),
    yaml: (window as any).harness.routes('yaml'),
    xml: (window as any).harness.routes('xml'),
    xls: (window as any).harness.routes('xls'),
  }));
  const hop = (list: any[], to: string) => list.find((x) => x.to === to)?.hops;
  expect(hop(r.csv, 'xlsx')).toEqual(['sheet:csv->xlsx']);
  expect(hop(r.csv, 'json')).toEqual(['sheet:csv->json']);
  expect(hop(r.json, 'yaml')).toEqual(['datatree:json->yaml']);
  expect(hop(r.json, 'ods')).toEqual(['sheet:json->ods']);
  expect(hop(r.xml, 'json')).toEqual(['datatree:xml->json']);
  expect(hop(r.yaml, 'xlsx')).toEqual(['datatree:yaml->json', 'sheet:json->xlsx']);
  expect(hop(r.xml, 'csv')).toEqual(['datatree:xml->json', 'sheet:json->csv']);
  expect(hop(r.xls, 'xlsx')).toEqual(['sheet:xls->xlsx']);
  expect(r.csv.some((x: any) => x.to === 'xls')).toBe(false); // xls is read-only
});

/* -------------------------------------------------------------- csv / tsv in */

test('csv -> xlsx: typed cells, no formulas, accurate stages/facts/preview', async ({ page }) => {
  const csv = 'id,name,price,flag,zip,formula\n1,Ann,1.50,true,007,=1+1\n2,"Bob, Jr.",2,FALSE,01234,"=HYPERLINK(""http://x"")"\n';
  const r = OK(await convert(page, { engine: 'sheet', from: 'csv', to: 'xlsx', base64: b64(csv), name: 'people.csv' }));
  expect(r.ext).toBe('xlsx');
  expect(r.name).toBe('people.xlsx');
  expect(outBytes(r).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
  const d = dense(outBytes(r), 'Sheet1');
  expect(d[1]![0]).toMatchObject({ t: 'n', v: 1 });
  expect(d[1]![2]).toMatchObject({ t: 'n', v: 1.5 });
  expect(d[1]![3]).toMatchObject({ t: 'b', v: true });
  expect(d[1]![4]).toMatchObject({ t: 's', v: '007' });
  expect(d[1]![5]).toMatchObject({ t: 's', v: '=1+1' });
  expect(d[1]![5]!.f).toBeUndefined();
  expect(String(d[2]![5]!.v)).toBe('=HYPERLINK("http://x")');
  expect(strFromU8(unzipSync(outBytes(r))['xl/worksheets/sheet1.xml']!)).not.toMatch(/<f[ >]/);

  expect(stageIds(r)).toEqual(['read', 'decode', 'transform', 'encode']);
  const facts = r.events.find((e: any) => e.type === 'facts');
  expect(facts.facts).toEqual({ kind: 'table', sheets: 1, rows: 3, cols: 6 });
  const preview = r.events.find((e: any) => e.type === 'preview').preview;
  expect(preview.kind).toBe('grid');
  expect(preview.rows[0]).toEqual(['id', 'name', 'price', 'flag', 'zip', 'formula']);
  expect(preview.rows[2][1]).toBe('Bob, Jr.');
});

test('csv: delimiter detection, BOM, quoted newlines, Windows-1252, tsv', async ({ page }) => {
  const semi = OK(await convert(page, { engine: 'sheet', from: 'csv', to: 'json', base64: b64('﻿a;b\n1;"x;\ny"\n') }));
  expect(JSON.parse(outText(semi))).toEqual([{ a: 1, b: 'x;\ny' }]);
  const latin = OK(await convert(page, { engine: 'sheet', from: 'csv', to: 'json', base64: b64(new Uint8Array([0x6e, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a])) }));
  expect(JSON.parse(outText(latin))).toEqual([{ n: 'café' }]);
  const tsv = OK(await convert(page, { engine: 'sheet', from: 'tsv', to: 'csv', base64: b64('a\tb\n007\t"x,y"\n') }));
  expect(outText(tsv)).toBe('a,b\r\n007,"x,y"\r\n');
  expect(tsv.ext).toBe('csv');
});

test('csv bigger than a screenful: measured progress, round trip csv -> xlsx -> csv', async ({ page }) => {
  const lines = ['id,name,score,when'];
  for (let i = 0; i < 60_000; i++) lines.push(`${i},name ${i},${(i % 100) / 4},2024-01-${String((i % 28) + 1).padStart(2, '0')}`);
  const csv = lines.join('\n') + '\n';
  const x = OK(await convert(page, { engine: 'sheet', from: 'csv', to: 'xlsx', base64: b64(csv) }));
  const progress = x.events.filter((e: any) => e.type === 'progress');
  expect(progress.length).toBeGreaterThan(1);
  expect(progress.every((e: any) => e.value >= 0 && e.value <= 1)).toBe(true);
  expect(x.events.find((e: any) => e.type === 'facts').facts).toEqual({ kind: 'table', sheets: 1, rows: 60_001, cols: 4 });
  const back = OK(await convert(page, { engine: 'sheet', from: 'xlsx', to: 'csv', base64: x.base64 }));
  const rows = outText(back).trimEnd().split('\r\n');
  expect(rows).toHaveLength(60_001);
  expect(rows[0]).toBe('id,name,score,when');
  const i = 59_999;
  expect(rows[60_000]).toBe(`${i},name ${i},${(i % 100) / 4},2024-01-${String((i % 28) + 1).padStart(2, '0')}`);
});

/* ---------------------------------------------------------- workbooks in/out */

for (const bt of ['xlsx', 'ods', 'xls'] as const) {
  test(`${bt} -> csv / json: typed values, ISO dates, formulas as results`, async ({ page }) => {
    const src = sheetBytes(bt, { Data: typedSheet() });
    const csv = OK(await convert(page, { engine: 'sheet', from: bt, to: 'csv', base64: b64(src) }));
    expect(outText(csv).trimEnd().split('\r\n')).toEqual(['name,when,day,ok,calc', 'Ann,2024-01-15T12:30:00,2024-01-15,TRUE,4']);
    expect(stageIds(csv)).toEqual(['read', 'decode', 'transform', 'encode', 'package']);
    const json = OK(await convert(page, { engine: 'sheet', from: bt, to: 'json', base64: b64(src) }));
    expect(JSON.parse(outText(json))).toEqual([{ name: 'Ann', when: '2024-01-15T12:30:00', day: '2024-01-15', ok: true, calc: 4 }]);
  });
}

test('multi-sheet workbook -> ZIP of CSVs and an object of arrays in JSON', async ({ page }) => {
  const src = sheetBytes('xlsx', { People: [['n'], ['Ann']], Pets: [['p', 'q'], ['Rex', 1]], Empty: XLSX.utils.aoa_to_sheet([]) });
  const z = OK(await convert(page, { engine: 'sheet', from: 'xlsx', to: 'csv', base64: b64(src) }));
  expect(z.ext).toBe('zip');
  expect(z.name).toBe('input.zip');
  expect(z.bundle).toEqual({ count: 2, ext: 'csv' });
  const files = unzipSync(outBytes(z));
  expect(Object.keys(files).sort()).toEqual(['People.csv', 'Pets.csv']);
  expect(strFromU8(files['Pets.csv']!)).toBe('p,q\r\nRex,1\r\n');
  const j = OK(await convert(page, { engine: 'sheet', from: 'xlsx', to: 'json', base64: b64(src) }));
  expect(JSON.parse(outText(j))).toEqual({ People: [{ n: 'Ann' }], Pets: [{ p: 'Rex', q: 1 }] });
  expect(j.events.find((e: any) => e.type === 'facts').facts).toEqual({ kind: 'table', sheets: 3, rows: 4, cols: 2 });
});

test('xlsx <-> ods keep values, formulas and dates; unicode and CSV BOM', async ({ page }) => {
  const src = sheetBytes('xlsx', { Data: typedSheet(), Two: [['k'], ['é']] });
  const ods = OK(await convert(page, { engine: 'sheet', from: 'xlsx', to: 'ods', base64: b64(src) }));
  expect(ods.ext).toBe('ods');
  expect(stageIds(ods)).toEqual(['read', 'decode', 'encode']);
  const back = OK(await convert(page, { engine: 'sheet', from: 'ods', to: 'xlsx', base64: ods.base64 }));
  const d = dense(outBytes(back), 'Data');
  expect(d[1]![0]).toMatchObject({ t: 's', v: 'Ann' });
  expect(d[1]![1]!.v).toBeCloseTo(45306.5208333333, 6);
  expect(XLSX.SSF.is_date(d[1]![1]!.z as string)).toBe(true);
  expect(d[1]![3]).toMatchObject({ t: 'b', v: true });
  expect(d[1]![4]!.f).toBe('A2*2');
  const zip = unzipSync(outBytes(OK(await convert(page, { engine: 'sheet', from: 'xlsx', to: 'csv', base64: b64(src) }))));
  expect(Array.from(zip['Two.csv']!.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // non-ASCII -> BOM for Excel
  expect(Array.from(zip['Data.csv']!.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
});

/* ------------------------------------------------------------------- json in */

test('json -> xlsx / ods / csv / tsv, never creating formulas', async ({ page }) => {
  const data = [{ id: 1, name: '=SUM(A1:A9)', ok: true, tags: ['a'], note: null }, { id: 2, name: 'Bob', ok: false, extra: 1.5 }];
  const x = OK(await convert(page, { engine: 'sheet', from: 'json', to: 'xlsx', base64: b64(JSON.stringify(data)) }));
  const d = dense(outBytes(x), 'Sheet1');
  expect(d[0]!.map((c) => c.v)).toEqual(['id', 'name', 'ok', 'tags', 'note', 'extra']);
  expect(d[1]![1]).toMatchObject({ t: 's', v: '=SUM(A1:A9)' });
  expect(d[1]![1]!.f).toBeUndefined();
  expect(d[1]![3]!.v).toBe('["a"]');
  expect(d[2]![5]).toMatchObject({ t: 'n', v: 1.5 });
  const ods = OK(await convert(page, { engine: 'sheet', from: 'json', to: 'ods', base64: b64(JSON.stringify(data)) }));
  expect(dense(outBytes(ods), 'Sheet1')[2]![1]!.v).toBe('Bob');
  const csv = OK(await convert(page, { engine: 'sheet', from: 'json', to: 'csv', base64: b64(JSON.stringify(data)) }));
  expect(outText(csv).split('\r\n')[0]).toBe('id,name,ok,tags,note,extra');
  expect(stageIds(csv)).toEqual(['read', 'decode', 'transform', 'encode', 'package']);
  const tsv = OK(await convert(page, { engine: 'sheet', from: 'json', to: 'tsv', base64: b64('[{"a":1,"b":"x"}]') }));
  expect(outText(tsv)).toBe('a\tb\n1\tx\n');
  const sheets = OK(await convert(page, { engine: 'sheet', from: 'json', to: 'csv', base64: b64('{"A":[{"k":1}],"B":[{"k":2}]}') }));
  expect(sheets.ext).toBe('zip');
  expect(Object.keys(unzipSync(outBytes(sheets))).sort()).toEqual(['A.csv', 'B.csv']);
});

test('limits are reported, never truncated: too many columns / a cell too long for XLSX', async ({ page }) => {
  const wide = JSON.stringify([Object.fromEntries(Array.from({ length: 16_385 }, (_, i) => [`c${i}`, i]))]);
  const r = await convert(page, { engine: 'sheet', from: 'json', to: 'xlsx', base64: b64(wide) });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/16,385 columns; XLSX holds at most 16,384/);
  const long = await convert(page, { engine: 'sheet', from: 'json', to: 'xlsx', base64: b64(JSON.stringify([{ a: 'x'.repeat(40_000) }])) });
  expect(long.ok).toBe(false);
  expect(long.error).toMatch(/32,767/);
  expect(OK(await convert(page, { engine: 'sheet', from: 'json', to: 'csv', base64: b64(wide) })).size).toBeGreaterThan(1000);
});

/* ----------------------------------------------------------------- datatree */

const DOC = { name: 'Ann', n: 3, ok: true, nothing: null, list: [1, 'two', { three: 3 }], nested: { a: { b: ['deep'] } }, text: 'café ☕', words: ['yes', 'no', '007', '2001-12-14'] };

test('json -> yaml -> json lossless; yaml safe for YAML 1.1 readers', async ({ page }) => {
  const y = OK(await convert(page, { engine: 'datatree', from: 'json', to: 'yaml', base64: b64(JSON.stringify(DOC)) }));
  expect(y.ext).toBe('yaml');
  expect(stageIds(y)).toEqual(['read', 'decode', 'encode']);
  expect(YAML.parse(outText(y), { version: '1.1' })).toEqual(DOC);
  const back = OK(await convert(page, { engine: 'datatree', from: 'yaml', to: 'json', base64: y.base64 }));
  expect(JSON.parse(outText(back))).toEqual(DOC);
  const facts = y.events.find((e: any) => e.type === 'facts').facts;
  expect(facts.kind).toBe('tree');
  expect(facts.nodes).toBeGreaterThan(15);
  expect(facts.depth).toBe(5);
  const preview = y.events.find((e: any) => e.type === 'preview').preview;
  expect(preview.kind).toBe('outline');
  expect(preview.items[0]).toEqual({ level: 0, text: 'name: "Ann"' });
});

test('yaml: comments dropped, anchors/merge expanded, multi-document becomes an array', async ({ page }) => {
  const single = OK(await convert(page, { engine: 'datatree', from: 'yaml', to: 'json', base64: b64('# c\nbase: &b {x: 1}\nd:\n  <<: *b\n  y: 2 # trailing\n') }));
  expect(JSON.parse(outText(single))).toEqual({ base: { x: 1 }, d: { x: 1, y: 2 } });
  const multi = OK(await convert(page, { engine: 'datatree', from: 'yaml', to: 'json', base64: b64('a: 1\n---\nb: 2\n') }));
  expect(JSON.parse(outText(multi))).toEqual([{ a: 1 }, { b: 2 }]);
  expect(multi.events.some((e: any) => e.type === 'log' && /2 documents/.test(e.message))).toBe(true);
});

const XML = `<?xml version="1.0"?>
<!-- c -->
<catalog id="c1"><book id="b1"><title>Dune &amp; Sons</title><price cur="USD">9.99</price><tag>a</tag><tag>b</tag></book><book id="b2"><title>Caf&#233;</title><e/></book></catalog>`;

test('xml <-> json <-> yaml follow the documented mapping and round-trip semantically', async ({ page }) => {
  const asJson = OK(await convert(page, { engine: 'datatree', from: 'xml', to: 'json', base64: b64(XML) }));
  const tree = JSON.parse(outText(asJson));
  expect(tree).toEqual({
    catalog: {
      '@_id': 'c1',
      book: [
        { '@_id': 'b1', title: 'Dune & Sons', price: { '@_cur': 'USD', '#text': '9.99' }, tag: ['a', 'b'] },
        { '@_id': 'b2', title: 'Café', e: '' },
      ],
    },
  });
  const xml = OK(await convert(page, { engine: 'datatree', from: 'json', to: 'xml', base64: asJson.base64 }));
  expect(xml.ext).toBe('xml');
  expect(outText(xml).startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(stageIds(xml)).toEqual(['read', 'decode', 'transform', 'encode']);
  const again = OK(await convert(page, { engine: 'datatree', from: 'xml', to: 'json', base64: xml.base64 }));
  expect(JSON.parse(outText(again))).toEqual(tree);
  const yml = OK(await convert(page, { engine: 'datatree', from: 'xml', to: 'yaml', base64: b64(XML) }));
  const viaYaml = OK(await convert(page, { engine: 'datatree', from: 'yaml', to: 'xml', base64: yml.base64 }));
  expect(JSON.parse(outText(OK(await convert(page, { engine: 'datatree', from: 'xml', to: 'json', base64: viaYaml.base64 }))))).toEqual(tree);
});

test('json -> xml wraps data without a single root and renames bad keys', async ({ page }) => {
  const r = OK(await convert(page, { engine: 'datatree', from: 'json', to: 'xml', base64: b64('{"a b":1,"list":[1,2],"n":null}') }));
  const xml = outText(r);
  expect(xml).toContain('<root>');
  expect(xml).toContain('<a_b>1</a_b>');
  expect(xml).toContain('<n/>');
  expect(r.events.filter((e: any) => e.type === 'log').map((e: any) => e.message).join(' ')).toMatch(/wrapped in <root>.*renamed/s);
});

test('browser DOMParser accepts our XML output', async ({ page }) => {
  const r = OK(await convert(page, { engine: 'datatree', from: 'json', to: 'xml', base64: b64(JSON.stringify({ r: { '@_a': 'x"<&', t: 'a < b & c', l: [1, 2], e: null } })) }));
  const verdict = await page.evaluate((xml) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { error: doc.getElementsByTagName('parsererror').length, root: doc.documentElement.nodeName, attr: doc.documentElement.getAttribute('a'), text: doc.getElementsByTagName('t')[0]?.textContent };
  }, outText(r));
  expect(verdict).toEqual({ error: 0, root: 'r', attr: 'x"<&', text: 'a < b & c' });
});

test('multi-hop through both engines: yaml -> xlsx, xml -> csv, xlsx -> xml', async ({ page }) => {
  const x = OK(await convert(page, { from: 'yaml', to: 'xlsx', base64: b64('- {id: 1, name: A}\n- {id: 2, name: B}\n') }));
  expect(x.route).toEqual(['datatree:yaml->json', 'sheet:json->xlsx']);
  expect(dense(outBytes(x), 'Sheet1')[2]![1]!.v).toBe('B');
  const c = OK(await convert(page, { from: 'xml', to: 'csv', base64: b64('<r><i><a>1</a><b>x</b></i><i><a>2</a><b>y</b></i></r>') }));
  expect(c.route).toEqual(['datatree:xml->json', 'sheet:json->csv']);
  expect(c.events.filter((e: any) => e.type === 'hop-start').length).toBe(2);
  const sheets = await convert(page, { from: 'xlsx', to: 'xml', base64: b64(sheetBytes('xlsx', { S: [['k', 'v'], ['a', 1]] })) });
  OK(sheets);
  expect(sheets.route).toEqual(['sheet:xlsx->json', 'datatree:json->xml']);
  expect(outText(sheets)).toContain('<k>a</k>');
});

/* ------------------------------------------------------------- hostile input */

test('hostile inputs fail fast with a clear message', async ({ page }) => {
  const t0 = Date.now();
  let yaml = 'a0: &a0 [x, x, x, x, x, x, x, x, x]\n';
  for (let i = 1; i < 10; i++) yaml += `a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(', ')}]\n`;
  const laughsYaml = await convert(page, { engine: 'datatree', from: 'yaml', to: 'json', base64: b64(yaml) });
  expect(laughsYaml.ok).toBe(false);
  expect(laughsYaml.error).toMatch(/billion laughs/);

  const xxe = await convert(page, { engine: 'datatree', from: 'xml', to: 'json', base64: b64('<!DOCTYPE f [<!ENTITY x SYSTEM "http://evil.example/x">]><f>&x;</f>') });
  expect(xxe.ok).toBe(false);
  expect(xxe.error).toMatch(/external entities/i);

  const lol = await convert(page, {
    engine: 'datatree', from: 'xml', to: 'json',
    base64: b64('<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;">]><l>&c;</l>'),
  });
  expect(lol.ok).toBe(false);
  expect(lol.error).toMatch(/another entity/i);

  const deep = await convert(page, { engine: 'datatree', from: 'json', to: 'yaml', base64: b64('['.repeat(5000) + ']'.repeat(5000)) });
  expect(deep.ok).toBe(false);
  expect(deep.error).toMatch(/nested/);

  const base = unzipSync(sheetBytes('ods', { S: [['a'], [1]] }));
  const bombXml = strFromU8(base['content.xml']!).replace(/<table:table-row>/, '<table:table-row table:number-rows-repeated="1000000000">');
  const bomb = await convert(page, { engine: 'sheet', from: 'ods', to: 'csv', base64: b64(zipSync({ ...base, 'content.xml': strToU8(bombXml) })) });
  expect(bomb.ok).toBe(false);
  expect(bomb.error).toMatch(/repeats cells/);

  const zeros = new Uint8Array(8 * 1024 * 1024);
  const parts = unzipSync(sheetBytes('xlsx', { S: [['a'], [1]] }));
  const xlsxBomb = zipSync({ ...parts, 'xl/junk.bin': zeros }, { level: 9 });
  expect(xlsxBomb.length).toBeLessThan(200_000);
  // 8 MB of padding is below the real limit (1 GiB), so this must still convert quickly and correctly:
  expect(OK(await convert(page, { engine: 'sheet', from: 'xlsx', to: 'csv', base64: b64(xlsxBomb) })).ext).toBe('csv');

  expect((await convert(page, { engine: 'sheet', from: 'xlsx', to: 'csv', base64: b64('a,b\n1,2\n') })).error).toMatch(/not a ZIP container/);
  expect(Date.now() - t0).toBeLessThan(60_000);
});

/* ------------------------------------------------------------------ privacy */

test('conversions make no network requests and keep nothing in browser storage', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const before = requests.length;
  await convert(page, { engine: 'sheet', from: 'csv', to: 'xlsx', base64: b64('a,b\n1,2\n') });
  await convert(page, { engine: 'datatree', from: 'json', to: 'yaml', base64: b64('{"a":1}') });
  const external = requests.slice(before).filter((u) => !u.startsWith('http://localhost') && !u.startsWith('blob:') && !u.startsWith('data:'));
  expect(external).toEqual([]);
  const stores = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    caches: 'caches' in self ? (await caches.keys()).length : 0,
    idb: 'databases' in indexedDB ? (await indexedDB.databases()).length : 0,
  }));
  expect(stores).toEqual({ local: 0, session: 0, caches: 0, idb: 0 });
});
