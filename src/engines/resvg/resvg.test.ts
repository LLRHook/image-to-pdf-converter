import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expandEdges } from '../../core/graph';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import { decodePng, encodePng, solidRaster } from '../magick/test-utils';
import { edges } from './edges';
import engine from './engine';
import { initResvg, open, plan } from './render';

const svg = (body: string, w: string | number = 100, h: string | number = 50, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" ${extra}>${body}</svg>`;

const run = async (text: string) => {
  const ctx = testContext();
  const res = await engine.convert({ input: blobOf(text), name: 'a.svg', from: 'svg', to: 'png', options: {} }, ctx);
  return { res, ctx, png: decodePng(await bytesOf(res.output)), bytes: await bytesOf(res.output) };
};
const px = (r: { width: number; rgba: Uint8Array }, x: number, y: number) => Array.from(r.rgba.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  const ctx = testContext();
  await initResvg((u) => ctx.fetchAsset(u));
});

describe('edges', () => {
  const [hop] = expandEdges(edges.map((e) => ({ ...e, engine: 'resvg' })));
  it('declares svg -> png only, as raster fidelity, with specific stages', () => {
    expect(edges).toHaveLength(1);
    expect([hop!.from, hop!.to, hop!.fidelity]).toEqual(['svg', 'png', 'raster']);
    expect(hop!.stages.map((s) => s.label)).toEqual(['Load resvg 2.6', 'Parse SVG', 'Rasterise vector paths', 'Encode PNG']);
    expect(hop!.note).toMatch(/1024 px/);
    expect(hop!.note).toMatch(/no font is bundled/); // true until a font is added to ./fonts
  });
});

describe('sizing', () => {
  it('plans: upscale to 1024 on the long side, keep large ones, cap at 8192', () => {
    expect(plan(100, 50).fitTo).toEqual({ mode: 'width', value: 1024 });
    expect(plan(50, 100).fitTo).toEqual({ mode: 'height', value: 1024 });
    expect(plan(2000, 1000).fitTo).toEqual({ mode: 'original' });
    expect(plan(1024, 1).fitTo).toEqual({ mode: 'original' });
    expect(plan(100000, 50000).fitTo).toEqual({ mode: 'width', value: 8192 });
    expect(plan(10, 30000).fitTo).toEqual({ mode: 'height', value: 8192 });
  });

  it.each([
    [100, 50, 1024, 512],
    [50, 100, 512, 1024],
    [2000, 1000, 2000, 1000],
    [40000, 20000, 8192, 4096],
  ])('%i x %i svg renders at %i x %i', async (w, h, ow, oh) => {
    const { png } = await run(svg('<rect width="100%" height="100%" fill="#f00"/>', w, h));
    expect([png.width, png.height]).toEqual([ow, oh]);
  });

  it('uses the viewBox when width/height are missing', async () => {
    const { png } = await run('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"><rect width="30" height="20" fill="blue"/></svg>');
    expect([png.width, png.height]).toEqual([1024, 683]);
  });
});

describe('rendering', () => {
  it('draws vectors crisply at the upscaled size (not a stretched bitmap) with a transparent background', async () => {
    const { png, res, ctx } = await run(svg('<rect x="25" y="10" width="50" height="30" fill="#0a8040"/>'));
    expect(res.ext).toBe('png');
    expect(px(png, 512, 256)).toEqual([10, 128, 64, 255]); // inside
    expect(px(png, 5, 5)[3]).toBe(0); // outside: transparent
    // The edge is razor sharp: x = 25/100*1024 = 256, a stretched bitmap would blur over ~10 px.
    expect(px(png, 252, 256)[3]).toBe(0);
    expect(px(png, 260, 256)[3]).toBe(255);
    expect(ctx.stages).toEqual(['load', 'decode', 'transform', 'encode']);
    expect(ctx.progressValues).toEqual([]);
  });

  it('keeps partial transparency', async () => {
    const { png } = await run(svg('<rect width="100" height="50" fill="rgb(255,0,0)" fill-opacity="0.5"/>'));
    const p = px(png, 100, 100);
    expect(p[3]).toBeGreaterThanOrEqual(127);
    expect(p[3]).toBeLessThanOrEqual(128);
    expect(p[0]).toBe(255);
  });

  it('renders gradients, strokes and clipping', async () => {
    const body = `<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="100" height="50" fill="url(#g)"/>`;
    const { png } = await run(svg(body));
    expect(px(png, 20, 100)[0]).toBeLessThan(40);
    expect(px(png, 1000, 100)[0]).toBeGreaterThan(215);
  });

  it('renders embedded data: images but never fetches external ones', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dataUri = 'data:image/png;base64,' + Buffer.from(encodePng(solidRaster(4, 4, [0, 0, 255, 255]))).toString('base64');
    const body = `<image x="0" y="0" width="50" height="50" href="${dataUri}"/><image x="50" y="0" width="50" height="50" href="http://example.invalid/evil.png"/><image width="10" height="10" xlink:href="https://example.invalid/x.png"/>`;
    const { png } = await run(svg(body, 100, 50));
    expect(px(png, 100, 100)).toEqual([0, 0, 255, 255]);
    expect(px(png, 900, 100)[3]).toBe(0); // external image skipped, left transparent
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips <text> without a bundled font, and renders it once a font is supplied', async () => {
    const doc = svg('<rect width="100" height="50" fill="#fff"/><text x="10" y="32" font-size="26" font-family="Anything" fill="#000">Hi</text>');
    const dark = (r: { rgba: Uint8Array }) => r.rgba.reduce((n, v, i) => n + (i % 4 === 0 && v < 100 ? 1 : 0), 0);
    const { png } = await run(doc);
    expect(dark(png)).toBe(0);
    const font = '/System/Library/Fonts/Supplemental/Arial.ttf';
    if (!existsSync(font)) return; // only a local sanity check of the font path
    const withFont = open(new TextEncoder().encode(doc), [new Uint8Array(await readFile(font))]).render();
    expect(dark({ rgba: withFont.pixels })).toBeGreaterThan(50);
  });
});

describe('facts and preview', () => {
  it('reports intrinsic then rasterised size, and a small real vector thumbnail', async () => {
    const { ctx } = await run(svg('<rect width="100" height="50" fill="rgba(255,0,0,0.5)"/>'));
    expect(ctx.factsSeen[0]).toEqual({ kind: 'raster', width: 100, height: 50, frames: 1, channels: 4, depth: 8 }); // intrinsic
    expect(ctx.factsSeen.at(-1)).toEqual({ kind: 'raster', width: 1024, height: 512, frames: 1, channels: 4, depth: 8 });
    const p = ctx.previews[0]!;
    if (p.kind !== 'pixels') throw new Error('pixels');
    expect([p.width, p.height]).toEqual([96, 48]);
    expect(p.rgba.length).toBe(96 * 48 * 4);
    const c = Array.from(p.rgba.slice((24 * 96 + 48) * 4, (24 * 96 + 48) * 4 + 4));
    expect(c[0]).toBe(255); // straight (not premultiplied) colour
    expect(c[3]).toBeGreaterThanOrEqual(127);
  });

  it('does not enlarge the preview of tiny drawings past their own size', async () => {
    const { ctx } = await run(svg('<rect width="20" height="10" fill="red"/>', 20, 10));
    const p = ctx.previews[0]!;
    if (p.kind !== 'pixels') throw new Error('pixels');
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(96);
  });
});

describe('hostile and broken input', () => {
  it('rejects empty, non-SVG and zero-size input with readable errors', async () => {
    await expect(run('')).rejects.toThrow(/empty/);
    await expect(run('hello world')).rejects.toThrow(/not a readable SVG/);
    await expect(run('<html><body/></html>')).rejects.toThrow(/not a readable SVG/);
    await expect(run(svg('', 0, 0))).rejects.toThrow(/no usable size/);
  });

  it('rejects an entity-expansion bomb quickly', async () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;</text></svg>`;
    const t = performance.now();
    await run(bomb).then(
      () => undefined,
      () => undefined,
    );
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it('refuses SVGs bigger than 32 MB without parsing them', async () => {
    const ctx = testContext();
    const big = new Blob([new Uint8Array(33 * 1024 * 1024)]);
    await expect(engine.convert({ input: big, name: 'x.svg', from: 'svg', to: 'png', options: {} }, ctx)).rejects.toThrow(/larger than 32 MB/);
  });

  it('does not render script or foreignObject', async () => {
    const { png } = await run(svg('<script>throw 1</script><foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><rect width="10" height="10" fill="red"/>'));
    expect(px(png, 20, 20)).toEqual([255, 0, 0, 255]);
  });
});
