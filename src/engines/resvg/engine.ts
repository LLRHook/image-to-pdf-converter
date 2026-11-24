import { formatInfo } from '../../core/formats';
import type { ConvertRequest, ConvertResult, Engine, EngineContext } from '../../core/types';
import { MAX_SIDE } from './edges';
import { initResvg, open, plan } from './render';

const MAX_SVG_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 100_000_000;

/** Fonts dropped into ./fonts are fetched as ordinary engine assets. */
const FONT_URLS = Object.values(
  import.meta.glob<string>('./fonts/*.{ttf,otf,ttc}', { query: '?url', import: 'default', eager: true }),
);

function unpremultiply(px: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a === 0) continue;
    out[i] = Math.min(255, Math.round((px[i]! * 255) / a));
    out[i + 1] = Math.min(255, Math.round((px[i + 1]! * 255) / a));
    out[i + 2] = Math.min(255, Math.round((px[i + 2]! * 255) / a));
    out[i + 3] = a;
  }
  return out;
}

function explain(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (/does not have a root node|unknown token|parsing failed/i.test(raw)) {
    return new Error(`This is not a readable SVG: ${raw.replace(/^Error:\s*/, '').replace(/^SVG data parsing failed cause\s*/i, '')}.`);
  }
  if (/invalid size/i.test(raw)) return new Error('This SVG has no usable size (width/height or viewBox is zero or missing).');
  if (/memory|unreachable|out of bounds/i.test(raw)) return new Error('This SVG is too complex or too large to render in the browser.');
  return new Error(`Could not render this SVG: ${raw.replace(/^Error:\s*/, '')}`);
}

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  ctx.stage('load');
  await initResvg((u) => ctx.fetchAsset(u));
  const fonts = await Promise.all(FONT_URLS.map((u) => ctx.fetchAsset(u)));
  if (ctx.signal.aborted) throw new Error('Cancelled');

  ctx.stage('decode');
  if (req.input.size === 0) throw new Error('The file is empty.');
  if (req.input.size > MAX_SVG_BYTES) throw new Error(`The SVG is larger than ${MAX_SVG_BYTES / 1024 / 1024} MB.`);
  const svg = new Uint8Array(await req.input.arrayBuffer());

  let png: Uint8Array;
  try {
    // First pass at the intrinsic size just to learn it (and nothing is rasterised here).
    const probe = open(svg, fonts);
    const p = plan(probe.width, probe.height);
    probe.free();
    ctx.facts({ kind: 'raster', width: p.width, height: p.height, frames: 1, channels: 4, depth: 8 });

    // A real vector-rendered thumbnail, drawn before the big render starts.
    const small = open(svg, fonts, { mode: p.width >= p.height ? 'width' : 'height', value: Math.min(96, Math.max(p.width, p.height)) });
    const thumb = small.render();
    ctx.preview({ kind: 'pixels', width: thumb.width, height: thumb.height, rgba: unpremultiply(thumb.pixels) });
    thumb.free();
    small.free();

    ctx.stage('transform');
    const r = open(svg, fonts, p.fitTo);
    if (r.width < 1 || r.height < 1) throw new Error('This SVG has no usable size.');
    const img = r.render();
    const [w, h] = [img.width, img.height];
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
      img.free();
      r.free();
      throw new Error(`The SVG would render at ${w} × ${h} px; the limit is ${MAX_SIDE} px per side.`);
    }
    ctx.facts({ kind: 'raster', width: w, height: h, frames: 1, channels: 4, depth: 8 });
    ctx.stage('encode');
    png = img.asPng();
    img.free();
    r.free();
  } catch (err) {
    throw explain(err);
  }
  const info = formatInfo('png');
  return { output: png, ext: info.exts[0]!, mime: info.mime };
}

export default { convert } satisfies Engine;
