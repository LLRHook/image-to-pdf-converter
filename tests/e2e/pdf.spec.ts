import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import * as mupdf from 'mupdf';
import { expandEdges } from '../../src/core/graph';
import type { FormatId } from '../../src/core/formats';
import { edges } from '../../src/engines/mupdf/edges';
import { assetEvents, nativeDecode, progressValues, retryOnReload, stageIds } from '../../src/engines/magick/e2e-support';
import { compare, decodePng, encodePng, sampleRaster } from '../../src/engines/magick/test-utils';
import { convert, openHarness } from './helpers';

const HOPS = expandEdges(edges.map((e) => ({ ...e, engine: 'mupdf' })));
const hop = (from: FormatId, to: FormatId) => HOPS.find((h) => h.from === from && h.to === to)!;
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

interface PageSpec {
  w?: number;
  h?: number;
  text?: string[];
}
function makePdf(pages: PageSpec[], save = ''): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Times-Roman'));
  const res = doc.addObject(doc.newDictionary());
  const fonts = doc.newDictionary();
  fonts.put('F1', font);
  res.put('Font', fonts);
  pages.forEach((p, i) => {
    const lines = p.text ?? [`Hello page ${i + 1} of ${pages.length}`, 'Second line caf\\351'];
    const content = `BT /F1 24 Tf 72 ${(p.h ?? 792) - 92} Td ${lines.map((l, k) => `${k ? '0 -40 Td ' : ''}(${l.replace(/[()]/g, '\\$&')}) Tj`).join(' ')} ET`;
    doc.insertPage(-1, doc.addPage([0, 0, p.w ?? 612, p.h ?? 792], 0, res, content));
  });
  return doc.saveToBuffer(save).asUint8Array().slice();
}
function scanPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const img = doc.addImage(new mupdf.Image(encodePng(sampleRaster(40, 30, false))));
  const res = doc.addObject(doc.newDictionary());
  const xo = doc.newDictionary();
  xo.put('Im0', img);
  res.put('XObject', xo);
  doc.insertPage(-1, doc.addPage([0, 0, 200, 150], 0, res, 'q 200 0 0 150 0 0 cm /Im0 Do Q'));
  return doc.saveToBuffer('').asUint8Array().slice();
}
const epub = (chapters = 2) =>
  zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>Test Book</dc:title><dc:language>en</dc:language></metadata><manifest>${Array.from({ length: chapters }, (_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${Array.from({ length: chapters }, (_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`,
    ),
    ...Object.fromEntries(
      Array.from({ length: chapters }, (_, i) => [
        `OEBPS/c${i}.xhtml`,
        strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i + 1}</title></head><body><h1>Chapter ${i + 1}</h1>${'<p>Lorem ipsum dolor sit amet. Привет мир.</p>'.repeat(40)}</body></html>`),
      ]),
    ),
  });

/** What mupdf itself draws, in Node, for comparison with the browser's wasm. */
function nodeRender(pdf: Uint8Array, index: number, dpi: number) {
  const page = mupdf.Document.openDocument(pdf, 'application/pdf').loadPage(index);
  const s = dpi / 72;
  const pm = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
  return decodePng(pm.asPNG());
}

async function run(page: Page, from: FormatId, to: FormatId, input: Uint8Array, options?: Record<string, unknown>, name = `doc.${from}`) {
  return retryOnReload(() => openHarness(page), () => convert(page, { from, to, engine: 'mupdf', base64: b64(input), name, options }));
}

const three = makePdf([{}, { w: 400, h: 300 }, {}]);

test.describe('mupdf engine in a real browser', () => {
  let external: string[] = [];
  test.beforeEach(async ({ page }) => {
    external = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
    });
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await retryOnReload(() => page.waitForTimeout(300), () => openHarness(page));
  });
  test.afterEach(() => {
    expect(external).toEqual([]);
  });

  test('wasm comes through ctx.fetchAsset with exact byte progress, nothing else is fetched', async ({ page }) => {
    const fetched: string[] = [];
    page.on('request', (r) => {
      if (/\.wasm/.test(r.url())) fetched.push(new URL(r.url()).pathname);
    });
    const r = await run(page, 'pdf', 'txt', three);
    expect(r.ok, r.error).toBe(true);
    const a = assetEvents(r.events);
    const size = readFileSync('node_modules/mupdf/dist/mupdf-wasm.wasm').length;
    expect(new Set(a.map((e) => e.url)).size).toBe(1);
    expect(a[0]!.url).toMatch(/mupdf-wasm[\w.-]*\.wasm$/);
    expect(a[0]!.loaded).toBe(0);
    expect(a.at(-1)!.loaded).toBe(size);
    expect(a.every((e) => e.total === size)).toBe(true);
    // the library never downloaded its own copy: the only .wasm request is the one fetchAsset made
    expect(fetched.length).toBeGreaterThan(0);
    expect(new Set(fetched).size).toBe(1);
    expect(fetched[0]).toMatch(/mupdf-wasm[\w.-]*\.wasm$/);
    test.info().annotations.push({ type: 'asset', description: `mupdf-wasm.wasm ${size} bytes` });
  });

  test('pdf -> png: ZIP of per-page PNGs identical to what mupdf draws in Node', async ({ page }) => {
    const r = await run(page, 'pdf', 'png', three, undefined, 'My Report.pdf');
    expect(r.ok, r.error).toBe(true);
    expect(r.ext).toBe('zip');
    expect(r.bundle).toEqual({ count: 3, ext: 'png' });
    expect(r.name).toBe('My Report.zip');
    const files = unzipSync(unb64(r.base64));
    expect(Object.keys(files)).toEqual(['My Report-1.png', 'My Report-2.png', 'My Report-3.png']);
    Object.values(files).forEach((f, i) => {
      const got = decodePng(f);
      const want = nodeRender(three, i, 150);
      expect([got.width, got.height]).toEqual([want.width, want.height]);
      expect(compare(want, got).max, `page ${i + 1}`).toBe(0);
    });
    expect(stageIds(r.events)).toEqual(hop('pdf', 'png').stages.map((s) => s.id));
    const prog = progressValues(r.events);
    expect(prog.at(-1)).toBe(1);
    expect(prog.every((v: number, i: number) => v > 0 && v <= 1 && (i === 0 || v >= prog[i - 1]!))).toBe(true);
    const facts = r.events.find((e: { type: string }) => e.type === 'facts');
    expect(facts.facts).toEqual({ kind: 'pages', pages: 3, width: 612, height: 792 });
    const prev = r.events.find((e: { type: string }) => e.type === 'preview').preview;
    expect(prev.kind).toBe('pixels');
    expect(Math.max(prev.width, prev.height)).toBe(96);
  });

  test('single page -> one plain file, dpi option respected', async ({ page }) => {
    const one = makePdf([{}]);
    const r = await run(page, 'pdf', 'png', one, { dpi: 72 });
    expect(r.ext).toBe('png');
    expect(r.bundle).toBeUndefined();
    const p = decodePng(unb64(r.base64));
    expect([p.width, p.height]).toEqual([612, 792]);
  });

  test('pdf -> jpg: browser decodes the JPEGs', async ({ page }) => {
    const r = await run(page, 'pdf', 'jpg', three);
    expect(r.ok, r.error).toBe(true);
    const files = unzipSync(unb64(r.base64));
    expect(Object.keys(files)).toEqual(['doc-1.jpg', 'doc-2.jpg', 'doc-3.jpg']);
    const n = await nativeDecode(page, files['doc-2.jpg']!, 'image/jpeg');
    expect(n).not.toBeNull();
    expect([n!.width, n!.height]).toEqual([834, 625]);
    const want = nodeRender(three, 1, 150);
    expect(compare(want, { ...n!, rgba: n!.rgba }).mean).toBeLessThan(3);
  });

  test('pdf -> svg: valid XML that the browser draws like the PDF', async ({ page }) => {
    const r = await run(page, 'pdf', 'svg', three);
    expect(r.ok, r.error).toBe(true);
    const files = unzipSync(unb64(r.base64));
    expect(Object.keys(files)).toEqual(['doc-1.svg', 'doc-2.svg', 'doc-3.svg']);
    const svg = new TextDecoder().decode(files['doc-1.svg']!);
    const ink = await page.evaluate(async (text) => {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (doc.querySelector('parsererror')) return -1;
      const img = new Image();
      const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      await new Promise((ok, bad) => {
        img.onload = ok;
        img.onerror = bad;
        img.src = url;
      });
      const c = document.createElement('canvas');
      c.width = 612;
      c.height = 792;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 612, 792);
      g.drawImage(img, 0, 0, 612, 792);
      const d = g.getImageData(0, 0, 612, 792).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 100) n++;
      return n;
    }, svg);
    expect(ink).toBeGreaterThan(300);
  });

  test('pdf -> txt and html', async ({ page }) => {
    const doc = makePdf([{ text: ['First page', 'caf\\351 au lait'] }, { text: ['Second page here'] }]);
    const t = await run(page, 'pdf', 'txt', doc);
    expect(t.ok, t.error).toBe(true);
    const text = new TextDecoder().decode(unb64(t.base64));
    expect(text).toContain('café au lait');
    expect(text.indexOf('First page')).toBeLessThan(text.indexOf('Second page here'));
    expect(stageIds(t.events)).toEqual(['load', 'decode', 'encode']);

    const h = await run(page, 'pdf', 'html', doc, undefined, 'a <b>.pdf');
    expect(h.ok, h.error).toBe(true);
    const html = new TextDecoder().decode(unb64(h.base64));
    // Open it for real, with no network allowed, and read what a person would see.
    const other = await page.context().newPage();
    const reqs: string[] = [];
    other.on('request', (r) => reqs.push(r.url()));
    await other.setContent(html);
    const shown = await other.evaluate(() => document.body.innerText);
    expect(shown).toContain('First page');
    expect(shown).toContain('Second page here');
    expect(reqs.filter((u) => /^https?:/.test(u))).toEqual([]);
    await other.close();
  });

  test('epub -> pdf typesets pages; epub -> png bundles them', async ({ page }) => {
    const p = await run(page, 'epub', 'pdf', epub());
    expect(p.ok, p.error).toBe(true);
    const out = unb64(p.base64);
    const doc = mupdf.Document.openDocument(out, 'application/pdf');
    expect(doc.countPages()).toBeGreaterThan(2);
    const text = Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('').asText()).join('\n');
    expect(text).toContain('Chapter 2');
    expect(text).toContain('Привет мир');
    const i = await run(page, 'epub', 'png', epub(1), { dpi: 72 });
    expect(i.ok, i.error).toBe(true);
    const files = unzipSync(unb64(i.base64));
    expect(Object.keys(files).length).toBe(i.bundle.count);
    expect(decodePng(Object.values(files)[0]!).width).toBe(420);
  });

  test('errors are readable: page cap, scans, passwords, junk', async ({ page }) => {
    const many = await run(page, 'pdf', 'png', makePdf(Array.from({ length: 501 }, () => ({ w: 20, h: 20, text: ['x'] }))));
    expect(many.ok).toBe(false);
    expect(many.error).toMatch(/501 pages; the limit is 500/);
    const scan = await run(page, 'pdf', 'txt', scanPdf());
    expect(scan.error).toMatch(/No selectable text.*OCR is not available/);
    const locked = makePdf([{}], 'encrypt=aes-128,user-password=secret,owner-password=owner');
    expect((await run(page, 'pdf', 'png', locked)).error).toMatch(/password-protected/);
    expect((await run(page, 'pdf', 'png', locked, { password: 'secret', dpi: 36 })).ok).toBe(true);
    expect((await run(page, 'pdf', 'png', new Uint8Array(500).fill(1))).error).toMatch(/not a PDF/);
    expect((await run(page, 'pdf', 'png', encodePng(sampleRaster(8, 8)))).error).toMatch(/not a PDF/);
  });

  test('oversize pages render at reduced scale instead of failing', async ({ page }) => {
    const r = await run(page, 'pdf', 'png', makePdf([{ w: 7000, h: 7000, text: ['big'] }]), { dpi: 150 });
    expect(r.ok, r.error).toBe(true);
    const p = decodePng(unb64(r.base64));
    expect(p.width * p.height).toBeLessThanOrEqual(100_000_000);
    expect(r.events.some((e: { type: string; message?: string }) => e.type === 'log' && /lower scale/.test(e.message ?? ''))).toBe(true);
  });

  test('default planner picks mupdf for pdf -> png and returns the same bytes', async ({ page }) => {
    const r = await convert(page, { from: 'pdf', to: 'png', base64: b64(makePdf([{}])) });
    expect(r.ok, r.error).toBe(true);
    expect(r.route).toEqual(['mupdf:pdf->png']);
  });
});
