import { Resvg, initWasm } from '@resvg/resvg-wasm';
import wasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';
import { MAX_SIDE, MIN_LONG_SIDE } from './edges';

let ready: Promise<void> | null = null;

export function initResvg(fetchAsset: (url: string) => Promise<Uint8Array>): Promise<void> {
  ready ??= fetchAsset(wasmUrl)
    .then((bytes) => initWasm(bytes))
    .catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}

export interface Plan {
  /** Intrinsic size of the SVG in px. */
  width: number;
  height: number;
  /** How to render so the long side lands in [1024, 8192]. */
  fitTo: { mode: 'original' } | { mode: 'width'; value: number } | { mode: 'height'; value: number };
}

/** Long side >= 1024 (upscaled as vectors, not pixels), capped at 8192. */
export function plan(width: number, height: number): Plan {
  const long = Math.max(width, height);
  const target = Math.min(MAX_SIDE, Math.max(MIN_LONG_SIDE, long));
  if (target === long) return { width, height, fitTo: { mode: 'original' } };
  return { width, height, fitTo: width >= height ? { mode: 'width', value: target } : { mode: 'height', value: target } };
}

/**
 * resvg in wasm has no system fonts, so `<text>` is skipped unless font buffers
 * are supplied. With a font loaded, any unknown family falls back to it.
 */
export function open(svg: Uint8Array, fonts: Uint8Array[], fitTo?: Plan['fitTo']) {
  return new Resvg(svg, { fitTo, font: { fontBuffers: fonts }, imageRendering: 0, shapeRendering: 2, textRendering: 1 });
}
