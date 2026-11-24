/**
 * ImageMagick wasm bootstrap. The 32-bit build (`magick.wasm`) is the one we
 * ship; the x64 build needs memory64 which Safari and Firefox lack.
 */
import { initializeImageMagick, ResourceLimits } from '@imagemagick/magick-wasm';
import wasmUrl from '@imagemagick/magick-wasm/magick.wasm?url';
import type { EngineContext } from '../../core/types';
import { LIMITS } from './meta';

let ready: Promise<void> | null = null;

export function initMagick(ctx: Pick<EngineContext, 'fetchAsset'>): Promise<void> {
  ready ??= (async () => {
    const wasm = await ctx.fetchAsset(wasmUrl);
    await initializeImageMagick(wasm);
    // Hard backstops: ImageMagick refuses to allocate beyond these, so a
    // decompression bomb fails fast instead of exhausting the tab.
    ResourceLimits.width = BigInt(LIMITS.maxSide);
    ResourceLimits.height = BigInt(LIMITS.maxSide);
    ResourceLimits.area = BigInt(LIMITS.maxPixels);
    ResourceLimits.memory = 1536n * 1024n * 1024n;
    ResourceLimits.maxMemoryRequest = 1024n * 1024n * 1024n;
    ResourceLimits.disk = 0n; // the "disk" is wasm memory too; never spill pixels there
    ResourceLimits.listLength = BigInt(LIMITS.maxFrames);
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}
