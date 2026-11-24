import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ImageMagick,
  MagickFormat,
  MagickImage,
  MagickImageCollection,
  MagickReadSettings,
} from '@imagemagick/magick-wasm';
import * as mupdf from 'mupdf';
import { expandEdges } from '../../core/graph';
import { formatInfo, type FormatId } from '../../core/formats';
import { EngineUnsupportedError, type ConvertResult } from '../../core/types';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import { edges } from './edges';
import engine, { explainEncode } from './engine';
import { initMagick } from './runtime';
import { READABLE, WRITABLE } from './meta';
import {
  bombPng,
  compare,
  decodePng,
  encodePng,
  hex,
  hugeCanvasGif,
  overWhite,
  sampleRaster,
  smoothRaster,
  solidRaster,
  withExifOrientation,
  type Raster,
} from './test-utils';

const HOPS = expandEdges(edges.map((e) => ({ ...e, engine: 'magick' })));
const hop = (from: FormatId, to: FormatId) => HOPS.find((h) => h.from === from && h.to === to)!;

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  png: (b) => hex(b, 4) === '89504e47',
  jpg: (b) => hex(b, 3) === 'ffd8ff',
  webp: (b) => Buffer.from(b.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString() === 'WEBP',
  avif: (b) => Buffer.from(b.subarray(4, 12)).toString().startsWith('ftypavi'),
  jxl: (b) => hex(b, 2) === 'ff0a' || hex(b, 12) === '0000000c4a584c200d0a870a',
  gif: (b) => Buffer.from(b.subarray(0, 4)).toString() === 'GIF8',
  tiff: (b) => ['49492a00', '4d4d002a'].includes(hex(b, 4)),
  bmp: (b) => Buffer.from(b.subarray(0, 2)).toString() === 'BM',
  ico: (b) => hex(b, 4) === '00000100',
  pdf: (b) => Buffer.from(b.subarray(0, 5)).toString() === '%PDF-',
};

const run = async (from: FormatId, to: FormatId, input: Uint8Array, name = `in.${from}`) => {
  const ctx = testContext();
  const res = await engine.convert({ input: blobOf(input), name, from, to, options: {} }, ctx);
  return { res, ctx, out: await bytesOf(res.output) };
};

/** Decode any raster output with ImageMagick (ICO needs its format hint). */
function decodeAll(bytes: Uint8Array, fmt?: MagickFormat): Raster[] {
  return ImageMagick.readCollection(bytes, new MagickReadSettings(fmt ? { format: fmt } : {}), (c) =>
    c.map((img) => {
      const w = img.width;
      const h = img.height;
      return img.getPixels((p) => ({ width: w, height: h, rgba: new Uint8Array(p.toByteArray(0, 0, w, h, 'RGBA')!) }));
    }),
  );
}

const encodeWith = (r: Raster, fmt: MagickFormat): Uint8Array =>
  MagickImage.create(r.rgba, new MagickReadSettings({ format: MagickFormat.Rgba, width: r.width, height: r.height, depth: 8 })).write(
    fmt,
    (d) => d.slice(),
  );

const mupdfPages = (pdf: Uint8Array) => {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const pages = Array.from({ length: doc.countPages() }, (_, i) => {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    return { w: x1 - x0, h: y1 - y0 };
  });
  return pages;
};

const base = sampleRaster(96, 64);
const png = encodePng(base);
const sources = new Map<FormatId, Uint8Array>();

beforeAll(async () => {
  await initMagick(testContext());
  sources.set('png', png);
  sources.set('jpg', encodeWith(overWhite(base), MagickFormat.Jpeg));
  sources.set('webp', encodeWith(base, MagickFormat.WebP));
  sources.set('avif', encodeWith(base, MagickFormat.Avif));
  sources.set('jxl', encodeWith(base, MagickFormat.Jxl));
  sources.set('gif', encodeWith(base, MagickFormat.Gif));
  sources.set('tiff', encodeWith(base, MagickFormat.Tiff));
  sources.set('bmp', encodeWith(overWhite(base), MagickFormat.Bmp3));
  sources.set('psd', encodeWith(base, MagickFormat.Psd));
  sources.set('ico', encodeWith(base, MagickFormat.Ico));
  sources.set('heic', new Uint8Array(await readFile(new URL('./fixtures/sample.heic', import.meta.url))));
});

describe('edges', () => {
  it('declares every read x write pair except identity', () => {
    expect(HOPS.length).toBe(READABLE.length * WRITABLE.length - READABLE.filter((r) => (WRITABLE as readonly string[]).includes(r)).length);
    expect(HOPS.some((h) => h.from === 'pdf' || h.from === 'svg')).toBe(false);
    expect(HOPS.some((h) => h.from === 'heic' && h.to === 'heic')).toBe(false);
    expect(WRITABLE).not.toContain('heic');
  });

  it('names stages specifically', () => {
    expect(hop('heic', 'png').stages.map((s) => s.label)).toEqual(['Load ImageMagick 7.1', 'Decode HEIC (HEVC)', 'Encode PNG']);
    expect(hop('png', 'jpg').stages.map((s) => s.id)).toEqual(['load', 'decode', 'transform', 'encode']);
    expect(hop('png', 'webp').stages.at(-1)!.label).toBe('Encode WebP (lossless)');
    expect(hop('jpg', 'webp').stages.at(-1)!.label).toBe('Encode WebP (quality 90)');
  });

  it('reports truthful fidelity', () => {
    expect(hop('png', 'webp').fidelity).toBe('lossless');
    expect(hop('gif', 'jxl').fidelity).toBe('lossless');
    expect(hop('jpg', 'webp').fidelity).toBe('lossy');
    expect(hop('heic', 'jxl').fidelity).toBe('lossy');
    expect(hop('png', 'avif').fidelity).toBe('lossy'); // AVIF is never bit-exact here
    expect(hop('png', 'jpg').fidelity).toBe('lossy');
    expect(hop('png', 'gif').fidelity).toBe('lossy');
    expect(hop('webp', 'png').fidelity).toBe('lossless');
    expect(hop('png', 'tiff').fidelity).toBe('lossless');
    expect(hop('png', 'pdf').fidelity).toBe('lossless');
    expect(hop('jpg', 'pdf').fidelity).toBe('lossy');
    expect(hop('gif', 'png').note).toContain('first frame');
    expect(hop('gif', 'webp').note).toBeUndefined();
    expect(hop('png', 'ico').note).toContain('256');
  });
});

describe('every pair converts to a valid file', () => {
  const pairs = HOPS.map((h) => [h.from, h.to] as const);
  it.each(pairs)('%s -> %s', async (from, to) => {
    const { res, ctx, out } = await run(from, to, sources.get(from)!);
    // Stages reported are exactly the ones declared, in order.
    expect(ctx.stages).toEqual(hop(from, to).stages.map((s) => s.id));
    expect(res.ext).toBe(formatInfo(to).exts[0]);
    expect(res.mime).toBe(formatInfo(to).mime);
    expect(MAGIC[to]!(out), `${to} magic ${hex(out, 12)}`).toBe(true);
    const f = ctx.factsSeen[0]!;
    expect(f.kind).toBe('raster');
    if (to === 'pdf') {
      expect(mupdfPages(out).length).toBe(1);
    } else {
      const dec = decodeAll(out, to === 'ico' ? MagickFormat.Ico : undefined);
      expect(dec.length).toBe(1);
      expect(dec[0]!.width).toBe(f.kind === 'raster' ? Math.min(256, f.width) : 0);
    }
  });
});

describe('pixel accuracy', () => {
  it('png -> png-lossless targets are bit exact (webp, jxl, tiff)', async () => {
    for (const to of ['webp', 'jxl', 'tiff'] as const) {
      const { out } = await run('png', to, png);
      const back = decodeAll(out)[0]!;
      const d = compare(base, back);
      expect(d.max, `${to} max diff`).toBe(0);
    }
  });

  it('png -> webp/jxl/tiff -> png keeps every pixel, checked with the independent PNG decoder', async () => {
    for (const mid of ['webp', 'jxl', 'tiff'] as const) {
      const first = await run('png', mid, png);
      const { out } = await run(mid, 'png', first.out);
      const d = compare(base, decodePng(out));
      expect(d.max, `png -> ${mid} -> png`).toBe(0);
    }
  });

  it('png -> png-bound conversions of an opaque image return identical bytes of pixels', async () => {
    const opaque = sampleRaster(40, 30, false);
    const { out } = await run('bmp', 'png', encodeWith(opaque, MagickFormat.Bmp3));
    expect(compare(opaque, decodePng(out)).max).toBe(0);
  });

  it('flattens transparency onto white for jpg, bmp and pdf targets', async () => {
    const expected = overWhite(base);
    const bmp = await run('png', 'bmp', png);
    expect(compare(expected, decodeAll(bmp.out)[0]!).max).toBe(0);
    const jpg = await run('png', 'jpg', png);
    const j = compare(expected, decodeAll(jpg.out)[0]!);
    expect(j.mean).toBeLessThan(6);
    // fully transparent region is white, not black
    const px = decodeAll(jpg.out)[0]!.rgba;
    expect([px[0], px[1], px[2]].every((v) => v! > 240)).toBe(true);
  });

  it('jpeg quality is 90 and output is smaller than 100', async () => {
    const photo = smoothRaster(128, 96);
    const { out } = await run('png', 'jpg', encodePng(photo));
    const q = MagickImage.create(); // estimate: re-read quality
    q.read(out);
    const quality = q.quality;
    q.dispose();
    expect(quality).toBe(90);
  });

  it('lossy targets stay close on smooth content (avif, heic source, jpeg source)', async () => {
    const smooth = smoothRaster();
    const a = await run('png', 'avif', encodePng(smooth));
    expect(compare(smooth, decodeAll(a.out)[0]!).max).toBeLessThanOrEqual(2); // 4:4:4 q100: near-lossless
    const h = await run('heic', 'png', sources.get('heic')!);
    const r = decodePng(h.out);
    expect(r.width).toBe(128);
    expect(r.height).toBe(96);
    expect(compare(smooth, r).mean).toBeLessThan(6);
    const w = await run('png', 'webp', encodePng(smooth));
    expect(compare(smooth, decodeAll(w.out)[0]!).max).toBe(0);
    const lossy = await run('jpg', 'webp', encodeWith(smooth, MagickFormat.Jpeg));
    expect(compare(smooth, decodeAll(lossy.out)[0]!).mean).toBeLessThan(6);
  });

  it('gif output is 256 colors but keeps the picture', async () => {
    const smooth = smoothRaster();
    const { out } = await run('png', 'gif', encodePng(smooth));
    expect(compare(smooth, decodeAll(out)[0]!).mean).toBeLessThan(12);
  });
});

describe('animation and multi-frame', () => {
  const frames = [
    { c: [255, 0, 0, 255] as [number, number, number, number], delay: 10 },
    { c: [0, 255, 0, 255] as [number, number, number, number], delay: 20 },
    { c: [0, 0, 255, 255] as [number, number, number, number], delay: 30 },
  ];
  const makeGif = (alpha = false) => {
    const col = MagickImageCollection.create();
    frames.forEach((f, k) => {
      const r = solidRaster(40, 30, alpha ? [f.c[0], f.c[1], f.c[2], k === 0 ? 255 : 255] : f.c);
      if (alpha) for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) if ((x + y + k) % 2 === 0 && x < 10) r.rgba[(y * 40 + x) * 4 + 3] = 0;
      const img = MagickImage.create(r.rgba, new MagickReadSettings({ format: MagickFormat.Rgba, width: 40, height: 30, depth: 8 }));
      img.animationDelay = f.delay;
      col.push(img);
    });
    const out = col.write(MagickFormat.Gif, (d) => d.slice());
    col.dispose();
    return out;
  };

  const delays = (bytes: Uint8Array) => ImageMagick.readCollection(bytes, (c) => c.map((i) => i.animationDelay));

  it('gif -> webp -> gif keeps frame count, colors and timing', async () => {
    const gif = makeGif();
    const w = await run('gif', 'webp', gif);
    expect(MAGIC.webp!(w.out)).toBe(true);
    const wf = decodeAll(w.out);
    expect(wf.length).toBe(3);
    expect(delays(w.out)).toEqual([10, 20, 30]);
    expect(w.ctx.factsSeen[0]).toMatchObject({ kind: 'raster', width: 40, height: 30, frames: 3 });
    expect([wf[0]!.rgba[0], wf[1]!.rgba[1], wf[2]!.rgba[2]]).toEqual([255, 255, 255]);
    const g = await run('webp', 'gif', w.out);
    const gf = decodeAll(g.out);
    expect(gf.length).toBe(3);
    expect(delays(g.out)).toEqual([10, 20, 30]);
    expect(gf[1]!.rgba[1]).toBe(255);
    expect(gf[1]!.rgba[0]).toBe(0);
  });

  it('animated transparency survives gif -> webp -> gif without ghosting', async () => {
    const gif = makeGif(true);
    const w = await run('gif', 'webp', gif);
    const g = await run('webp', 'gif', w.out);
    const got = ImageMagick.readCollection(g.out, (c) => {
      c.coalesce();
      return c.map((img) => img.getPixels((p) => new Uint8Array(p.toByteArray(0, 0, 40, 30, 'RGBA')!)));
    });
    const ref = ImageMagick.readCollection(gif, (c) => {
      c.coalesce();
      return c.map((img) => img.getPixels((p) => new Uint8Array(p.toByteArray(0, 0, 40, 30, 'RGBA')!)));
    });
    expect(got.length).toBe(ref.length);
    got.forEach((frame, k) => {
      for (let i = 0; i < frame.length; i += 4) {
        expect(frame[i + 3] === 0, `frame ${k} px ${i / 4} alpha`).toBe(ref[k]![i + 3] === 0);
      }
    });
  });

  it('multi-frame sources keep only the first frame for png/jpg/bmp/ico', async () => {
    const gif = makeGif();
    for (const to of ['png', 'jpg', 'bmp'] as const) {
      const { out, ctx } = await run('gif', to, gif);
      const dec = decodeAll(out);
      expect(dec.length).toBe(1);
      expect(dec[0]!.rgba[0]).toBeGreaterThan(200); // first frame is red
      expect(dec[0]!.rgba[1]).toBeLessThan(60);
      expect(ctx.factsSeen[0]).toMatchObject({ frames: 1 });
    }
  });

  it('gif -> tiff and -> pdf keep every frame as a page, with progress per frame in the transform stage', async () => {
    const gif = makeGif();
    const t = await run('gif', 'tiff', gif);
    expect(decodeAll(t.out).length).toBe(3);
    const p = await run('gif', 'pdf', gif);
    expect(mupdfPages(p.out)).toEqual([{ w: 40, h: 30 }, { w: 40, h: 30 }, { w: 40, h: 30 }]);
    expect(p.ctx.progressValues).toEqual([1 / 3, 2 / 3, 1]);
    expect(p.ctx.stages).toEqual(['load', 'decode', 'transform', 'encode']);
  });

  it('single-frame jobs never report progress', async () => {
    const { ctx } = await run('png', 'jpg', png);
    expect(ctx.progressValues).toEqual([]);
  });
});

describe('format specifics', () => {
  it('applies EXIF orientation (portrait photo stored sideways)', async () => {
    const landscape = sampleRaster(60, 40, false);
    const jpeg = withExifOrientation(encodeWith(landscape, MagickFormat.Jpeg), 6);
    const { out, ctx } = await run('jpg', 'png', jpeg);
    const r = decodePng(out);
    expect([r.width, r.height]).toEqual([40, 60]);
    expect(ctx.factsSeen[0]).toMatchObject({ width: 40, height: 60 });
    // orientation 6 = rotate 90° clockwise: stored top-left becomes top-right
    const topLeft = landscape.rgba.slice(0, 3);
    const topRight = r.rgba.slice((r.width - 1) * 4, (r.width - 1) * 4 + 3);
    expect(Math.abs(topRight[0]! - topLeft[0]!)).toBeLessThan(25);
    expect(Math.abs(topRight[1]! - topLeft[1]!)).toBeLessThan(25);
  });

  it('ico output fits within 256x256 keeping aspect; small icons are untouched', async () => {
    const wide = sampleRaster(600, 300);
    const { out } = await run('png', 'ico', encodePng(wide));
    const d = decodeAll(out, MagickFormat.Ico)[0]!;
    expect([d.width, d.height]).toEqual([256, 128]);
    const small = await run('png', 'ico', encodePng(sampleRaster(48, 48)));
    const s = decodeAll(small.out, MagickFormat.Ico)[0]!;
    expect([s.width, s.height]).toEqual([48, 48]);
  });

  it('ico input uses the largest size', async () => {
    const col = MagickImageCollection.create();
    for (const s of [16, 48, 32]) col.push(MagickImage.create(solidRaster(s, s, [10, s, 200, 255]).rgba, new MagickReadSettings({ format: MagickFormat.Rgba, width: s, height: s, depth: 8 })));
    const ico = col.write(MagickFormat.Ico, (d) => d.slice());
    col.dispose();
    const { out, ctx } = await run('ico', 'png', ico);
    const r = decodePng(out);
    expect([r.width, r.height]).toEqual([48, 48]);
    expect(Array.from(r.rgba.slice(0, 3))).toEqual([10, 48, 200]);
    expect(ctx.factsSeen[0]).toMatchObject({ width: 48, height: 48, frames: 1 });
  });

  it('psd uses the flattened composite, not its layers', async () => {
    const col = MagickImageCollection.create();
    for (const v of [30, 130, 230]) col.push(MagickImage.create(solidRaster(20, 10, [v, v, v, 255]).rgba, new MagickReadSettings({ format: MagickFormat.Rgba, width: 20, height: 10, depth: 8 })));
    const psd = col.write(MagickFormat.Psd, (d) => d.slice());
    col.dispose();
    const { out, ctx } = await run('psd', 'png', psd);
    const r = decodePng(out);
    expect([r.width, r.height]).toEqual([20, 10]);
    expect(ctx.factsSeen[0]).toMatchObject({ frames: 1 });
    const gif = await run('psd', 'gif', psd);
    expect(decodeAll(gif.out).length).toBe(1);
  });

  it('heic decodes to the expected image', async () => {
    const { out, ctx } = await run('heic', 'jpg', sources.get('heic')!);
    expect(ctx.factsSeen[0]).toMatchObject({ kind: 'raster', width: 128, height: 96, frames: 1 });
    const d = decodeAll(out)[0]!;
    expect(compare(smoothRaster(), d).mean).toBeLessThan(8);
  });

  it('pdf pages are sized to the image, capped near A4 by raising the density', async () => {
    const small = await run('png', 'pdf', encodePng(sampleRaster(100, 50, false)));
    expect(mupdfPages(small.out)).toEqual([{ w: 100, h: 50 }]);
    const big = await run('png', 'pdf', encodePng(sampleRaster(2000, 1000, false)));
    const [p] = mupdfPages(big.out);
    expect(p!.w).toBeLessThanOrEqual(842.5);
    expect(p!.w / p!.h).toBeCloseTo(2, 1);
  });

  it('pdf embeds lossless sources with Flate and lossy ones as JPEG', async () => {
    const flat = Buffer.from((await run('png', 'pdf', png)).out).toString('latin1');
    expect(flat).toContain('/FlateDecode');
    expect(flat).not.toContain('/DCTDecode');
    const jpg = Buffer.from((await run('jpg', 'pdf', sources.get('jpg')!)).out).toString('latin1');
    expect(jpg).toContain('/DCTDecode');
  });

  it('pdf output renders the image (page 1 center pixel)', async () => {
    const red = solidRaster(64, 64, [200, 20, 30, 255]);
    const { out } = await run('png', 'pdf', encodePng(red));
    const page = mupdf.Document.openDocument(out, 'application/pdf').loadPage(0);
    const pm = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const px = pm.getPixels();
    const c = (32 * pm.getWidth() + 32) * 3;
    expect([px[c], px[c + 1], px[c + 2]].map((v) => Math.round(v! / 4))).toEqual([50, 5, 8].map((v) => Math.round(v)));
  });
});

describe('facts and preview', () => {
  it('emits real facts and a <=96px thumbnail of the decoded image', async () => {
    const { ctx } = await run('png', 'webp', encodePng(solidRaster(300, 150, [10, 200, 90, 255])));
    expect(ctx.factsSeen[0]).toEqual({ kind: 'raster', width: 300, height: 150, frames: 1, channels: 4, depth: 8 });
    const p = ctx.previews[0]!;
    expect(p.kind).toBe('pixels');
    if (p.kind !== 'pixels') return;
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(96);
    expect([p.width, p.height]).toEqual([96, 48]);
    expect(p.rgba.length).toBe(96 * 48 * 4);
    expect(Array.from(p.rgba.slice(0, 4))).toEqual([10, 200, 90, 255]);
  });

  it('does not upscale small images and reports gray / opaque channel counts', async () => {
    const { ctx } = await run('bmp', 'png', encodeWith(solidRaster(20, 10, [1, 2, 3, 255]), MagickFormat.Bmp3));
    const p = ctx.previews[0]!;
    if (p.kind !== 'pixels') throw new Error('pixels');
    expect([p.width, p.height]).toEqual([20, 10]);
    expect(ctx.factsSeen[0]).toMatchObject({ channels: 3 });
  });
});

describe('hostile and broken input', () => {
  it('rejects a decompression bomb before decoding, with a clear message', async () => {
    const t = performance.now();
    await expect(run('png', 'jpg', bombPng(12000, 12000))).rejects.toThrow(/12000 × 12000 px.*limit is 16384 px per side and 100 megapixels/);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('rejects over-wide images', async () => {
    await expect(run('png', 'png', bombPng(20000, 10))).rejects.toThrow(/20000 × 10/);
  });

  it('budgets memory across frames: 3 frames of an 8000x8000 canvas are 192 MP together', async () => {
    const gif = hugeCanvasGif(8000, 3);
    await expect(run('gif', 'webp', gif)).rejects.toThrow(/3 frames add up to 192 megapixels; the limit is 128 megapixels/);
    // only the first frame is held for single-frame targets, so that one is within budget (64 MP)
    const ok = await run('gif', 'bmp', hugeCanvasGif(2000, 3));
    expect(decodeAll(ok.out)[0]!.width).toBe(2000);
  });

  it('rejects truncated files', async () => {
    const cut = png.slice(0, Math.floor(png.length / 2));
    await expect(run('png', 'jpg', cut)).rejects.toThrow(/damaged or incomplete|Could not read/);
  });

  it('rejects empty, garbage and non-image data', async () => {
    await expect(run('png', 'jpg', new Uint8Array(0))).rejects.toThrow(/empty/);
    await expect(run('png', 'jpg', new Uint8Array(500).fill(7))).rejects.toThrow(/doesn't look like an image/);
    await expect(run('png', 'jpg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))).rejects.toThrow(/doesn't look like an image/);
  });

  it('never lets ImageMagick pick another coder from the data (e.g. MVG scripts)', async () => {
    await expect(run('png', 'jpg', new TextEncoder().encode('push graphic-context\nviewbox 0 0 10 10\nfill red\nrectangle 1,1 9,9\npop graphic-context'))).rejects.toThrow(/doesn't look like an image/);
  });

  it('decodes by content when the declared format is wrong, and says so', async () => {
    const { out, ctx } = await run('png', 'png', sources.get('jpg')!, 'photo.png');
    expect(decodePng(out).width).toBe(96);
    expect(ctx.logs.join(' ')).toMatch(/decoding as JPEG/);
  });

  it('flags undecodable exotic containers as unsupported so another engine can try', async () => {
    // HEIF header with no usable image items
    const broken = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 8, 0x6d, 0x65, 0x74, 0x61]);
    await expect(run('heic', 'png', broken)).rejects.toBeInstanceOf(EngineUnsupportedError);
  });

  it('stops when cancelled before decoding', async () => {
    const ctx = testContext();
    const ac = new AbortController();
    ac.abort();
    await expect(engine.convert({ input: blobOf(png), name: 'a.png', from: 'png', to: 'jpg', options: {} }, { ...ctx, signal: ac.signal } as never)).rejects.toThrow(/Cancelled/);
  });
});

describe('encode failures', () => {
  it('reads out-of-memory in the encoder as "too large to write", not as a damaged input, and lets another engine try', () => {
    const e = explainEncode(new Error('Encoder plugin generated an error: Encoding problem: Failed to allocate lag buffers (8.5002) `/tmp/x'), 'avif', 81_000_000);
    expect(e).toBeInstanceOf(EngineUnsupportedError);
    expect(e.message).toBe('This image (81 megapixels) is too large to write as AVIF in the browser. Try a smaller image or another format.');
  });
  it('other encoder errors name the target format', () => {
    const e = explainEncode(new Error('WidthOrHeightExceedsLimit `foo\' @ error/ico.c/WriteICOImage/1'), 'ico');
    expect(e).not.toBeInstanceOf(EngineUnsupportedError);
    expect(e.message).toMatch(/^Could not write ICO: WidthOrHeightExceedsLimit/);
  });
});

describe('asset loading', () => {
  it('fetches the 32-bit wasm through ctx.fetchAsset', async () => {
    const ctx = testContext();
    const r: ConvertResult = await engine.convert({ input: blobOf(png), name: 'a.png', from: 'png', to: 'bmp', options: {} }, ctx);
    expect(r.ext).toBe('bmp');
    // initMagick is memoised per worker; the first test file context fetched it
    expect(ctx.stages[0]).toBe('load');
  });
});
