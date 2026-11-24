import { unzipSync, strToU8, zipSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { ImageMagick, MagickFormat } from '@imagemagick/magick-wasm';
import { expandEdges } from '../../core/graph';
import type { FormatId } from '../../core/formats';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import { initMagick } from '../magick/runtime';
import { decodePng, encodePng, hex, sampleRaster } from '../magick/test-utils';
import { edges } from './edges';
import engine from './engine';

const HOPS = expandEdges(edges.map((e) => ({ ...e, engine: 'mupdf' })));
const hop = (from: FormatId, to: FormatId) => HOPS.find((h) => h.from === from && h.to === to)!;

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
    const lines = p.text ?? [`Hello page ${i + 1} of ${pages.length}`, 'Second line café'];
    const content = `BT /F1 24 Tf 72 ${(p.h ?? 792) - 92} Td ${lines.map((l, k) => `${k ? '0 -40 Td ' : ''}(${l.replace(/[()]/g, '\\$&')}) Tj`).join(' ')} ET`;
    doc.insertPage(-1, doc.addPage([0, 0, p.w ?? 612, p.h ?? 792], 0, res, content));
  });
  return doc.saveToBuffer(save).asUint8Array().slice();
}

/** A page that is only a picture: no selectable text, like a scan. */
function makeScanPdf(): Uint8Array {
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
        strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i + 1}</title></head><body><h1>Chapter ${i + 1}</h1>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Привет мир.</p>'.repeat(40)}</body></html>`),
      ]),
    ),
  });

const run = async (from: FormatId, to: FormatId, input: Uint8Array, options: Record<string, unknown> = {}, name = `doc.${from}`) => {
  const ctx = testContext();
  const res = await engine.convert({ input: blobOf(input), name, from, to, options }, ctx);
  return { res, ctx, out: await bytesOf(res.output) };
};

const pdfText = (pdf: Uint8Array) => {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  return Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('').asText());
};

beforeAll(async () => {
  await initMagick(testContext());
});

describe('edges', () => {
  it('declares exactly the supported matrix', () => {
    const matrix = HOPS.map((h) => `${h.from}->${h.to}`).sort();
    expect(matrix).toEqual(['epub->pdf', 'epub->png', 'pdf->html', 'pdf->jpg', 'pdf->png', 'pdf->svg', 'pdf->txt']);
  });

  it('marks per-page outputs as bundling and whole-document outputs as not', () => {
    for (const to of ['png', 'jpg', 'svg'] as const) expect(hop('pdf', to).mayBundle, to).toBe(true);
    expect(hop('epub', 'png').mayBundle).toBe(true);
    for (const to of ['txt', 'html'] as const) expect(hop('pdf', to).mayBundle).toBe(false);
    expect(hop('epub', 'pdf').mayBundle).toBe(false);
  });

  it('lists stages the engine really reports', () => {
    expect(hop('pdf', 'png').stages.map((s) => s.id)).toEqual(['load', 'decode', 'encode', 'package']);
    expect(hop('pdf', 'txt').stages.map((s) => s.id)).toEqual(['load', 'decode', 'encode']);
    expect(hop('pdf', 'png').stages[0]!.label).toBe('Load MuPDF 1.28');
    expect(hop('pdf', 'png').fidelity).toBe('raster');
    expect(hop('pdf', 'txt').fidelity).toBe('semantic');
    expect(hop('epub', 'pdf').fidelity).toBe('semantic');
  });
});

describe('pdf -> png / jpg', () => {
  const three = makePdf([{ w: 612, h: 792 }, { w: 400, h: 300 }, { w: 612, h: 792 }]);

  it('several pages become a ZIP with one PNG per page at 150 dpi', async () => {
    const { res, ctx, out } = await run('pdf', 'png', three, {}, 'My Report.pdf');
    expect(res.ext).toBe('zip');
    expect(res.bundle).toEqual({ count: 3, ext: 'png' });
    expect(res.mime).toBe('application/zip');
    expect(res.output).toBeInstanceOf(Blob);
    const files = unzipSync(out);
    expect(Object.keys(files)).toEqual(['My Report-1.png', 'My Report-2.png', 'My Report-3.png']);
    const dims = Object.values(files).map((f) => {
      const p = decodePng(f);
      return [p.width, p.height];
    });
    expect(dims).toEqual([[1275, 1650], [834, 625], [1275, 1650]]);
    // page content is really drawn: dark text pixels exist on a white page
    const p1 = decodePng(files['My Report-1.png']!);
    const dark = p1.rgba.reduce((n, v, i) => n + (i % 4 === 0 && v < 100 ? 1 : 0), 0);
    expect(dark).toBeGreaterThan(500);
    expect(Array.from(p1.rgba.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(ctx.stages).toEqual(['load', 'decode', 'encode', 'package']);
    expect(ctx.progressValues).toEqual([1 / 3, 2 / 3, 1]);
  });

  it('a single page is returned as one plain PNG, not a ZIP', async () => {
    const { res, out } = await run('pdf', 'png', makePdf([{}]));
    expect(res.ext).toBe('png');
    expect(res.bundle).toBeUndefined();
    expect(hex(out, 4)).toBe('89504e47');
    expect(decodePng(out).width).toBe(1275);
  });

  it('honours the dpi option (clamped to 36..600)', async () => {
    const one = makePdf([{}]);
    expect(decodePng((await run('pdf', 'png', one, { dpi: 72 })).out).width).toBe(612);
    expect(decodePng((await run('pdf', 'png', one, { dpi: 1 })).out).width).toBe(306); // 36 dpi floor
    expect(decodePng((await run('pdf', 'png', makePdf([{ w: 100, h: 100 }]), { dpi: 9999 })).out).width).toBe(834); // 600 dpi cap
  });

  it('jpg: baseline JPEG per page, quality 90', async () => {
    const { res, out } = await run('pdf', 'jpg', three);
    const files = unzipSync(out);
    expect(Object.keys(files)).toEqual(['doc-1.jpg', 'doc-2.jpg', 'doc-3.jpg']);
    expect(res.bundle).toEqual({ count: 3, ext: 'jpg' });
    for (const f of Object.values(files)) expect(hex(f, 3)).toBe('ffd8ff');
    const sizes = ImageMagick.read(files['doc-2.jpg']!, (i) => [i.width, i.height, i.quality]);
    expect(sizes).toEqual([834, 625, 90]);
  });

  it('pads page numbers to the page count width', async () => {
    const twelve = makePdf(Array.from({ length: 12 }, () => ({ w: 50, h: 50, text: ['x'] })));
    const names = Object.keys(unzipSync((await run('pdf', 'png', twelve, { dpi: 36 })).out));
    expect(names[0]).toBe('doc-01.png');
    expect(names[11]).toBe('doc-12.png');
  });

  it('sanitises path characters in names inside the ZIP', async () => {
    const names = Object.keys(unzipSync((await run('pdf', 'png', three, { dpi: 36 }, '../evil/..\\name:x.pdf')).out));
    expect(names.every((n) => !n.includes('/') && !n.includes('\\') && !n.includes(':'))).toBe(true);
  });

  it('reports pages facts and a thumbnail of page 1', async () => {
    const { ctx } = await run('pdf', 'png', three, { dpi: 36 });
    expect(ctx.factsSeen[0]).toEqual({ kind: 'pages', pages: 3, width: 612, height: 792 });
    const p = ctx.previews[0]!;
    if (p.kind !== 'pixels') throw new Error('pixels');
    expect([p.width, p.height]).toEqual([75, 96]);
    expect(p.rgba.length).toBe(75 * 96 * 4);
    expect(Array.from(p.rgba.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(p.rgba.some((v, i) => i % 4 === 0 && v < 128)).toBe(true); // some text ink
  });
});

describe('pdf -> svg', () => {
  it('draws each page as a self-contained SVG', async () => {
    const { out, res } = await run('pdf', 'svg', makePdf([{}, {}]));
    expect(res.bundle).toEqual({ count: 2, ext: 'svg' });
    const files = unzipSync(out);
    const svg = new TextDecoder().decode(files['doc-1.svg']!);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 612 792"|width="612pt"|width="612"/);
    expect(svg).toMatch(/<path|<text|<use/);
    const refs = [...svg.matchAll(/(?:href|src)="(?!#|data:)([^"]+)"/g)].map((m) => m[1]);
    expect(refs).toEqual([]);
  });

  it('a single page is one .svg file', async () => {
    const { res, out } = await run('pdf', 'svg', makePdf([{}]));
    expect(res.ext).toBe('svg');
    expect(new TextDecoder().decode(out.slice(0, 4))).toBe('<svg');
  });
});

describe('pdf -> txt / html', () => {
  const doc = makePdf([{ text: ['First page', 'caf\\351 au lait'] }, { text: ['Second page here'] }]);

  it('extracts the text of every page into one file', async () => {
    const { res, out, ctx } = await run('pdf', 'txt', doc);
    expect(res.ext).toBe('txt');
    const text = new TextDecoder().decode(out);
    expect(text).toContain('First page');
    expect(text).toContain('café au lait');
    expect(text).toContain('Second page here');
    expect(text.indexOf('First page')).toBeLessThan(text.indexOf('Second page here'));
    expect(ctx.stages).toEqual(['load', 'decode', 'encode']);
    expect(ctx.progressValues).toEqual([0.5, 1]);
  });

  it('html keeps text positions, has no external references and escapes the title', async () => {
    const { res, out } = await run('pdf', 'html', doc, {}, '<b>x</b>.pdf');
    expect(res.ext).toBe('html');
    const html = new TextDecoder().decode(out);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('First page');
    expect(html).toContain('Second page here');
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/<div id="page0"/);
    expect(html).toMatch(/<div id="page1"/);
  });

  it('says so when there is no text (scanned PDF) instead of returning an empty file', async () => {
    const scan = makeScanPdf();
    await expect(run('pdf', 'txt', scan)).rejects.toThrow(/No selectable text.*OCR is not available/);
    await expect(run('pdf', 'html', scan)).rejects.toThrow(/No selectable text/);
    // ...but rasterising a scan works
    const png = decodePng((await run('pdf', 'png', scan)).out);
    expect([png.width, png.height]).toEqual([417, 313]);
    expect(png.rgba.some((v, i) => i % 4 === 0 && v < 120)).toBe(true);
  });
});

describe('epub', () => {
  it('epub -> pdf typesets real pages with extractable text', async () => {
    const { res, out, ctx } = await run('epub', 'pdf', epub());
    expect(res.ext).toBe('pdf');
    expect(Buffer.from(out.slice(0, 5)).toString()).toBe('%PDF-');
    const pages = pdfText(out);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]).toContain('Chapter 1');
    expect(pages.join('\n')).toContain('Chapter 2');
    expect(pages.join('\n')).toContain('Привет мир'); // Cyrillic uses the built-in font
    const [x0, y0, x1, y1] = mupdf.Document.openDocument(out, 'application/pdf').loadPage(0).getBounds();
    expect([x1 - x0, y1 - y0]).toEqual([420, 595]);
    expect(ctx.factsSeen[0]).toMatchObject({ kind: 'pages', width: 420, height: 595 });
    expect(ctx.progressValues.at(-1)).toBe(1);
  });

  it('epub -> png returns a ZIP of page images', async () => {
    const { res, out } = await run('epub', 'png', epub(1), { dpi: 72 });
    expect(res.bundle!.ext).toBe('png');
    const files = unzipSync(out);
    expect(Object.keys(files).length).toBe(res.bundle!.count);
    expect(decodePng(Object.values(files)[0]!).width).toBe(420);
  });
});

describe('limits and hostile input', () => {
  it('rejects more than 500 pages with the count in the message, before rendering', async () => {
    const big = makePdf(Array.from({ length: 501 }, () => ({ w: 20, h: 20, text: ['x'] })));
    const t = performance.now();
    await expect(run('pdf', 'png', big)).rejects.toThrow(/501 pages; the limit is 500/);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('accepts exactly 500 pages', async () => {
    const edge = makePdf(Array.from({ length: 500 }, () => ({ w: 20, h: 20, text: ['x'] })));
    const { res, ctx } = await run('pdf', 'png', edge, { dpi: 36 });
    expect(res.bundle).toEqual({ count: 500, ext: 'png' });
    expect(ctx.progressValues.length).toBe(500);
    expect(ctx.progressValues.at(-1)).toBe(1);
  }, 120_000);

  it('renders oversize pages at a reduced scale instead of exhausting memory', async () => {
    const poster = makePdf([{ w: 7000, h: 7000, text: ['big'] }]);
    const { out, ctx } = await run('pdf', 'png', poster, { dpi: 150 });
    const p = decodePng(out);
    expect(p.width * p.height).toBeLessThanOrEqual(100_000_000);
    expect(p.width).toBe(p.height);
    expect(p.width).toBeGreaterThan(9000);
    expect(ctx.logs.join(' ')).toMatch(/rendered at a lower scale/);
  }, 120_000);

  it('password-protected PDFs: clear error, or open with the password option', async () => {
    const locked = makePdf([{}], 'encrypt=aes-128,user-password=secret,owner-password=owner');
    await expect(run('pdf', 'png', locked)).rejects.toThrow(/password-protected/);
    await expect(run('pdf', 'png', locked, { password: 'wrong' })).rejects.toThrow(/password-protected/);
    const ok = await run('pdf', 'png', locked, { password: 'secret', dpi: 36 });
    expect(decodePng(ok.out).width).toBe(306);
  });

  it('rejects garbage, empty and mislabelled files with readable messages', async () => {
    await expect(run('pdf', 'png', new Uint8Array(0))).rejects.toThrow(/empty/);
    await expect(run('pdf', 'png', new Uint8Array(2000).fill(65))).rejects.toThrow(/PDF/);
    await expect(run('pdf', 'png', encodePng(sampleRaster(10, 10)))).rejects.toThrow(/not a PDF/); // images are not documents here
    await expect(run('epub', 'pdf', makePdf([{}]))).rejects.toThrow(/not an EPUB/);
    await expect(run('epub', 'pdf', zipSync({ 'a.txt': strToU8('hi') }))).rejects.toThrow(/EPUB/);
  });

  it('survives a truncated PDF without crashing the worker (repairs or errors)', async () => {
    const pdf = makePdf([{}, {}, {}]);
    const cut = pdf.slice(0, Math.floor(pdf.length * 0.6));
    const r = await run('pdf', 'txt', cut).then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, e }),
    );
    expect(r.ok || /PDF|text|damaged|Could not/i.test(r.e.message)).toBe(true);
  });
});

describe('assets', () => {
  it('loads the wasm through ctx.fetchAsset only (no network)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = testContext();
    await engine.convert({ input: blobOf(makePdf([{}])), name: 'a.pdf', from: 'pdf', to: 'png', options: {} }, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // initialised once per worker; the first file-level context fetched it
    expect(ctx.stages[0]).toBe('load');
  });
});
