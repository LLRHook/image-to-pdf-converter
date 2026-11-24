/** Real PNG generation for tests. Pure: importable from Vitest and Playwright alike. */
import { zlibSync } from 'fflate';
import { pngFile } from '../../magick/test-utils';

/** A real, decodable w x h RGB PNG. */
export function makePng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return pngFile([
    ['IHDR', ihdr],
    ['IDAT', zlibSync(raw)],
  ]);
}
