import { deflateSync } from 'node:zlib';
import { pngFile } from '../../src/engines/magick/test-utils';

/** A real RGBA PNG with a colourful gradient, `idatChunks` IDAT chunks. */
export function makePng(w: number, h: number, idatChunks = 4): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = ((x ^ y) * 7) & 255;
      raw[o + 3] = 255;
    }
  }
  const z = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks: Array<[string, Uint8Array]> = [
    ['IHDR', ihdr],
    ['tEXt', Buffer.from('Software\0any-to-any test', 'latin1')],
  ];
  const step = Math.ceil(z.length / idatChunks);
  for (let i = 0; i < z.length; i += step) chunks.push(['IDAT', z.subarray(i, i + step)]);
  return Buffer.from(pngFile(chunks));
}

export const CSV = 'name,qty,price,note\nApple,3,1.25,=1+1\nPear,10,0.5,"comma, inside"\nFig,7,2,\n';
