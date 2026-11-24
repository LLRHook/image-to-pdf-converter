import {
  AlphaAction,
  CompressionMethod,
  ColorSpace,
  Density,
  DensityUnit,
  GifDisposeMethod,
  ImageMagick,
  MagickColors,
  MagickFormat,
  MagickGeometry,
  MagickImageCollection,
  MagickReadSettings,
  type IMagickImage,
  type IMagickImageCollection,
} from '@imagemagick/magick-wasm';
import { formatInfo, type FormatId } from '../../core/formats';
import {
  EngineUnsupportedError,
  type ConvertRequest,
  type ConvertResult,
  type Engine,
  type EngineContext,
} from '../../core/types';
import {
  ICO_MAX,
  JPEG_QUALITY,
  LIMITS,
  MULTI_FRAME_SOURCES,
  MULTI_FRAME_TARGETS,
  PDF_MAX_POINTS,
  READABLE,
  WRITABLE,
  lossless,
  type MagickSource,
  type MagickTarget,
} from './meta';
import { thumbFromRows } from './rgba-thumb';
import { initMagick } from './runtime';
import { peekSize, sniffImage } from './sniff';

const READ_FORMAT: Record<MagickSource, MagickFormat> = {
  png: MagickFormat.Png,
  jpg: MagickFormat.Jpeg,
  webp: MagickFormat.WebP,
  avif: MagickFormat.Avif,
  jxl: MagickFormat.Jxl,
  gif: MagickFormat.Gif,
  tiff: MagickFormat.Tiff,
  bmp: MagickFormat.Bmp,
  ico: MagickFormat.Ico,
  heic: MagickFormat.Heic,
  psd: MagickFormat.Psd,
};

const WRITE_FORMAT: Record<MagickTarget, MagickFormat> = {
  png: MagickFormat.Png,
  jpg: MagickFormat.Jpeg,
  webp: MagickFormat.WebP,
  avif: MagickFormat.Avif,
  jxl: MagickFormat.Jxl,
  gif: MagickFormat.Gif,
  tiff: MagickFormat.Tiff,
  bmp: MagickFormat.Bmp3, // 24-bit, no alpha, readable everywhere
  ico: MagickFormat.Ico,
  pdf: MagickFormat.Pdf,
};

const NAME: Record<MagickSource, string> = {
  png: 'PNG',
  jpg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  jxl: 'JPEG XL',
  gif: 'GIF',
  tiff: 'TIFF',
  bmp: 'BMP',
  ico: 'ICO',
  heic: 'HEIC',
  psd: 'Photoshop',
};

interface FrameInfo {
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
}

/** An error whose message is already written for the user; explain() leaves it alone. */
class UserError extends Error {}

/** Wraps anything thrown while transforming or encoding, so it is not reported as a problem reading the file. */
class EncodeFailure extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
  }
}

const RESOURCE_FAILURE =
  /CacheResourcesExhausted|ResourceLimit|out of memory|OOM|memory access out of bounds|Aborted|allocate|Unable to grow|Maximum memory|Invalid typed array length|Array buffer allocation/i;

const mp = (n: number) => `${Math.round(n / 1e5) / 10} megapixels`;

function isSource(f: string): f is MagickSource {
  return (READABLE as readonly string[]).includes(f);
}
function isTarget(f: string): f is MagickTarget {
  return (WRITABLE as readonly string[]).includes(f);
}

/** Header-only scan: dimensions and frame count without decoding any pixels. */
function ping(bytes: Uint8Array, settings: MagickReadSettings): FrameInfo[] {
  const c = MagickImageCollection.create();
  try {
    c.ping(bytes, settings);
    return c.map((i) => ({ width: i.width, height: i.height, pageWidth: i.page.width, pageHeight: i.page.height }));
  } finally {
    c.dispose();
  }
}

function checkFrame(f: FrameInfo, index?: number) {
  const where = index === undefined ? 'The image' : `Frame ${index + 1}`;
  if (f.width < 1 || f.height < 1) throw new UserError(`${where} has no pixels.`);
  if (f.width > LIMITS.maxSide || f.height > LIMITS.maxSide || f.width * f.height > LIMITS.maxPixels) {
    throw new UserError(
      `${where} is ${f.width} × ${f.height} px (${mp(f.width * f.height)}). ` +
        `The limit is ${LIMITS.maxSide} px per side and ${mp(LIMITS.maxPixels)}, to keep your browser from running out of memory.`,
    );
  }
}

/** Translate ImageMagick / wasm failures into something a person can act on. */
function explain(err: unknown, src: MagickSource): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof EngineUnsupportedError || err instanceof UserError) return err;
  if (RESOURCE_FAILURE.test(raw)) {
    return new Error(
      `This image is too large to convert in the browser (limit ${LIMITS.maxSide} px per side, ${mp(LIMITS.maxPixels)}, ${LIMITS.maxFrames} frames).`,
    );
  }
  if (/NoDecodeDelegate|DelegateLibrarySupportNotBuiltIn|MissingDelegate/i.test(raw)) {
    return new EngineUnsupportedError(`ImageMagick cannot decode this ${NAME[src]} file (${raw.split(' @ ')[0]}).`);
  }
  if (src === 'heic' || src === 'avif' || src === 'jxl') {
    // Exotic codecs live inside these containers and we cannot tell "damaged"
    // from "uses a feature this build lacks": let another engine try.
    return new EngineUnsupportedError(`ImageMagick could not decode this ${NAME[src]} file: ${raw.split(' @ ')[0]}`);
  }
  if (/Corrupt|ImproperImageHeader|InsufficientImageData|NotEnoughImageData|UnexpectedEndOfFile|Invalid|truncated|premature|EOF/i.test(raw)) {
    return new Error(`This ${NAME[src]} file looks damaged or incomplete (${raw.split(' @ ')[0]?.replace(/`'/g, '').trim()}).`);
  }
  return new Error(`Could not read this ${NAME[src]} file: ${raw.split(' @ ')[0]}`);
}

const TARGET_NAME: Record<MagickTarget, string> = {
  png: 'PNG', jpg: 'JPEG', webp: 'WebP', avif: 'AVIF', jxl: 'JPEG XL', gif: 'GIF', tiff: 'TIFF', bmp: 'BMP', ico: 'ICO', pdf: 'PDF',
};

/** Failures while preparing or writing the output. Resource exhaustion is "unsupported here", so a lighter engine may still manage it. */
export function explainEncode(err: unknown, to: MagickTarget, pixels?: number): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof EngineUnsupportedError || err instanceof UserError) return err;
  if (RESOURCE_FAILURE.test(raw)) {
    const size = pixels ? ` (${mp(pixels)})` : '';
    return new EngineUnsupportedError(
      `This image${size} is too large to write as ${TARGET_NAME[to]} in the browser. Try a smaller image or another format.`,
    );
  }
  return new Error(`Could not write ${TARGET_NAME[to]}: ${raw.split(' @ ')[0]}`);
}

function colorChannels(img: IMagickImage): number {
  const base = img.colorSpace === ColorSpace.Gray ? 1 : img.colorSpace === ColorSpace.CMYK ? 4 : 3;
  return base + (img.hasAlpha ? 1 : 0);
}

function preview(img: IMagickImage, ctx: EngineContext) {
  const w = img.width;
  const h = img.height;
  img.getPixels((p) => {
    const t = thumbFromRows(w, h, (y) => p.toByteArray(0, y, w, 1, 'RGBA') ?? new Uint8Array(w * 4));
    ctx.preview({ kind: 'pixels', width: t.width, height: t.height, rgba: t.rgba });
  });
}

function pdfDensity(img: IMagickImage): Density {
  const dpi = Math.max(72, Math.ceil((Math.max(img.width, img.height) * 72) / PDF_MAX_POINTS));
  return new Density(dpi, dpi, DensityUnit.PixelsPerInch);
}

/** Per-target encoder settings. Called on every frame that will be written. */
function prepareEncode(img: IMagickImage, from: MagickSource, to: MagickTarget) {
  const exact = lossless(from);
  switch (to) {
    case 'png':
      img.settings.setDefine(MagickFormat.Png, 'exclude-chunk', 'date,time');
      break;
    case 'jpg':
      img.quality = JPEG_QUALITY;
      break;
    case 'webp':
      if (exact) img.settings.setDefine(MagickFormat.WebP, 'lossless', true);
      else img.quality = JPEG_QUALITY;
      break;
    case 'avif':
      if (exact) {
        img.quality = 100;
        img.settings.setDefine('heic:chroma', '444');
      } else img.quality = JPEG_QUALITY;
      img.settings.setDefine('heic:speed', '7');
      break;
    case 'jxl':
      img.quality = exact ? 100 : JPEG_QUALITY;
      break;
    case 'tiff':
      img.settings.compression = CompressionMethod.Zip;
      break;
    case 'gif':
      // Frames are fully composed, so each must clear itself or transparent
      // pixels of a later frame would show the previous one.
      img.gifDisposeMethod = GifDisposeMethod.Background;
      break;
    case 'pdf':
      img.density = pdfDensity(img);
      if (exact) img.settings.compression = CompressionMethod.Zip;
      else {
        img.settings.compression = CompressionMethod.JPEG;
        img.quality = JPEG_QUALITY;
      }
      break;
    default:
      break;
  }
}

function flatten(img: IMagickImage) {
  if (!img.hasAlpha) return;
  img.backgroundColor = MagickColors.White;
  img.alpha(AlphaAction.Remove);
}

function fitIcon(img: IMagickImage) {
  if (img.width <= ICO_MAX && img.height <= ICO_MAX) return;
  const g = new MagickGeometry(ICO_MAX, ICO_MAX);
  g.greater = true;
  img.resize(g);
}

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  const { from, to } = req;
  if (!isSource(from)) throw new Error(`ImageMagick cannot read ${from}.`);
  if (!isTarget(to)) throw new Error(`ImageMagick cannot write ${to}.`);

  ctx.stage('load');
  await initMagick(ctx);

  ctx.stage('decode');
  if (req.input.size === 0) throw new Error('The file is empty.');
  if (req.input.size > LIMITS.maxInputBytes) throw new Error(`The file is larger than ${LIMITS.maxInputBytes / 1024 / 1024} MB.`);
  const bytes = new Uint8Array(await req.input.arrayBuffer());

  // Trust the bytes over the file name; force exactly one decoder.
  const src = sniffImage(bytes);
  if (!src) throw new Error(`This doesn't look like an image file${from ? ` (expected ${NAME[from]})` : ''}: its header is not recognised.`);
  if (src !== from) ctx.log(`File name says ${NAME[from]} but the data is ${NAME[src]}; decoding as ${NAME[src]}.`);

  // ICO / PSD / HEIC always collapse to a single image; so do all single-frame targets.
  const keepAllFrames = MULTI_FRAME_TARGETS.has(to) && MULTI_FRAME_SOURCES.has(src);
  const wantsLargest = src === 'ico';
  const settings = new MagickReadSettings({ format: READ_FORMAT[src] });
  if (!keepAllFrames && !wantsLargest) {
    settings.frameIndex = 0;
    settings.frameCount = 1;
  }

  // Reject absurd canvases with their real numbers before ImageMagick allocates anything.
  const peek = peekSize(bytes, src);
  if (peek) checkFrame({ width: peek.width, height: peek.height, pageWidth: peek.width, pageHeight: peek.height });

  let result: Uint8Array;
  let encodedPixels: number | undefined;
  try {
    const frames = ping(bytes, new MagickReadSettings({ format: READ_FORMAT[src] }));
    if (frames.length === 0) throw new UserError('The file contains no image.');
    if (frames.length > LIMITS.maxFrames) throw new UserError(`The file has ${frames.length} frames; the limit is ${LIMITS.maxFrames}.`);
    const considered = keepAllFrames ? frames : wantsLargest ? frames : frames.slice(0, 1);
    let total = 0;
    considered.forEach((f, i) => {
      checkFrame(f, considered.length > 1 ? i : undefined);
      total += Math.max(f.width * f.height, f.pageWidth * f.pageHeight);
    });
    if (wantsLargest) total = Math.max(...considered.map((f) => f.width * f.height));
    if (total > LIMITS.maxTotalPixels) {
      throw new UserError(
        `The ${considered.length} frames add up to ${mp(total)}; the limit is ${mp(LIMITS.maxTotalPixels)} to keep your browser from running out of memory.`,
      );
    }

    result = ImageMagick.readCollection(bytes, settings, (all: IMagickImageCollection) => {
      // Animated sources store frames as partial updates; rebuild whole frames first.
      if ((src === 'gif' || src === 'webp') && all.length >= 1) all.coalesce();

      let images: IMagickImage[] = [...all];
      if (wantsLargest) {
        const best = images.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
        images = [best];
      } else if (!keepAllFrames) {
        images = images.slice(0, 1);
      }
      for (const img of images) img.autoOrient();

      const first = images[0]!;
      encodedPixels = first.width * first.height;
      ctx.facts({
        kind: 'raster',
        width: first.width,
        height: first.height,
        frames: images.length,
        channels: colorChannels(first),
        depth: first.depth,
      });
      preview(first, ctx);

      try {
        if (to === 'jpg' || to === 'bmp' || to === 'pdf' || to === 'ico') {
          ctx.stage('transform');
          images.forEach((img, i) => {
            if (to === 'ico') fitIcon(img);
            else flatten(img);
            if (images.length > 1) ctx.progress((i + 1) / images.length); // frames done / frames total
          });
        }

        ctx.stage('encode');
        for (const img of images) prepareEncode(img, src, to);
        const format = WRITE_FORMAT[to];
        if (images.length === 1) return first.write(format, (d) => d.slice());
        // Collection.write takes its settings from the first image; the rest keep their own quality/density.
        return all.write(format, (d) => d.slice());
      } catch (e) {
        throw e instanceof UserError || e instanceof EngineUnsupportedError ? e : new EncodeFailure(e);
      }
    });
  } catch (err) {
    if (err instanceof EncodeFailure) throw explainEncode(err.original, to, encodedPixels);
    throw explain(err, src);
  }

  const info = formatInfo(to as FormatId);
  return { output: result, ext: info.exts[0]!, mime: info.mime };
}

export default { convert } satisfies Engine;
