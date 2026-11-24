import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { MagickFormat } from '@imagemagick/magick-wasm';
import * as mupdf from 'mupdf';
import { expandEdges } from '../../src/core/graph';
import { formatInfo, type FormatId } from '../../src/core/formats';
import { edges } from '../../src/engines/magick/edges';
import { READABLE, WRITABLE } from '../../src/engines/magick/meta';
import {
  assetEvents,
  decodeFrames,
  encodeAnimation,
  encodeRaster,
  initNodeMagick,
  nativeDecode,
  progressValues,
  retryOnReload,
  stageIds,
} from '../../src/engines/magick/e2e-support';
import {
  bombPng,
  compare,
  decodePng,
  encodePng,
  hugeCanvasGif,
  overWhite,
  sampleRaster,
  smoothAlphaRaster,
  smoothRaster,
  solidRaster,
  withExifOrientation,
  type Raster,
} from '../../src/engines/magick/test-utils';
import { convert, openHarness } from './helpers';

const HOPS = expandEdges(edges.map((e) => ({ ...e, engine: 'magick' })));
const hop = (from: FormatId, to: FormatId) => HOPS.find((h) => h.from === from && h.to === to)!;
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const MAGICS: Record<string, RegExp> = {
  png: /^89504e47/, jpg: /^ffd8ff/, webp: /^52494646.{8}57454250/, avif: /^.{8}66747970617669/, jxl: /^(ff0a|0000000c4a584c20)/,
  gif: /^47494638/, tiff: /^(49492a00|4d4d002a)/, bmp: /^424d/, ico: /^00000100/, pdf: /^255044462d/,
};
const hexHead = (b: Uint8Array) => Buffer.from(b.subarray(0, 16)).toString('hex');

const base = sampleRaster(96, 64);
const sources = new Map<FormatId, Uint8Array>();

async function run(page: Page, from: FormatId, to: FormatId, input: Uint8Array, extra: Record<string, unknown> = {}) {
  return retryOnReload(() => openHarness(page), () => convert(page, { from, to, engine: 'magick', base64: b64(input), name: `in.${from}`, ...extra }));
}

test.describe('magick engine in a real browser', () => {
  test.beforeAll(async () => {
    await initNodeMagick();
    // Inputs are made by stock ImageMagick in Node, not by the engine under test.
    const FMT: Record<string, MagickFormat> = {
      jpg: MagickFormat.Jpeg, webp: MagickFormat.WebP, avif: MagickFormat.Avif, jxl: MagickFormat.Jxl, gif: MagickFormat.Gif,
      tiff: MagickFormat.Tiff, bmp: MagickFormat.Bmp3, ico: MagickFormat.Ico, psd: MagickFormat.Psd,
    };
    // Lossless containers get the noisy image (exactness); lossy ones the smooth one (small, meaningful error).
    const LOSSY = new Set(['jpg', 'webp', 'avif', 'jxl']);
    sources.set('png', encodePng(base));
    for (const [id, fmt] of Object.entries(FMT)) {
      const img = LOSSY.has(id) ? smoothAlphaRaster() : base;
      sources.set(id as FormatId, encodeRaster(id === 'jpg' || id === 'bmp' ? overWhite(img) : img, fmt));
    }
    sources.set('heic', new Uint8Array(readFileSync('src/engines/magick/fixtures/sample.heic')));
  });

  test.beforeEach(async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
    });
    (page as unknown as { __external: string[] }).__external = external;
    await retryOnReload(() => page.waitForTimeout(300), () => openHarness(page));
  });
  test.afterEach(async ({ page }) => {
    expect((page as unknown as { __external: string[] }).__external).toEqual([]);
  });

  test('downloads the 32-bit wasm through ctx.fetchAsset with exact byte progress', async ({ page }) => {
    const r = await run(page, 'png', 'jpg', encodePng(base));
    expect(r.ok).toBe(true);
    const a = assetEvents(r.events);
    expect(a.length).toBeGreaterThan(2);
    expect(new Set(a.map((e) => e.url)).size).toBe(1);
    expect(a[0]!.url).toMatch(/magick[\w.-]*\.wasm$/); // dev: node_modules path, build: hashed asset
    const size = readFileSync('node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm').length;
    expect(a[0]!.loaded).toBe(0);
    expect(a.at(-1)!.loaded).toBe(size);
    expect(a.every((e) => e.total === size)).toBe(true);
    for (let i = 1; i < a.length; i++) expect(a[i]!.loaded).toBeGreaterThanOrEqual(a[i - 1]!.loaded);
    test.info().annotations.push({ type: 'asset', description: `magick.wasm ${size} bytes` });
  });

  for (const from of READABLE) {
    test(`every target from ${from}`, async ({ page }) => {
      const input = sources.get(from)!;
      const ref = decodeFrames(input, from === 'ico' ? MagickFormat.Ico : undefined)[0]!.raster; // what the source really contains
      const flat = overWhite(ref);
      for (const to of WRITABLE) {
        if (to === from) continue;
        const r = await run(page, from, to as FormatId, input);
        expect(r.ok, `${from}->${to}: ${r.error}`).toBe(true);
        expect(r.route).toEqual([`magick:${from}->${to}`]);
        const out = unb64(r.base64);
        expect(hexHead(out), `${from}->${to} magic`).toMatch(MAGICS[to]!);
        expect(r.ext).toBe(formatInfo(to as FormatId).exts[0]);
        expect(stageIds(r.events), `${from}->${to} stages`).toEqual(hop(from, to as FormatId).stages.map((s) => s.id));

        const facts = r.events.find((e: { type: string }) => e.type === 'facts');
        expect(facts.facts).toMatchObject({ kind: 'raster', width: ref.width, height: ref.height, frames: 1 });
        const prev = r.events.find((e: { type: string }) => e.type === 'preview').preview;
        expect(prev.kind).toBe('pixels');
        expect(Math.max(prev.width, prev.height)).toBeLessThanOrEqual(96);

        if (to === 'pdf') {
          const doc = mupdf.Document.openDocument(out, 'application/pdf');
          expect(doc.countPages()).toBe(1);
          const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
          expect([pix.getWidth(), pix.getHeight()]).toEqual([ref.width, ref.height]);
          const px = pix.getPixels();
          const got: Raster = { width: ref.width, height: ref.height, rgba: new Uint8Array(ref.width * ref.height * 4) };
          for (let i = 0; i < ref.width * ref.height; i++) got.rgba.set([px[i * 3]!, px[i * 3 + 1]!, px[i * 3 + 2]!, 255], i * 4);
          const d = compare(flat, got);
          if (hop(from, 'pdf').fidelity === 'lossless') expect(d.max, `${from}->pdf`).toBeLessThanOrEqual(1);
          else expect(d.mean, `${from}->pdf`).toBeLessThan(12);
          continue;
        }

        const dec = decodeFrames(out, to === 'ico' ? MagickFormat.Ico : undefined)[0]!.raster;
        expect([dec.width, dec.height]).toEqual([ref.width, ref.height]);
        const hasAlpha = !['jpg', 'bmp'].includes(to);
        const want = hasAlpha ? ref : flat;
        const d = compare(want, dec);
        const fid = hop(from, to as FormatId).fidelity;
        if (to === 'png' || to === 'tiff' || fid === 'lossless') expect(d.max, `${from}->${to} exact`).toBe(0);
        else if (to === 'gif') expect(d.mean, `${from}->gif`).toBeLessThan(40);
        else expect(d.mean, `${from}->${to} mean`).toBeLessThan(['jpg', 'webp', 'avif', 'jxl', 'heic'].includes(from) ? 8 : 16);

        if (to === 'png') {
          // independent hand-written decoder agrees with ImageMagick's reading of the same bytes
          expect(compare(dec, decodePng(out)).max).toBe(0);
        }
        // Whatever the browser itself can decode must match what we encoded.
        const mime = formatInfo(to as FormatId).mime;
        if (['png', 'jpg', 'webp', 'gif', 'bmp', 'avif'].includes(to)) {
          const native = await nativeDecode(page, out, mime);
          if (native) {
            expect([native.width, native.height]).toEqual([dec.width, dec.height]);
            // Browsers and ImageMagick differ in what colour sits under fully transparent pixels, and WebKit
            // returns premultiplied values for partial alpha: compare over white, on pixels that are not partly transparent.
            const nd = compare(overWhite(solidOnly(dec)), overWhite(solidOnly(dec, native)));
            expect(nd.mean, `${from}->${to} browser decode`).toBeLessThan(to === 'jpg' || to === 'avif' ? 12 : 1.5);
          }
        }
      }
    });
  }
});

/** Copy of `of` (or of `values`' pixels) keeping only pixels that are fully opaque or fully transparent in `of`; partly transparent ones become white. */
function solidOnly(of: Raster, values: Raster = of): Raster {
  const out = new Uint8Array(of.rgba.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = of.rgba[i + 3]!;
    if (a === 0 || a === 255) out.set(values.rgba.subarray(i, i + 4), i);
    else out.set([255, 255, 255, 255], i);
  }
  return { width: of.width, height: of.height, rgba: out };
}

test.describe('behaviour in a real browser', () => {
  test.beforeAll(async () => {
    await initNodeMagick();
  });
  test.beforeEach(async ({ page }) => {
    await retryOnReload(() => page.waitForTimeout(300), () => openHarness(page));
  });

  test('HEIC (HEVC, hardware-independent wasm decode) -> png/jpg/webp', async ({ page }) => {
    const heic = new Uint8Array(readFileSync('src/engines/magick/fixtures/sample.heic'));
    const r = await run(page, 'heic', 'png', heic);
    expect(r.ok, r.error).toBe(true);
    const png = decodePng(unb64(r.base64));
    expect([png.width, png.height]).toEqual([128, 96]);
    expect(compare(smoothRaster(), png).mean).toBeLessThan(6);
    expect(stageIds(r.events)).toEqual(['load', 'decode', 'encode']);
    for (const to of ['jpg', 'webp'] as const) {
      const o = await run(page, 'heic', to, heic);
      expect(o.ok, o.error).toBe(true);
      expect(decodeFrames(unb64(o.base64))[0]!.raster.width).toBe(128);
    }
  });

  test('animated GIF <-> WebP keeps frames and timing; first frame only for png', async ({ page }) => {
    const frames = [[255, 0, 0], [0, 255, 0], [0, 0, 255]].map(([r, g, b]) => solidRaster(40, 30, [r!, g!, b!, 255]));
    const gif = encodeAnimation(frames, [10, 20, 30], MagickFormat.Gif);
    const w = await run(page, 'gif', 'webp', gif);
    expect(w.ok, w.error).toBe(true);
    const wf = decodeFrames(unb64(w.base64));
    expect(wf.map((f) => f.delay)).toEqual([10, 20, 30]);
    expect(wf.map((f) => Array.from(f.raster.rgba.slice(0, 3)))).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    expect(w.events.find((e: { type: string }) => e.type === 'facts').facts).toMatchObject({ frames: 3, width: 40, height: 30 });
    const g = await run(page, 'webp', 'gif', unb64(w.base64));
    expect(decodeFrames(unb64(g.base64)).map((f) => f.delay)).toEqual([10, 20, 30]);
    const p = await run(page, 'gif', 'png', gif);
    expect(Array.from(decodePng(unb64(p.base64)).rgba.slice(0, 3))).toEqual([255, 0, 0]);
    const pdf = await run(page, 'gif', 'pdf', gif);
    expect(mupdf.Document.openDocument(unb64(pdf.base64), 'application/pdf').countPages()).toBe(3);
    // the worker coalesces progress posts (33 ms), so assert shape, not every step
    const prog = progressValues(pdf.events);
    expect(prog.length).toBeGreaterThan(0);
    expect(prog.at(-1)).toBe(1);
    expect(prog.every((v: number, i: number) => v > 0 && v <= 1 && (i === 0 || v >= prog[i - 1]!))).toBe(true);
  });

  test('applies EXIF orientation', async ({ page }) => {
    const landscape = sampleRaster(60, 40, false);
    const jpeg = await (async () => {
      const r = await run(page, 'png', 'jpg', encodePng(landscape));
      return withExifOrientation(unb64(r.base64), 6);
    })();
    const r = await run(page, 'jpg', 'png', jpeg);
    const out = decodePng(unb64(r.base64));
    expect([out.width, out.height]).toEqual([40, 60]);
  });

  test('ico: output fits 256, input uses the largest size', async ({ page }) => {
    const r = await run(page, 'png', 'ico', encodePng(sampleRaster(600, 300)));
    expect(r.ok, r.error).toBe(true);
    const d = decodeFrames(unb64(r.base64), MagickFormat.Ico)[0]!.raster;
    expect([d.width, d.height]).toEqual([256, 128]);
    const back = await run(page, 'ico', 'png', unb64(r.base64));
    expect([decodePng(unb64(back.base64)).width, decodePng(unb64(back.base64)).height]).toEqual([256, 128]);
  });

  test('pdf pages are sized from the image and contain it', async ({ page }) => {
    const r = await run(page, 'png', 'pdf', encodePng(sampleRaster(2000, 1000, false)));
    expect(r.ok, r.error).toBe(true);
    const p = mupdf.Document.openDocument(unb64(r.base64), 'application/pdf').loadPage(0).getBounds();
    expect(p[2]! - p[0]!).toBeLessThanOrEqual(842.5);
    expect((p[2]! - p[0]!) / (p[3]! - p[1]!)).toBeCloseTo(2, 1);
  });

  test('rejects hostile and broken input with clear messages (no hang)', async ({ page }) => {
    const bomb = await run(page, 'png', 'jpg', bombPng(12000, 12000));
    expect(bomb.ok).toBe(false);
    expect(bomb.error).toMatch(/12000 × 12000 px.*limit is 16384 px per side and 100 megapixels/);
    const wide = await run(page, 'png', 'jpg', bombPng(20000, 10));
    expect(wide.error).toMatch(/20000 × 10 px/);
    const cut = await run(page, 'png', 'jpg', encodePng(base).slice(0, 500));
    expect(cut.ok).toBe(false);
    expect(cut.error).toMatch(/damaged|incomplete|Could not read/);
    const junk = await run(page, 'png', 'jpg', new Uint8Array(300).fill(9));
    expect(junk.error).toMatch(/doesn't look like an image/);
    const svg = await run(page, 'png', 'jpg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>'));
    expect(svg.error).toMatch(/doesn't look like an image/);
  });

  test('memory budget across frames is enforced before decoding', async ({ page }) => {
    const r = await run(page, 'gif', 'webp', hugeCanvasGif(8000, 3));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/3 frames add up to 192 megapixels; the limit is 128 megapixels/);
    const single = await run(page, 'gif', 'bmp', hugeCanvasGif(2000, 3));
    expect(single.ok, single.error).toBe(true);
  });

  test('inputs encoded by the browser itself (canvas JPEG/WebP/PNG) convert correctly', async ({ page, browserName }) => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      const enc = await page.evaluate(async ([type]) => {
        const c = new OffscreenCanvas(64, 48);
        const g = c.getContext('2d')!;
        const grad = g.createLinearGradient(0, 0, 64, 0);
        grad.addColorStop(0, '#ff0000');
        grad.addColorStop(1, '#0000ff');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 48);
        const blob = await c.convertToBlob({ type: type!, quality: 0.95 });
        if (blob.type !== type) return null; // this browser cannot encode it
        const u8 = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return btoa(s);
      }, [mime]);
      if (!enc) {
        test.info().annotations.push({ type: 'skip', description: `${browserName} cannot encode ${mime}` });
        continue;
      }
      const from = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const)[mime as 'image/png']!;
      const r = await run(page, from, from === 'png' ? 'bmp' : 'png', unb64(enc));
      expect(r.ok, `${mime}: ${r.error}`).toBe(true);
      const out = from === 'png' ? decodeFrames(unb64(r.base64))[0]!.raster : decodePng(unb64(r.base64));
      expect([out.width, out.height]).toEqual([64, 48]);
      expect(out.rgba[0]!).toBeGreaterThan(235); // left edge red
      expect(out.rgba[2]!).toBeLessThan(25);
      expect(out.rgba[(63) * 4]!).toBeLessThan(25); // right edge blue
      expect(out.rgba[(63) * 4 + 2]!).toBeGreaterThan(235);
    }
  });

  test('a 36-megapixel photo-sized image converts, or fails with the clear size message (never a crash)', async ({ page, browserName }) => {
    test.setTimeout(240_000);
    const w = 6000;
    const h = 6000;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = (x >> 5) & 255;
        rgba[i + 1] = (y >> 5) & 255;
        rgba[i + 2] = ((x >> 7) ^ (y >> 7)) & 255;
        rgba[i + 3] = 255;
      }
    }
    const png = encodePng({ width: w, height: h, rgba });
    const outcome: string[] = [];
    for (const to of ['jpg', 'webp'] as const) {
      const t = Date.now();
      const r = await run(page, 'png', to, png);
      if (r.ok) {
        const d = decodeFrames(unb64(r.base64))[0]!.raster;
        expect([d.width, d.height]).toEqual([w, h]);
        outcome.push(`${to}: ok in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      } else {
        expect(r.error).toMatch(/too large to convert in the browser/);
        outcome.push(`${to}: clean refusal`);
      }
    }
    test.info().annotations.push({ type: '36MP', description: `${browserName}: ${outcome.join(', ')}` });
    console.log(`36MP ${browserName}: ${outcome.join(', ')}`);
  });

  test('default planner routes svg -> jpg through resvg then ImageMagick', async ({ page }) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#2040c0"/></svg>';
    const r = await convert(page, { from: 'svg', to: 'jpg', base64: Buffer.from(svg).toString('base64') });
    expect(r.ok, r.error).toBe(true);
    expect(r.route).toEqual(['resvg:svg->png', 'magick:png->jpg']);
    const d = decodeFrames(unb64(r.base64))[0]!.raster;
    expect([d.width, d.height]).toEqual([1024, 512]);
    expect(Math.abs(d.rgba[(256 * 1024 + 512) * 4]! - 0x20)).toBeLessThan(6);
  });
});

test.describe('resvg engine in a real browser', () => {
  test.beforeEach(async ({ page }) => {
    await retryOnReload(() => page.waitForTimeout(300), () => openHarness(page));
  });

  const svg = (body: string, w = 100, h = 50) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">${body}</svg>`;
  const run2 = (page: Page, doc: string) =>
    retryOnReload(() => openHarness(page), () => convert(page, { from: 'svg', to: 'png', engine: 'resvg', base64: Buffer.from(doc).toString('base64') }));

  test('svg -> png renders at >=1024 px, vector-sharp, with a byte-accurate wasm download', async ({ page }) => {
    const r = await run2(page, svg('<rect x="25" y="10" width="50" height="30" fill="#0a8040"/>'));
    expect(r.ok, r.error).toBe(true);
    const p = decodePng(unb64(r.base64));
    expect([p.width, p.height]).toEqual([1024, 512]);
    const px = (x: number, y: number) => Array.from(p.rgba.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
    expect(px(512, 256)).toEqual([10, 128, 64, 255]);
    expect(px(252, 256)[3]).toBe(0);
    expect(px(260, 256)[3]).toBe(255);
    expect(stageIds(r.events)).toEqual(['load', 'decode', 'transform', 'encode']);
    const a = assetEvents(r.events);
    const size = readFileSync('node_modules/@resvg/resvg-wasm/index_bg.wasm').length;
    expect(a.at(-1)!.loaded).toBe(size);
    expect(a.every((e) => e.total === size)).toBe(true);
    test.info().annotations.push({ type: 'asset', description: `resvg index_bg.wasm ${size} bytes` });
  });

  test('never touches the network for external images and skips text without a font', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (rq) => {
      if (!/^(http:\/\/localhost|blob:|data:)/.test(rq.url())) external.push(rq.url());
    });
    const r = await run2(page, svg('<rect width="100" height="50" fill="#fff"/><image width="50" height="50" href="https://example.invalid/a.png"/><text x="5" y="30" font-size="20">Hi</text>'));
    expect(r.ok, r.error).toBe(true);
    expect(external).toEqual([]);
    const p = decodePng(unb64(r.base64));
    expect(p.rgba.reduce((n, v, i) => n + (i % 4 === 0 && v < 100 ? 1 : 0), 0)).toBe(0);
  });

  test('bad input fails with a readable message', async ({ page }) => {
    expect((await run2(page, 'not svg at all')).error).toMatch(/not a readable SVG/);
    expect((await run2(page, svg('', 0, 0))).error).toMatch(/no usable size/);
  });
});
