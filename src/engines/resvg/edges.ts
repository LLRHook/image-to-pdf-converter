import type { EdgeSpec } from '../../core/types';

/** Build-time list (keys only, no library import): is any font bundled? */
const HAS_FONTS = Object.keys(import.meta.glob('./fonts/*.{ttf,otf,ttc}')).length > 0;

export const MIN_LONG_SIDE = 1024;
export const MAX_SIDE = 8192;

export const edges: EdgeSpec[] = [
  {
    from: ['svg'],
    to: ['png'],
    cost: 3, // 2.4 MB wasm
    fidelity: 'raster',
    stages: () => [
      { id: 'load', label: 'Load resvg 2.6' },
      { id: 'decode', label: 'Parse SVG' },
      { id: 'transform', label: 'Rasterise vector paths' },
      { id: 'encode', label: 'Encode PNG' },
    ],
    note: () =>
      HAS_FONTS
        ? `Vector becomes pixels, at least ${MIN_LONG_SIDE} px on the long side`
        : `Vector becomes pixels, at least ${MIN_LONG_SIDE} px on the long side. Text elements are skipped: no font is bundled`,
  },
];
