/**
 * Node-side support for the Playwright specs (images.spec.ts, pdf.spec.ts).
 * Everything here runs in the Playwright process, never in the page, and uses
 * decoders that are independent of the engines under test where possible:
 * the browser's own codecs, mupdf, and a hand-written PNG decoder.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  ImageMagick,
  MagickFormat,
  MagickImage,
  MagickImageCollection,
  MagickReadSettings,
  initializeImageMagick,
} from '@imagemagick/magick-wasm';
import type { Raster } from './test-utils';

let magickReady: Promise<void> | null = null;
export function initNodeMagick(): Promise<void> {
  magickReady ??= initializeImageMagick(new Uint8Array(readFileSync('node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm')));
  return magickReady;
}

/** Decode every frame with a stock ImageMagick in Node. */
export function decodeFrames(bytes: Uint8Array, format?: MagickFormat): { raster: Raster; delay: number }[] {
  return ImageMagick.readCollection(bytes, new MagickReadSettings(format ? { format } : {}), (c) =>
    c.map((img) => {
      const width = img.width;
      const height = img.height;
      const rgba = img.getPixels((p) => new Uint8Array(p.toByteArray(0, 0, width, height, 'RGBA')!));
      return { raster: { width, height, rgba }, delay: img.animationDelay };
    }),
  );
}

/** Encode one raster (and optionally an animation) with stock ImageMagick in Node, to make test inputs. */
export function encodeRaster(r: Raster, format: MagickFormat): Uint8Array {
  return ImageMagick.read(r.rgba, new MagickReadSettings({ format: MagickFormat.Rgba, width: r.width, height: r.height, depth: 8 }), (img) =>
    img.write(format, (d) => d.slice()),
  );
}

export function encodeAnimation(frames: Raster[], delays: number[], format: MagickFormat): Uint8Array {
  const col = MagickImageCollection.create();
  frames.forEach((f, i) => {
    const img = MagickImage.create(f.rgba, new MagickReadSettings({ format: MagickFormat.Rgba, width: f.width, height: f.height, depth: 8 }));
    img.animationDelay = delays[i] ?? 10;
    col.push(img);
  });
  const out = col.write(format, (d) => d.slice());
  col.dispose();
  return out;
}

/** Decode with the browser's own codec (an implementation independent of ImageMagick). null = this browser can't decode the type. */
export async function nativeDecode(page: Page, bytes: Uint8Array, mime: string): Promise<Raster | null> {
  const res = await retryOnReload(
    () => page.waitForLoadState('load'),
    () => nativeDecodeOnce(page, bytes, mime),
  );
  return res ? { width: res.width, height: res.height, rgba: new Uint8Array(Buffer.from(res.b64, 'base64')) } : null;
}

async function nativeDecodeOnce(page: Page, bytes: Uint8Array, mime: string) {
  return page.evaluate(
    async ([b64, type]) => {
      try {
        const bin = atob(b64!);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u8], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d', { colorSpace: 'srgb' })!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        let s = '';
        for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
        return { width: bmp.width, height: bmp.height, b64: btoa(s) };
      } catch {
        return null;
      }
    },
    [Buffer.from(bytes).toString('base64'), mime],
  );
}

export const stageIds = (events: { type: string; stage?: string }[]) => events.filter((e) => e.type === 'stage').map((e) => e.stage!);
export const progressValues = (events: { type: string; value?: number }[]) => events.filter((e) => e.type === 'progress').map((e) => e.value!);
export const assetEvents = (events: { type: string; url?: string; loaded?: number; total?: number | null }[]) =>
  events.filter((e) => e.type === 'asset') as { url: string; loaded: number; total: number | null }[];

/**
 * The dev server reloads the page when any file in the repo changes (other people edit it while specs run).
 * A reload destroys the evaluate context; reopen the harness and try the call again.
 */
export async function retryOnReload<T>(reopen: () => Promise<unknown>, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !/Execution context was destroyed|navigation|Target (page|closed)|harness is undefined|interrupted by another navigation/i.test(String((e as Error).message))) throw e;
      await reopen();
    }
  }
}
