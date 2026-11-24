import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type * as MuPdf from 'mupdf';
// A relative path (not the bare "mupdf/dist/..." specifier) because the package's
// `exports` map does not expose the wasm file. Vite emits it as a hashed asset.
import wasmUrl from '../../../node_modules/mupdf/dist/mupdf-wasm.wasm?url';
import { formatInfo, type FormatId } from '../../core/formats';
import type { ConvertRequest, ConvertResult, Engine, EngineContext } from '../../core/types';
import {
  DEFAULT_DPI,
  EPUB_PAGE,
  MAX_DPI,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_PAGES,
  MAX_PAGES_TYPESET,
  MAX_PIXELS,
  MAX_SIDE_PX,
  MIN_DPI,
} from './meta';

type Mupdf = typeof MuPdf;

let mupdfReady: Promise<Mupdf> | null = null;
let current: EngineContext | null = null;

/**
 * mupdf's glue reads `globalThis.$libmupdf_wasm_Module` before it starts, so
 * the wasm bytes we downloaded through ctx.fetchAsset go straight in as
 * `wasmBinary`: the library never fetches anything itself.
 */
function loadMupdf(ctx: EngineContext): Promise<Mupdf> {
  current = ctx;
  mupdfReady ??= (async () => {
    const wasmBinary = await ctx.fetchAsset(wasmUrl);
    (globalThis as Record<string, unknown>).$libmupdf_wasm_Module = {
      wasmBinary,
      print: () => {},
      printErr: (m: unknown) => current?.log(String(m)),
    };
    return (await import('mupdf')) as Mupdf;
  })().catch((e) => {
    mupdfReady = null;
    throw e;
  });
  return mupdfReady;
}

const MAGIC: Record<string, string> = { pdf: 'application/pdf', epub: 'application/epub+zip' };

const fileBase = (name: string) => {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return (base || 'document').slice(0, 100);
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function explain(err: unknown, from: FormatId): Error {
  if (err instanceof Error && (err as Error & { userFacing?: boolean }).userFacing) return err;
  const raw = err instanceof Error ? err.message : String(err);
  if (/out of memory|memory access|OOM|Aborted|allocation/i.test(raw)) {
    return new Error('This document is too large or too complex to convert in the browser. Try a lower DPI or fewer pages.');
  }
  if (/password|encrypted/i.test(raw)) return new Error('This file is password-protected. Remove the password and try again.');
  if (/cannot recognize|unsupported|format error|cannot find|trailer|startxref|invalid|syntax|zip|corrupt/i.test(raw)) {
    return new Error(`This ${from.toUpperCase()} file looks damaged or is not a ${from.toUpperCase()} (${raw.replace(/^Error:\s*/, '')}).`);
  }
  return new Error(`Could not convert this ${from.toUpperCase()}: ${raw.replace(/^Error:\s*/, '')}`);
}

const userError = (msg: string) => Object.assign(new Error(msg), { userFacing: true });

function dpiOption(options: Readonly<Record<string, unknown>>): number {
  const v = Number(options.dpi);
  return Number.isFinite(v) && v > 0 ? Math.min(MAX_DPI, Math.max(MIN_DPI, v)) : DEFAULT_DPI;
}

/** Pixels per point for one page, reduced if the page would exceed the pixel limits. */
function scaleFor(width: number, height: number, dpi: number): { scale: number; clamped: boolean } {
  let scale = dpi / 72;
  const w = width * scale;
  const h = height * scale;
  let clamped = false;
  const k = Math.min(1, MAX_SIDE_PX / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  if (k < 1) {
    scale *= k * 0.999;
    clamped = true;
  }
  return { scale, clamped };
}

/** Collects entries into a ZIP without keeping a second copy of every page. */
class ZipBuilder {
  private chunks: Uint8Array[] = [];
  private zip: Zip;
  private done = false;
  size = 0;
  constructor() {
    this.zip = new Zip((err, chunk) => {
      if (err) throw err;
      this.chunks.push(chunk);
      this.size += chunk.length;
    });
  }
  add(name: string, data: Uint8Array, compress: boolean) {
    const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    this.zip.add(f);
    f.push(data, true);
  }
  finish(): Blob {
    if (!this.done) this.zip.end();
    this.done = true;
    return new Blob(this.chunks as BlobPart[], { type: 'application/zip' });
  }
}

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  const { from, to } = req;
  if (from !== 'pdf' && from !== 'epub') throw new Error(`MuPDF cannot read ${from}.`);

  ctx.stage('load');
  const mupdf = await loadMupdf(ctx);

  ctx.stage('decode');
  if (req.input.size === 0) throw new Error('The file is empty.');
  if (req.input.size > MAX_INPUT_BYTES) throw new Error(`The file is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB.`);
  const bytes = new Uint8Array(await req.input.arrayBuffer());
  // mupdf sniffs content and would happily open images, XPS, HTML... as "documents". Only take what was promised.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (from === 'pdf' && !head.includes('%PDF-')) throw new Error('This file is not a PDF: it has no %PDF header.');
  if (from === 'epub' && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('This file is not an EPUB: an EPUB is a ZIP archive.');

  const dpi = dpiOption(req.options);
  const info = formatInfo(to);
  let doc: InstanceType<Mupdf['Document']> | undefined;
  try {
    doc = mupdf.Document.openDocument(bytes, MAGIC[from]);
    if (from === 'epub' && doc.isPDF()) throw userError('This file is not an EPUB.');
    if (doc.needsPassword()) {
      const pw = typeof req.options.password === 'string' ? req.options.password : '';
      if (!pw || !doc.authenticatePassword(pw)) throw userError('This file is password-protected. Remove the password and try again.');
    }
    if (from === 'epub') doc.layout(EPUB_PAGE.width, EPUB_PAGE.height, EPUB_PAGE.fontSize);
    const count = doc.countPages();
    if (count < 1) throw userError('This document has no pages.');
    const cap = to === 'pdf' ? MAX_PAGES_TYPESET : MAX_PAGES;
    if (count > cap) throw userError(`This document has ${count} pages; the limit is ${cap}. Split it into smaller files first.`);

    const first = doc.loadPage(0);
    const [x0, y0, x1, y1] = first.getBounds();
    const pageW = x1 - x0;
    const pageH = y1 - y0;
    ctx.facts({ kind: 'pages', pages: count, width: Math.round(pageW), height: Math.round(pageH) });
    {
      const k = Math.min(1, 96 / Math.max(pageW, pageH));
      const pix = first.toPixmap(mupdf.Matrix.scale(k, k), mupdf.ColorSpace.DeviceRGB, false, true);
      const w = pix.getWidth();
      const h = pix.getHeight();
      const n = pix.getNumberOfComponents();
      const stride = pix.getStride();
      const src = pix.getPixels();
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = y * stride + x * n;
          const d = (y * w + x) * 4;
          rgba[d] = src[s]!;
          rgba[d + 1] = src[s + 1]!;
          rgba[d + 2] = src[s + 2]!;
          rgba[d + 3] = 255;
        }
      }
      ctx.preview({ kind: 'pixels', width: w, height: h, rgba });
      pix.destroy();
    }
    first.destroy();

    ctx.stage('encode');
    const done = (i: number) => ctx.progress((i + 1) / count); // pages finished / pages total
    const pageNo = (i: number) => String(i + 1).padStart(String(count).length, '0');
    const base = fileBase(req.name);

    // ---- one document-wide text/html file
    if (to === 'txt' || to === 'html') {
      const parts: string[] = [];
      let chars = 0;
      for (let i = 0; i < count; i++) {
        const page = doc.loadPage(i);
        const st = page.toStructuredText('preserve-whitespace');
        const piece = to === 'txt' ? st.asText() : st.asHTML(i);
        chars += piece.length;
        parts.push(piece);
        st.destroy();
        page.destroy();
        if (chars * 2 > MAX_OUTPUT_BYTES) throw userError('The extracted text is too large to hold in the browser.');
        done(i);
      }
      let text: string;
      if (to === 'txt') {
        text = parts.map((p) => p.replace(/\s+$/, '')).filter(Boolean).join('\n\n');
        if (!text.trim()) throw userError('No selectable text was found. This looks like a scan or image-only document, and OCR is not available.');
        text += '\n';
      } else {
        if (!parts.some((p) => /<span/.test(p))) throw userError('No selectable text was found. This looks like a scan or image-only document, and OCR is not available.');
        const title = doc.getMetaData('info:Title') || base;
        text =
          `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n` +
          `<style>body{margin:0;background:#888}div[id^=page]{position:relative;margin:12px auto;background:#fff;overflow:hidden}p{position:absolute;margin:0;white-space:pre}</style></head>\n` +
          `<body>\n${parts.join('\n')}\n</body></html>\n`;
      }
      return { output: new TextEncoder().encode(text), ext: info.exts[0]!, mime: info.mime };
    }

    // ---- EPUB -> PDF
    if (to === 'pdf') {
      const buf = new mupdf.Buffer();
      const writer = new mupdf.DocumentWriter(buf, 'pdf', '');
      for (let i = 0; i < count; i++) {
        const page = doc.loadPage(i);
        const dev = writer.beginPage(page.getBounds());
        page.run(dev, mupdf.Matrix.identity);
        writer.endPage();
        dev.destroy();
        page.destroy();
        done(i);
      }
      writer.close();
      const out = buf.asUint8Array().slice();
      writer.destroy();
      buf.destroy();
      return { output: out, ext: info.exts[0]!, mime: info.mime };
    }

    // ---- one image / drawing per page
    const files: { name: string; data: Uint8Array }[] = [];
    const zip = count > 1 ? new ZipBuilder() : null;
    let held = 0;
    let clamped = 0;
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      let data: Uint8Array;
      if (to === 'svg') {
        const buf = new mupdf.Buffer();
        const writer = new mupdf.DocumentWriter(buf, 'svg', '');
        const dev = writer.beginPage(page.getBounds());
        page.run(dev, mupdf.Matrix.identity);
        writer.endPage();
        writer.close();
        data = buf.asUint8Array().slice();
        dev.destroy();
        writer.destroy();
        buf.destroy();
      } else {
        const [a, b, c, d] = page.getBounds();
        const { scale, clamped: was } = scaleFor(c - a, d - b, dpi);
        if (was) clamped++;
        const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        data = (to === 'png' ? pix.asPNG() : pix.asJPEG(90, false)).slice();
        pix.destroy();
      }
      page.destroy();
      held += data.length;
      if (held > MAX_OUTPUT_BYTES) throw userError(`The pages add up to more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB. Try a lower DPI or convert fewer pages.`);
      const name = `${base}-${pageNo(i)}.${info.exts[0]}`;
      if (zip) zip.add(name, data, to === 'svg');
      else files.push({ name, data });
      done(i);
    }
    if (clamped) ctx.log(`${clamped} page(s) were larger than ${MAX_SIDE_PX} px or ${MAX_PIXELS / 1e6} MP at ${dpi} dpi and were rendered at a lower scale.`);

    ctx.stage('package');
    if (zip) {
      const blob = zip.finish();
      return { output: blob, ext: 'zip', mime: formatInfo('zip').mime, bundle: { count, ext: info.exts[0]! } };
    }
    return { output: files[0]!.data, ext: info.exts[0]!, mime: info.mime };
  } catch (err) {
    throw explain(err, from);
  } finally {
    doc?.destroy();
  }
}

export default { convert } satisfies Engine;
