/**
 * Document engines (pandoc, doclite, typst) in real browsers, through the real
 * planner, runner and Web Worker. Inputs are hand-built in Node (the "foreign"
 * fixtures, written like Word / LibreOffice / EPUB tools write them, not by
 * pandoc); outputs are checked in Node with independent code: fflate for ZIP
 * containers and mupdf for PDFs.
 *
 * Each result line starts with "DOCS|" so a run can be summarised:
 *   DOCS|<browser>|<pair>|<engine route>|<ms>|<note>
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import * as mupdf from 'mupdf';
import { formatInfo, type FormatId } from '../../src/core/formats';
import {
  FOREIGN,
  FOREIGN_HTML,
  FOREIGN_MD,
  FOREIGN_PNG,
  FOREIGN_TEX,
  FOREIGN_TXT,
  foreignDocx,
  foreignEpub,
  foreignOdt,
  foreignRtf,
} from '../../src/engines/pandoc/test-support/office';
import { assetEvents, progressValues, stageIds } from '../../src/engines/magick/e2e-support';
import { openHarness as rawOpen, convert as rawConvert, bytes } from './helpers';

/** The shared Vite dev server re-optimises dependencies the first time an engine imports them and reloads the page. */
const RELOADED = /Execution context was destroyed|interrupted by another navigation|not bound in the connection|Target (page|closed)|navigation/i;
async function openHarness(page: Page) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawOpen(page);
    } catch (err) {
      if (attempt >= 3 || !RELOADED.test(String(err))) throw err;
    }
  }
}
async function convert(page: Page, args: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawConvert(page, args);
    } catch (err) {
      if (attempt >= 3 || !RELOADED.test(String(err))) throw err;
      await openHarness(page);
    }
  }
}

const b64 = (b: Uint8Array | string) => Buffer.from(typeof b === 'string' ? strToU8(b) : b).toString('base64');

/* ------------------------------------------------------------------ inputs */

const SOURCES: Record<string, Uint8Array> = {
  docx: foreignDocx(),
  odt: foreignOdt(),
  rtf: foreignRtf(),
  epub: foreignEpub(),
  md: strToU8(FOREIGN_MD),
  html: strToU8(FOREIGN_HTML),
  tex: strToU8(FOREIGN_TEX),
  txt: strToU8(FOREIGN_TXT),
};
/** Sources that contain the picture, the table and the Cyrillic line (rtf/md/tex/txt: see below). */
const HAS_IMAGE = new Set(['docx', 'odt', 'epub', 'html']);
const HAS_TABLE = new Set(['docx', 'odt', 'epub', 'md', 'html', 'tex', 'txt']);

const MD_WITH_IMAGE = `${FOREIGN_MD}\n![${FOREIGN.alt}](data:image/png;base64,${Buffer.from(FOREIGN_PNG).toString('base64')})\n`;

/* ----------------------------------------------------------------- readers */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) => PNG_MAGIC.every((v, i) => b[i] === v);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const stripTags = (xml: string) => xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The decoded files of a ZIP-based output. */
function zipFiles(out: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(out);
}

/** All the text a produced document holds, whatever its container. */
function textOf(to: string, out: Uint8Array): string {
  switch (to) {
    case 'docx':
      return squash(stripTags(strFromU8(zipFiles(out)['word/document.xml']!)));
    case 'odt':
      return squash(stripTags(strFromU8(zipFiles(out)['content.xml']!)));
    case 'epub':
      return squash(
        Object.entries(zipFiles(out))
          .filter(([n]) => /\.xhtml$/.test(n) && !/nav\.xhtml$/.test(n))
          .map(([, v]) => stripTags(strFromU8(v)))
          .join(' '),
      );
    case 'rtf': {
      // RTF writes non-ASCII as `\uN ?` (signed 16-bit code unit, one delimiter space, one fallback char).
      const s = strFromU8(out).replace(/\\u(-?\d+) ?\?/g, (_, n: string) => String.fromCharCode(Number(n) & 0xffff));
      return squash(s);
    }
    case 'html':
      return squash(stripTags(strFromU8(out).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<head[\s\S]*?<\/head>/i, '')));
    default:
      return squash(strFromU8(out));
  }
}

/** Does the produced document carry the red PNG, byte for byte? */
function carriesImage(to: string, out: Uint8Array, bundled: boolean): boolean {
  if (bundled || to === 'docx' || to === 'odt' || to === 'epub') {
    const files = zipFiles(out);
    return Object.entries(files).some(([name, b]) => !name.endsWith('/') && isPng(b) && sameBytes(b, FOREIGN_PNG));
  }
  if (to === 'html') {
    const m = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(strFromU8(out));
    return !!m && sameBytes(new Uint8Array(Buffer.from(m[1]!, 'base64')), FOREIGN_PNG);
  }
  if (to === 'rtf') {
    const hex = /\\pngblip(?:\\[a-z]+-?\d+)*\s+([0-9a-fA-F\s]+)\}/.exec(strFromU8(out))?.[1]?.replace(/\s+/g, '');
    return !!hex && sameBytes(new Uint8Array(Buffer.from(hex, 'hex')), FOREIGN_PNG);
  }
  return false;
}

function pdfInfo(out: Uint8Array) {
  const doc = mupdf.Document.openDocument(out, 'application/pdf');
  const pages = doc.countPages();
  const text = Array.from({ length: pages }, (_, i) => doc.loadPage(i).toStructuredText('').asText()).join('\n');
  return { pages, text: squash(text) };
}

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b && 'word/document.xml' in zipFiles(b),
  odt: (b) => b[0] === 0x50 && b[1] === 0x4b && strFromU8(zipFiles(b).mimetype!) === 'application/vnd.oasis.opendocument.text',
  epub: (b) => b[0] === 0x50 && b[1] === 0x4b && strFromU8(zipFiles(b).mimetype!) === 'application/epub+zip',
  rtf: (b) => strFromU8(b.subarray(0, 5)) === '{\\rtf',
  html: (b) => /<html/i.test(strFromU8(b.subarray(0, 400))),
  md: () => true,
  tex: (b) => strFromU8(b).includes('\\begin{document}'),
  txt: () => true,
  pdf: (b) => strFromU8(b.subarray(0, 5)) === '%PDF-',
};

/* --------------------------------------------------------------- run helper */

interface Run {
  ok: boolean;
  error?: string;
  route: string[];
  ext: string;
  mime: string;
  name: string;
  bundle?: { count: number; ext: string };
  size: number;
  base64: string;
  events: any[];
  wall: number;
}

/**
 * A byte stream the shared dev server drops mid-download (seen once in Firefox, under heavy machine load,
 * as "Error in input stream") is infrastructure noise, not a conversion result: retry that, and only that, once.
 */
const TRANSIENT_NETWORK = /Error in input stream|NetworkError|Failed to fetch|Load failed|network connection was lost/i;

async function run(page: Page, from: string, to: string, input: Uint8Array | string, extra: Record<string, unknown> = {}): Promise<Run> {
  const t = Date.now();
  let r = (await convert(page, { from, to, base64: b64(input), name: `report.${from}`, ...extra })) as Run;
  if (!r.ok && TRANSIENT_NETWORK.test(r.error ?? '')) {
    console.log(`DOCS|retry|${from}->${to}|${r.error}`);
    r = (await convert(page, { from, to, base64: b64(input), name: `report.${from}`, ...extra })) as Run;
  }
  r.wall = Date.now() - t;
  return r;
}

// Written out by hand, independent of the edges.ts files (those import a Vite-only ?raw file Node cannot load).
const PANDOC_SOURCES = ['docx', 'odt', 'rtf', 'epub', 'md', 'html', 'tex', 'txt'] as const;
const PANDOC_TARGETS = ['docx', 'odt', 'rtf', 'epub', 'md', 'html', 'tex', 'txt'] as const;
const declared = (engine: 'pandoc' | 'doclite' | 'typst', to: FormatId): string[] =>
  engine === 'doclite'
    ? ['decode', 'encode']
    : engine === 'typst'
      ? ['load', 'decode', 'transform', 'encode']
      : ['load', 'decode', 'encode', ...(to === 'md' || to === 'tex' ? ['package'] : [])];
const types = (events: any[], type: string) => events.filter((e) => e.type === type);
const errorText = (r: Run) => r.error ?? JSON.stringify(types(r.events, 'error'));

/** Where a Vite `?url` asset lives on disk, from the URL the worker fetched. */
function diskPath(url: string): string | undefined {
  const p = decodeURIComponent(url.split('?')[0]!);
  const rel = p.startsWith('/@fs/') ? p.slice('/@fs'.length) : `${process.cwd()}${p}`;
  return existsSync(rel) ? rel : undefined;
}

const note = (browser: string, pair: string, route: string, ms: number, text = '') =>
  // eslint-disable-next-line no-console
  console.log(`DOCS|${browser}|${pair}|${route}|${ms}|${text}`);

/* ------------------------------------------------------------------- tests */

test.describe('documents', () => {
  test.beforeEach(async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('http://localhost') && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u);
    });
    (page as unknown as { __external: string[] }).__external = external;
    await openHarness(page);
  });
  test.afterEach(async ({ page }) => {
    expect((page as unknown as { __external: string[] }).__external, 'off-origin requests').toEqual([]);
  });

  test('the planner offers every document pair and picks the cheap engine for md -> html', async ({ page }) => {
    const reach = async (from: string) => (await page.evaluate((f) => (window as any).harness.routes(f), from)) as { to: string; hops: string[] }[];
    for (const from of PANDOC_SOURCES) {
      const to = new Set((await reach(from)).map((r) => r.to));
      for (const t of [...PANDOC_TARGETS, 'pdf']) if (t !== from) expect(to.has(t), `${from} -> ${t}`).toBe(true);
    }
    const fromMd = await reach('md');
    expect(fromMd.find((r) => r.to === 'html')!.hops).toEqual(['doclite:md->html']);
    expect(fromMd.find((r) => r.to === 'docx')!.hops).toEqual(['pandoc:md->docx']);
    expect(fromMd.find((r) => r.to === 'pdf')!.hops).toEqual(['typst:md->pdf']);
    expect((await reach('docx')).find((r) => r.to === 'pdf')!.hops).toEqual(['typst:docx->pdf']);
    expect((await reach('txt')).find((r) => r.to === 'md')!.hops).toEqual(['doclite:txt->md']);
  });

  test('md -> html runs on the doclite fast path: no wasm, real facts and outline, scripts removed', async ({ page, browserName }) => {
    const md = `${FOREIGN_MD}\n<script>alert(1)</script>\n\n[bad](javascript:alert(2))\n\n<img src=x onerror=alert(3)>\n`;
    const r = await run(page, 'md', 'html', md);
    expect(r.ok, errorText(r)).toBe(true);
    expect(r.route).toEqual(['doclite:md->html']);
    expect(r.ext).toBe('html');
    expect(r.mime).toBe('text/html');
    expect(r.name).toBe('report.html');
    const html = strFromU8(bytes(r.base64));
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain(`<title>${FOREIGN.title}</title>`);
    expect(html).toContain('Content-Security-Policy');
    expect(html).toMatch(/<h1[^>]*>Quarterly Report<\/h1>/);
    expect(html).toMatch(/<strong>Revenue grew<\/strong>/);
    expect(html).toMatch(/<table>[\s\S]*<th>Region<\/th>[\s\S]*<td>120<\/td>/);
    expect(html).toContain(FOREIGN.cyrillic);
    expect(html).not.toMatch(/<script|onerror|javascript:/i);

    expect(stageIds(r.events)).toEqual(declared('doclite', 'html'));
    expect(assetEvents(r.events), 'doclite must not download anything').toEqual([]);
    expect(progressValues(r.events)).toEqual([]);
    expect(types(r.events, 'facts')[0].facts).toMatchObject({ kind: 'document', headings: 1, tables: 1 });
    const prev = types(r.events, 'preview')[0].preview;
    expect(prev.kind).toBe('outline');
    expect(prev.items[0]).toEqual({ level: 1, text: FOREIGN.title });
    note(browserName, 'md->html', r.route.join('+'), r.wall, `${r.size} B, no assets`);
  });

  test('doclite txt -> html / txt -> md / md -> txt, and hand-off to pandoc for what it cannot do faithfully', async ({ page }) => {
    const txt = `Title line\n\nSecond paragraph with *stars* and <angle> & ampersand.\n\n    indented block\n    stays code\n`;
    const html = await run(page, 'txt', 'html', txt);
    expect(html.ok, errorText(html)).toBe(true);
    expect(html.route).toEqual(['doclite:txt->html']);
    const h = strFromU8(bytes(html.base64));
    expect(h).toContain('*stars* and &lt;angle&gt; &amp; ampersand.');
    expect(h).toContain('<pre>    indented block\n    stays code</pre>');

    const md = await run(page, 'txt', 'md', txt);
    expect(md.ok, errorText(md)).toBe(true);
    expect(md.route).toEqual(['doclite:txt->md']);
    expect(strFromU8(bytes(md.base64))).toContain('\\*stars\\*');

    const back = await run(page, 'md', 'txt', '# Heading\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two\n');
    expect(back.ok, errorText(back)).toBe(true);
    expect(back.route).toEqual(['doclite:md->txt']);
    expect(strFromU8(bytes(back.base64))).toBe('Heading\n\nSome bold text and a link (https://example.com).\n\n- one\n- two\n');
    for (const r of [html, md, back]) expect(assetEvents(r.events)).toEqual([]);

    // A table cannot be written to plain text by the quick path: the runner falls back to pandoc, visibly.
    const table = await run(page, 'md', 'txt', FOREIGN_MD);
    expect(table.ok, errorText(table)).toBe(true);
    const fb = types(table.events, 'fallback');
    expect(fb.length).toBe(1);
    expect(fb[0]).toMatchObject({ fromEngine: 'doclite', toEngine: 'pandoc' });
    expect(strFromU8(bytes(table.base64))).toContain('Region');
    expect(assetEvents(table.events).some((a) => /pandoc\.wasm/.test(a.url))).toBe(true);

    // YAML front matter also goes to pandoc, which understands it.
    const fm = await run(page, 'md', 'html', '---\ntitle: From Front Matter\n---\n\nBody **text**.\n');
    expect(fm.ok, errorText(fm)).toBe(true);
    expect(types(fm.events, 'fallback')[0]).toMatchObject({ toEngine: 'pandoc' });
    expect(strFromU8(bytes(fm.base64))).toContain('From Front Matter');
  });

  test('hostile Markdown is refused up front instead of hanging a worker', async ({ page }) => {
    // Unmatched emphasis in one word is quadratic in marked and far worse in pandoc (a_ x 8000 = 75 s measured).
    for (const to of ['html', 'docx', 'pdf']) {
      const t = Date.now();
      const r = await run(page, 'md', to, `${'a_'.repeat(30000)}\n\nafter`);
      expect(r.ok, to).toBe(false);
      expect(r.error, to).toMatch(/far too long/);
      expect(assetEvents(r.events), `${to}: refused before any download`).toEqual([]);
      expect(Date.now() - t).toBeLessThan(20_000);
    }
    const quotes = await run(page, 'md', 'html', `${'> '.repeat(3000)}x\n`);
    expect(quotes.ok).toBe(false);
    expect(quotes.error).toMatch(/block quotes more than 400 levels/);

    // Deep but sane nesting still converts.
    const deep = await run(page, 'md', 'html', `${'> '.repeat(200)}deep\n`);
    expect(deep.ok, errorText(deep)).toBe(true);
    expect(strFromU8(bytes(deep.base64))).toContain('deep');
  });

  test('md -> docx keeps structure, table, bold and the embedded image', async ({ page, browserName }) => {
    const r = await run(page, 'md', 'docx', MD_WITH_IMAGE);
    expect(r.ok, errorText(r)).toBe(true);
    expect(r.route).toEqual(['pandoc:md->docx']);
    expect(r.ext).toBe('docx');
    expect(r.mime).toBe(formatInfo('docx').mime);
    expect(r.bundle).toBeUndefined();
    const out = bytes(r.base64);
    expect(MAGIC.docx!(out)).toBe(true);
    const files = zipFiles(out);
    const xml = strFromU8(files['word/document.xml']!);
    expect(xml).toContain('<w:tbl>');
    expect(xml).toMatch(/<w:b\s*\/>[\s\S]*Revenue grew/);
    expect(xml).toMatch(/w:pStyle w:val="Heading1"/);
    const text = textOf('docx', out);
    for (const w of [FOREIGN.title, FOREIGN.bold, 'Region', 'Sales', 'North', '120', FOREIGN.cyrillic]) expect(text).toContain(w);
    expect(carriesImage('docx', out, false)).toBe(true);

    expect(stageIds(r.events)).toEqual(declared('pandoc', 'docx'));
    expect(types(r.events, 'facts')[0].facts).toMatchObject({ kind: 'document', headings: 1, tables: 1, images: 1 });
    expect(types(r.events, 'preview')[0].preview.kind).toBe('outline');
    note(browserName, 'md->docx', r.route.join('+'), r.wall, `${r.size} B`);
  });

  test('docx -> md bundles the markdown with its images as a ZIP', async ({ page }) => {
    const r = await run(page, 'docx', 'md', SOURCES.docx!);
    expect(r.ok, errorText(r)).toBe(true);
    expect(r.route).toEqual(['pandoc:docx->md']);
    expect(r.ext).toBe('zip');
    expect(r.mime).toBe('application/zip');
    expect(r.bundle).toEqual({ count: 2, ext: 'md' });
    expect(r.name).toBe('report.zip');
    const files = zipFiles(bytes(r.base64));
    const names = Object.keys(files);
    expect(names).toContain('report.md');
    const md = strFromU8(files['report.md']!);
    expect(md).toMatch(/^# Quarterly Report/m);
    expect(md).toContain('**Revenue grew**');
    expect(md).toMatch(/\|\s*Region\s*\|\s*Sales\s*\|/);
    expect(md).toContain(FOREIGN.cyrillic);
    const media = names.filter((n) => /^media\//.test(n));
    expect(media.length).toBe(1);
    expect(md).toContain(media[0]!); // the markdown really points at the file in the ZIP
    expect(sameBytes(files[media[0]!]!, FOREIGN_PNG)).toBe(true);
    expect(stageIds(r.events)).toEqual(declared('pandoc', 'md'));
    expect(types(r.events, 'facts')[0].facts).toMatchObject({ kind: 'document', headings: 1, tables: 1, images: 1 });
  });

  test('epub -> md', async ({ page }) => {
    const r = await run(page, 'epub', 'md', SOURCES.epub!);
    expect(r.ok, errorText(r)).toBe(true);
    expect(r.ext).toBe('zip');
    expect(r.bundle).toEqual({ count: 2, ext: 'md' });
    const files = zipFiles(bytes(r.base64));
    const md = strFromU8(files['report.md']!);
    expect(md).toMatch(/^# Quarterly Report/m);
    expect(md).toContain('**Revenue grew**');
    expect(md).toContain(FOREIGN.cyrillic);
    expect(md).toMatch(/\|\s*North\s*\|\s*120\s*\|/);
    const media = Object.keys(files).filter((n) => /^media\//.test(n));
    expect(media.length).toBe(1);
    expect(sameBytes(files[media[0]!]!, FOREIGN_PNG)).toBe(true);
  });

  test('odt -> rtf keeps text, Cyrillic and the picture', async ({ page }) => {
    const r = await run(page, 'odt', 'rtf', SOURCES.odt!);
    expect(r.ok, errorText(r)).toBe(true);
    expect(r.route).toEqual(['pandoc:odt->rtf']);
    expect(r.ext).toBe('rtf');
    expect(r.mime).toBe('application/rtf');
    const out = bytes(r.base64);
    expect(MAGIC.rtf!(out)).toBe(true);
    const text = textOf('rtf', out);
    for (const w of [FOREIGN.title, FOREIGN.bold, 'Region', 'North', '120', FOREIGN.cyrillic]) expect(text).toContain(w);
    expect(carriesImage('rtf', out, false)).toBe(true);
  });

  test('html -> pdf: typeset with Typst, real pages, remote images and scripts stay inert', async ({ page, browserName }) => {
    const html = FOREIGN_HTML.replace('</body>', '<script>fetch("https://evil.example/x")</script><img src="https://evil.example/pixel.png" alt="remote pixel"></body>');
    const r = await run(page, 'html', 'pdf', html);
    expect(r.ok, errorText(r)).toBe(true);
    expect(r.route).toEqual(['typst:html->pdf']);
    expect(r.ext).toBe('pdf');
    expect(r.mime).toBe('application/pdf');
    const out = bytes(r.base64);
    expect(MAGIC.pdf!(out)).toBe(true);
    const { pages, text } = pdfInfo(out);
    expect(pages).toBe(1);
    for (const w of [FOREIGN.title, FOREIGN.bold, 'Region', 'Sales', 'North', '120', FOREIGN.cyrillic]) expect(text).toContain(w);
    expect(text).not.toContain('fetch(');
    expect(stageIds(r.events)).toEqual(declared('typst', 'pdf'));
    expect(progressValues(r.events)).toEqual([]);

    // Facts: the decoded document, then the real page count; outline preview from the AST.
    const facts = types(r.events, 'facts').map((e) => e.facts);
    expect(facts[0]).toMatchObject({ kind: 'document', headings: 1, tables: 1, images: 2 }); // the data: picture and the remote one
    expect(facts[1]).toMatchObject({ kind: 'pages', pages });
    // The remote image is never fetched: its description is shown and the user is told.
    expect(text).toContain('[image: remote pixel]');
    expect(types(r.events, 'log').some((l) => /image\(s\) could not be placed/.test(l.message))).toBe(true);
    expect(facts[1].width).toBeCloseTo(595.3, 0);
    expect(types(r.events, 'preview')[0].preview.items[0]).toEqual({ level: 1, text: FOREIGN.title });
    note(browserName, 'html->pdf', r.route.join('+'), r.wall, `${r.size} B, ${pages} page`);
  });

  test('docx -> pdf: page count from the PDF bytes, timings and asset sizes', async ({ page, browserName }) => {
    // A multi-page Word file: make it with pandoc in the browser first (md -> docx), then typeset it.
    const para = (i: number) => `Paragraph ${i}: the quarterly report keeps growing and growing, wrapping over several lines of the page.`;
    const long = `# Long report\n\n${Array.from({ length: 160 }, (_, i) => para(i)).join('\n\n')}\n\n![${FOREIGN.alt}](data:image/png;base64,${Buffer.from(FOREIGN_PNG).toString('base64')})\n\nThe end.\n`;
    const made = await run(page, 'md', 'docx', long);
    expect(made.ok, errorText(made)).toBe(true);

    const r = await run(page, 'docx', 'pdf', bytes(made.base64), { name: 'long.docx' });
    expect(r.ok, errorText(r)).toBe(true);
    expect(r.route).toEqual(['typst:docx->pdf']);
    const out = bytes(r.base64);
    expect(MAGIC.pdf!(out)).toBe(true);
    const { pages, text } = pdfInfo(out);
    expect(pages).toBeGreaterThan(4);
    expect(text).toContain('Long report');
    expect(text).toContain('Paragraph 159');
    expect(text).toContain('The end.');
    expect(r.name).toBe('long.pdf');

    const facts = types(r.events, 'facts').map((e) => e.facts);
    expect(facts[0]).toMatchObject({ kind: 'document', headings: 1, images: 1 });
    expect(facts.at(-1)).toMatchObject({ kind: 'pages', pages });
    expect(stageIds(r.events)).toEqual(declared('typst', 'pdf'));

    // The foreign (Word-style) docx too.
    const foreign = await run(page, 'docx', 'pdf', SOURCES.docx!);
    expect(foreign.ok, errorText(foreign)).toBe(true);
    const f = pdfInfo(bytes(foreign.base64));
    expect(f.pages).toBe(1);
    for (const w of [FOREIGN.title, 'Region', '120', FOREIGN.cyrillic]) expect(f.text).toContain(w);

    // Assets: pandoc wasm, typst wasm and every bundled font arrive through ctx.fetchAsset, byte-accurate.
    const assets = assetEvents(r.events);
    const byUrl = new Map<string, typeof assets>();
    for (const a of assets) byUrl.set(a.url, [...(byUrl.get(a.url) ?? []), a]);
    const urls = [...byUrl.keys()];
    expect(urls.filter((u) => /pandoc\.wasm/.test(u)).length).toBe(1);
    expect(urls.filter((u) => /typst_ts_web_compiler_bg\.wasm/.test(u)).length).toBe(1);
    expect(urls.filter((u) => /\/fonts\/.*\.(otf|ttf)/.test(u)).length).toBe(9);
    expect(urls.length).toBe(11);
    const sizes: string[] = [];
    for (const [url, evs] of byUrl) {
      const disk = diskPath(url);
      expect(disk, `asset on disk: ${url}`).toBeDefined();
      const size = statSync(disk!).size;
      expect(evs[0]!.loaded).toBe(0);
      expect(evs.at(-1)!.loaded, url).toBe(size);
      for (let i = 1; i < evs.length; i++) expect(evs[i]!.loaded).toBeGreaterThanOrEqual(evs[i - 1]!.loaded);
      sizes.push(`${url.split('/').at(-1)!.split('?')[0]}=${size}`);
    }

    const at = (type: string, stage?: string) => r.events.find((e) => e.type === type && (stage === undefined || e.stage === stage))?.at as number | undefined;
    const t0 = at('hop-start')!;
    const ms = (a?: number, b?: number) => (a !== undefined && b !== undefined ? Math.round(b - a) : -1);
    const timing = `load ${ms(t0, at('stage', 'decode'))} ms, decode ${ms(at('stage', 'decode'), at('stage', 'transform'))} ms, typeset ${ms(at('stage', 'transform'), at('stage', 'encode'))} ms, write ${ms(at('stage', 'encode'), at('hop-done'))} ms`;
    note(browserName, 'docx->pdf', r.route.join('+'), r.wall, `${pages} pages, ${r.size} B, ${timing}; ${sizes.join(' ')}`);
    test.info().annotations.push({ type: 'docx->pdf', description: `${r.wall} ms wall (${timing}); ${pages} pages; assets ${sizes.join(', ')}` });
  });

  test('every pandoc source -> every other pandoc target (56 pairs): valid container, content, image', async ({ page, browserName }) => {
    test.setTimeout(600_000);
    const seen: string[] = [];
    for (const from of PANDOC_SOURCES) {
      for (const to of PANDOC_TARGETS) {
        if (to === from) continue;
        const t = Date.now();
        const r = await run(page, from, to, SOURCES[from]!, { engine: 'pandoc' });
        const pair = `${from}->${to}`;
        expect(r.ok, `${pair}: ${errorText(r)}`).toBe(true);
        expect(r.route, pair).toEqual([`pandoc:${pair}`]);
        expect(stageIds(r.events), `${pair} stages`).toEqual(declared('pandoc', to));
        expect(progressValues(r.events), `${pair} progress`).toEqual([]);

        const facts = types(r.events, 'facts')[0].facts;
        expect(facts.kind, pair).toBe('document');
        expect(types(r.events, 'preview')[0].preview.kind).toBe('outline');

        const bundled = !!r.bundle;
        const out = bytes(r.base64);
        const info = formatInfo(to as FormatId);
        if (bundled) {
          expect(['md', 'tex']).toContain(to);
          expect(r.ext).toBe('zip');
          expect(r.bundle!.ext).toBe(info.exts[0]);
          expect(r.bundle!.count).toBe(Object.keys(zipFiles(out)).filter((n) => !n.endsWith('/')).length);
        } else {
          expect(r.ext, pair).toBe(info.exts[0]);
          expect(r.mime, pair).toBe(info.mime);
        }
        const main = bundled ? zipFiles(out)[`report.${info.exts[0]}`]! : out;
        expect(main, `${pair} main file`).toBeDefined();
        expect(MAGIC[to]!(main), `${pair} container`).toBe(true);

        const text = textOf(to, main);
        const expected: string[] = [FOREIGN.title, FOREIGN.bold, FOREIGN.cyrillic];
        if (HAS_TABLE.has(from)) expected.push('Region', 'Sales', 'North', '120');
        for (const w of expected) expect(text, `${pair} text`).toContain(w);

        if (HAS_IMAGE.has(from) && !['txt'].includes(to)) {
          expect(carriesImage(to, out, bundled), `${pair} keeps the picture`).toBe(true);
        }
        seen.push(`${pair}:${Date.now() - t}`);
      }
    }
    expect(seen.length).toBe(56);
    note(browserName, 'matrix', 'pandoc', 0, seen.join(' '));
  });

  test('bad input fails with a clear message, before downloading pandoc', async ({ page }) => {
    const wrong = await run(page, 'docx', 'md', 'this is plain text, not a Word file');
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/not a DOCX/i);
    expect(assetEvents(wrong.events), 'no 58 MB download for a wrong file').toEqual([]);

    const corrupt = SOURCES.docx!.slice(0, Math.floor(SOURCES.docx!.length / 2));
    const broken = await run(page, 'docx', 'pdf', corrupt);
    expect(broken.ok).toBe(false);
    expect(broken.error!.length).toBeGreaterThan(10);

    const emptyEpub = await run(page, 'epub', 'md', SOURCES.docx!); // a ZIP, but not an EPUB
    expect(emptyEpub.ok).toBe(false);
    expect(emptyEpub.error).toMatch(/EPUB/i);
  });

  test('privacy: nothing leaves the page and nothing is persisted', async ({ page }) => {
    for (const [from, to, input] of [
      ['md', 'html', FOREIGN_MD],
      ['docx', 'md', SOURCES.docx!],
      ['html', 'pdf', FOREIGN_HTML.replace('</body>', '<img src="https://evil.example/pixel.png"></body>')],
      ['tex', 'docx', FOREIGN_TEX],
    ] as const) {
      const r = await run(page, from, to, input);
      expect(r.ok, errorText(r)).toBe(true);
      for (const a of assetEvents(r.events)) expect(a.url.startsWith('http')).toBe(false); // same-origin paths only
    }
    const state = await page.evaluate(async () => {
      const dbs = (await (indexedDB as any).databases?.()) ?? [];
      const caches_ = typeof caches !== 'undefined' ? await caches.keys() : [];
      let opfs: string[] = [];
      try {
        const root = await navigator.storage.getDirectory();
        for await (const [name] of (root as any).entries()) opfs.push(name);
      } catch {
        opfs = [];
      }
      return { dbs: dbs.map((d: any) => d.name), caches: caches_, local: localStorage.length, session: sessionStorage.length, opfs };
    });
    expect(state).toEqual({ dbs: [], caches: [], local: 0, session: 0, opfs: [] });
    // (the afterEach hook asserts zero off-origin requests for the whole test)
  });

  test('pandoc is downloaded through ctx.fetchAsset with byte-accurate progress', async ({ page, browserName }) => {
    const r = await run(page, 'rtf', 'docx', SOURCES.rtf!);
    expect(r.ok, errorText(r)).toBe(true);
    const a = assetEvents(r.events);
    expect(a.length).toBeGreaterThan(2);
    expect(new Set(a.map((e) => e.url)).size).toBe(1);
    expect(a[0]!.url).toMatch(/pandoc\.wasm/);
    const disk = diskPath(a[0]!.url)!;
    expect(disk).toBeDefined();
    const size = readFileSync(disk).length;
    expect(a[0]!.loaded).toBe(0);
    expect(a.at(-1)!.loaded).toBe(size);
    expect(a.at(-1)!.total === null || a.at(-1)!.total === size).toBe(true);
    for (let i = 1; i < a.length; i++) expect(a[i]!.loaded).toBeGreaterThanOrEqual(a[i - 1]!.loaded);
    note(browserName, 'asset', 'pandoc.wasm', r.wall, `${size} bytes, ${a.length} progress events`);
    test.info().annotations.push({ type: 'asset', description: `pandoc.wasm ${size} bytes` });

    // Every progress value the engine reports is measured: documents report none.
    expect(progressValues(r.events)).toEqual([]);
  });
});
