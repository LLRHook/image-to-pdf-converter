/** Preview thumbnail fitting shared by the image, PDF and media engines. */

/** Longest side of a preview thumbnail, in pixels. */
export const THUMB_SIDE = 96;

/** Scale that fits `width` x `height` into a `max` px square; never upscales. */
export function thumbnailScale(width: number, height: number, max = THUMB_SIDE): number {
  return Math.min(1, max / Math.max(width, height));
}

/** Thumbnail dimensions: longer side `max`, never upscaled, never zero, even dimensions not required. */
export function thumbnailSize(width: number, height: number, max = THUMB_SIDE): { width: number; height: number } {
  const s = thumbnailScale(width, height, max);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}
