/**
 * Pure data shared by edges.ts (main thread, must not import the library) and
 * engine.ts (worker). No ImageMagick import here.
 */
import type { FormatId } from '../../core/formats';

export const READABLE = ['png', 'jpg', 'webp', 'avif', 'jxl', 'gif', 'tiff', 'bmp', 'ico', 'heic', 'psd'] as const satisfies readonly FormatId[];
export const WRITABLE = ['png', 'jpg', 'webp', 'avif', 'jxl', 'gif', 'tiff', 'bmp', 'ico', 'pdf'] as const satisfies readonly FormatId[];

export type MagickSource = (typeof READABLE)[number];
export type MagickTarget = (typeof WRITABLE)[number];

/** Sources whose decoded pixels are an exact record (so lossless targets stay lossless). */
export const LOSSLESS_SOURCES: ReadonlySet<string> = new Set(['png', 'gif', 'bmp', 'tiff', 'ico', 'psd']);
/** Sources that may carry a real alpha channel. */
export const ALPHA_SOURCES: ReadonlySet<string> = new Set(['png', 'webp', 'avif', 'jxl', 'gif', 'tiff', 'ico', 'heic', 'psd']);
/** Sources that may hold several frames / pages. ICO, PSD and HEIC always collapse to one image. */
export const MULTI_FRAME_SOURCES: ReadonlySet<string> = new Set(['gif', 'webp', 'avif', 'jxl', 'tiff']);
/** Targets that keep every frame (animation or pages). */
export const MULTI_FRAME_TARGETS: ReadonlySet<string> = new Set(['gif', 'webp', 'avif', 'jxl', 'tiff', 'pdf']);
/** Targets whose transform stage runs (alpha flatten, icon fit, page sizing). */
export const TRANSFORM_TARGETS: ReadonlySet<string> = new Set(['jpg', 'bmp', 'pdf', 'ico']);

export const JPEG_QUALITY = 90;
export const ICO_MAX = 256;
/** PDF pages are sized so the longer side is at most this many points (A4 long edge). */
export const PDF_MAX_POINTS = 842;

export const LIMITS = {
  /** Longest side of any decoded frame. */
  maxSide: 16384,
  /** Pixels in one decoded frame (100 megapixels). */
  maxPixels: 100_000_000,
  /** Pixels across every frame we hold in memory at once. */
  maxTotalPixels: 128_000_000,
  maxFrames: 1000,
  maxInputBytes: 512 * 1024 * 1024,
} as const;

export const lossless = (from: string) => LOSSLESS_SOURCES.has(from);
