import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import type { FormatId } from '../../core/formats';
import { PANDOC_SOURCES } from '../pandoc/spec';
import { SAMPLE_PNG, buildSources, fixturePandoc } from '../pandoc/fixtures';
import { LIMITS } from '../pandoc/limits';
import { FONT_URLS, TypstError, inspectPdf, isTypstImage, loadTypst, typeset } from './compile';
import { edges } from './edges';
import engine from './engine';

const hasFonts = FONT_URLS.length > 0;
const dec = new TextDecoder();
const enc = new TextEncoder();
let sources: Record<string, Uint8Array>;

beforeAll(async () => {
  sources = await buildSources(await fixturePandoc());
});

async function run(from: FormatId, data: Uint8Array | string, name = `report.${from}`) {
  const ctx = testContext();
  const res = await engine.convert({ input: blobOf(data), name, from, to: 'pdf', options: {} }, ctx);
  return { ctx, res, pdf: await bytesOf(res.output) };
}

function open(pdf: Uint8Array) {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const pages = doc.countPages();
  const text = Array.from({ length: pages }, (_, i) => doc.loadPage(i).toStructuredText('').asText()).join('\n');
  return { doc, pages, text };
}

/** Number of pixels on page `i` close to the sample PNG's red (200,40,40). */
function redPixels(pdf: Uint8Array, i = 0): number {
  const page = mupdf.Document.openDocument(pdf, 'application/pdf').loadPage(i);
  const pm = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  const px = pm.getPixels();
  let n = 0;
  for (let o = 0; o < px.length; o += 3) if (Math.abs(px[o]! - 200) < 12 && Math.abs(px[o + 1]! - 40) < 12 && Math.abs(px[o + 2]! - 40) < 12) n++;
  return n;
}

describe('typst edges', () => {
  it('declares exactly what convert reports', async () => {
    expect(edges.length).toBe(hasFonts ? 1 : 0);
    if (!hasFonts) return;
    const e = edges[0]!;
    expect(e.stages('docx', 'pdf').map((s) => s.label)).toEqual(['Load pandoc + Typst', 'Read DOCX into pandoc AST', 'Typeset with Typst', 'Write PDF']);
    expect(e.note!('docx', 'pdf')).toContain('Re-typeset with Typst; page layout differs from the original.');
  });
});

describe.skipIf(!hasFonts)('typst: every document -> pdf', () => {
  it.each(PANDOC_SOURCES.map((s) => [s]))('%s -> pdf', async (from) => {
    const { ctx, res, pdf } = await run(from, sources[from]!);
    expect(res.ext).toBe('pdf');
    expect(res.mime).toBe('application/pdf');
    expect(dec.decode(pdf.subarray(0, 5))).toBe('%PDF-');
    expect(dec.decode(pdf.subarray(-8))).toContain('%%EOF');

    // Stages exactly as declared, no invented progress; assets = pandoc + typst + fonts only.
    expect(ctx.stages).toEqual(edges[0]!.stages(from, 'pdf').map((s) => s.id));
    expect(ctx.progressValues).toEqual([]);
    expect(ctx.assets.length).toBe(2 + FONT_URLS.length);

    // Facts: the decoded document first, then the real page count.
    expect(ctx.factsSeen[0]!.kind).toBe('document');
    const pagesFact = ctx.factsSeen[1]!;
    expect(pagesFact.kind).toBe('pages');

    const { pages, text } = open(pdf);
    if (pagesFact.kind === 'pages') {
      expect(pagesFact.pages).toBe(pages);
      expect(pagesFact.width).toBeCloseTo(595.3, 0); // A4
      expect(pagesFact.height).toBeCloseTo(841.9, 0);
    }
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(text).toContain('Overview');
    expect(text).toContain('quarterly');
    expect(text).toContain('Numbers');
    expect(text).toContain('Region');
    expect(text).toContain('120');
    expect(text).toContain('first item');
    expect(text).toContain('alpha');
    // Images from the document are really on the page (sample PNG is red).
    if (!['tex', 'txt'].includes(from)) expect(redPixels(pdf)).toBeGreaterThan(300);
  });
});

describe.skipIf(!hasFonts)('typst: layout and content', () => {
  it('paginates long documents and reports the true page count', async () => {
    const md = Array.from({ length: 300 }, (_, i) => `Paragraph number ${i} with some words to fill the page nicely and wrap over lines.`).join('\n\n');
    const { ctx, pdf } = await run('md', enc.encode(md));
    const { pages, text } = open(pdf);
    expect(pages).toBeGreaterThan(5);
    expect(text).toContain('Paragraph number 299');
    expect(ctx.factsSeen.at(-1)).toMatchObject({ kind: 'pages', pages });
    expect(inspectPdf(pdf).pages).toBe(pages);
  });

  it('draws Latin, Greek, Cyrillic, math and code', async () => {
    const md = '# Привет мир\n\nΕλληνικά και café déjà vu, Ünïcödé.\n\nEquation: $E = m c^2$ and $$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$\n\n```python\nprint("hello")\n```\n';
    const { pdf } = await run('md', enc.encode(md));
    const { text } = open(pdf);
    for (const w of ['Привет мир', 'Ελληνικά', 'café déjà vu', 'Ünïcödé', 'print']) expect(text).toContain(w);
    expect(text).toMatch(/𝐸\s*=\s*𝑚𝑐/u); // typeset as math italics
    expect(text).toContain('𝑛(𝑛+ 1)');
  });

  it('warns that characters outside the bundled fonts will be blank', async () => {
    const { ctx } = await run('md', enc.encode('Hello 日本語 text'));
    expect(ctx.logs.some((l) => /no glyph/.test(l))).toBe(true);
  });

  it('uses the title metadata and falls back to the file name', async () => {
    const { pdf } = await run('md', enc.encode('---\ntitle: My Title\nauthor: A. Uthor\n---\n\nbody text'));
    const t = open(pdf).text;
    expect(t).toContain('My Title');
    expect(t).toContain('A. Uthor');
  });

  it('shows the description of an image Typst cannot decode instead of failing', async () => {
    const bmp = new Uint8Array(70);
    bmp.set([0x42, 0x4d, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0]);
    const md = `before\n\n![a bitmap](data:image/bmp;base64,${Buffer.from(bmp).toString('base64')})\n\n![remote](https://example.com/x.png)\n\nafter`;
    const { ctx, pdf } = await run('md', enc.encode(md));
    const t = open(pdf).text;
    expect(t).toContain('[image: a bitmap]');
    expect(t).toContain('[image: remote]');
    expect(t).toContain('after');
    expect(ctx.logs.some((l) => /image\(s\) could not be placed/.test(l))).toBe(true);
  });

  it('embeds a PNG given as a data: URI', async () => {
    const { pdf } = await run('md', enc.encode(`![x](data:image/png;base64,${Buffer.from(SAMPLE_PNG).toString('base64')})`));
    expect(redPixels(pdf)).toBeGreaterThan(100);
  });
});

describe.skipIf(!hasFonts)('typst: safety and errors', () => {
  it('rejects wrong files before downloading anything', async () => {
    const ctx = testContext();
    await expect(engine.convert({ input: blobOf('plain text'), name: 'x.docx', from: 'docx', to: 'pdf', options: {} }, ctx)).rejects.toThrow(/not a DOCX/);
    expect(ctx.assets).toEqual([]);
  });

  it('rejects oversized input', async () => {
    await expect(run('md', new Uint8Array(LIMITS.inputBytes + 1))).rejects.toThrow(/limit/);
  });

  it('reports Typst compile errors readably', async () => {
    const rt = await loadTypst(testContext());
    expect(() => typeset(rt, '#let x = ', new Map())).toThrow(TypstError);
    expect(() => typeset(rt, '#let x = ', new Map())).toThrow(/line 1:\d+: error: expected expression/);
    // The runtime stays usable after an error.
    const ok = typeset(rt, 'fine', new Map()).exportPdf();
    expect(open(ok).text).toContain('fine');
  });

  it('hostile content cannot read files or reach the network from Typst', async () => {
    // Raw Typst/LaTeX tricks in the text stay text: they are escaped by pandoc.
    const md = '#read("/etc/passwd") #image("http://evil.example/x.png") #eval("1+1")\n\n`#read("/x")`';
    const { pdf } = await run('md', enc.encode(md));
    const t = open(pdf).text;
    expect(t).toContain('#read("/etc/passwd")');
    expect(t).toContain('#eval("1+1")');
  });
});

describe('typst: image sniffing', () => {
  it('accepts exactly the formats Typst decodes', () => {
    expect(isTypstImage(SAMPLE_PNG)).toBe(true);
    expect(isTypstImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isTypstImage(enc.encode('GIF89a......'))).toBe(true);
    expect(isTypstImage(enc.encode('<?xml version="1.0"?><svg xmlns="x"/>'))).toBe(true);
    expect(isTypstImage(new Uint8Array(40))).toBe(false);
    expect(isTypstImage(enc.encode('BM..........................'))).toBe(false);
  });
});
