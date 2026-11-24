/**
 * Test-only helpers (Node). The PNG codec here is independent of ImageMagick so
 * engine output can be verified without trusting the engine's own decoder.
 */
import { unzlibSync, zlibSync } from 'fflate';

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 8 bit. */
  rgba: Uint8Array;
}

/** Deterministic image: smooth colour field, noisy blue, three alpha bands (0 / 128 / 255). */
export function sampleRaster(width = 96, height = 64, alphaBands = true): Raster {
  const rgba = new Uint8Array(width * height * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.round((x * 255) / (width - 1));
      rgba[i + 1] = Math.round((y * 255) / (height - 1));
      rgba[i + 2] = rnd();
      rgba[i + 3] = !alphaBands ? 255 : x < width / 6 ? 0 : x < width / 3 ? 128 : 255;
    }
  }
  return { width, height, rgba };
}

/** Smooth, low-frequency image: survives lossy codecs with small error. */
export function smoothRaster(width = 128, height = 96): Raster {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.round((x * 255) / (width - 1));
      rgba[i + 1] = Math.round((y * 255) / (height - 1));
      rgba[i + 2] = 128;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** Smooth gradient with the same three alpha bands as sampleRaster: kind to lossy codecs, still exercises transparency. */
export function smoothAlphaRaster(width = 96, height = 64): Raster {
  const r = smoothRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) r.rgba[(y * width + x) * 4 + 3] = x < width / 6 ? 0 : x < width / 3 ? 128 : 255;
  }
  return r;
}

export function solidRaster(width: number, height: number, [r, g, b, a]: [number, number, number, number]): Raster {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }
  return { width, height, rgba };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8-bit RGBA PNG encoder (filter 0). */
export function encodePng(r: Raster): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, r.width);
  dv.setUint32(4, r.height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array((r.width * 4 + 1) * r.height);
  for (let y = 0; y < r.height; y++) raw.set(r.rgba.subarray(y * r.width * 4, (y + 1) * r.width * 4), y * (r.width * 4 + 1) + 1);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 8-bit PNG decoder (gray, RGB, palette, gray+alpha, RGBA; all five filters). Throws on anything else. */
export function decodePng(bytes: Uint8Array): Raster {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => bytes[i] === v)) throw new Error('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= bytes.length; ) {
    const len = dv.getUint32(p);
    const t = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (t === 'PLTE') palette = body;
    else if (t === 'tRNS') trns = body;
    else if (t === 'IDAT') idat.push(body);
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  if (interlace !== 0 || ![1, 2, 4, 8].includes(depth) || (depth !== 8 && type !== 0 && type !== 3)) {
    throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  }
  const cat = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) {
    cat.set(c, o);
    o += c.length;
  }
  const raw = unzlibSync(cat);
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!bpp) throw new Error(`unsupported PNG colour type ${type}`);
  const bits = depth; // sub-byte depths only occur with bpp === 1
  const stride = Math.ceil((width * bpp * bits) / 8);
  const fb = depth === 8 ? bpp : 1; // filter byte distance
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= fb ? px[y * stride + x - fb]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= fb && y > 0 ? px[(y - 1) * stride + x - fb]! : 0;
      let v = line[x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  const sample = (y: number, x: number) => {
    if (bits === 8) return px[y * stride + x]!;
    const bit = x * bits;
    return (px[y * stride + (bit >> 3)]! >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
  };
  for (let i = 0; i < width * height; i++) {
    const d = i * 4;
    if (bits !== 8) {
      const v = sample(Math.floor(i / width), i % width);
      if (type === 3) rgba.set([palette![v * 3]!, palette![v * 3 + 1]!, palette![v * 3 + 2]!, trns && v < trns.length ? trns[v]! : 255], d);
      else {
        const g = Math.round((v * 255) / ((1 << bits) - 1));
        rgba.set([g, g, g, 255], d);
      }
      continue;
    }
    const s = i * bpp;
    if (type === 6) rgba.set(px.subarray(s, s + 4), d);
    else if (type === 2) rgba.set([px[s]!, px[s + 1]!, px[s + 2]!, 255], d);
    else if (type === 0) rgba.set([px[s]!, px[s]!, px[s]!, 255], d);
    else if (type === 4) rgba.set([px[s]!, px[s]!, px[s]!, px[s + 1]!], d);
    else {
      const idx = px[s]!;
      rgba.set([palette![idx * 3]!, palette![idx * 3 + 1]!, palette![idx * 3 + 2]!, trns && idx < trns.length ? trns[idx]! : 255], d);
    }
  }
  return { width, height, rgba };
}

/** Largest per-channel difference, and the mean, ignoring RGB under fully transparent pixels. */
export function compare(a: Raster, b: Raster): { max: number; mean: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    const bothClear = a.rgba[i + 3] === 0 && b.rgba[i + 3] === 0;
    for (let c = 0; c < (bothClear ? 0 : 4); c++) {
      const d = Math.abs(a.rgba[i + c]! - b.rgba[i + c]!);
      if (d > max) max = d;
      sum += d;
      n++;
    }
  }
  return { max, mean: n ? sum / n : 0 };
}

/** What a viewer shows on a white page: alpha-composited over white, alpha forced opaque. */
export function overWhite(r: Raster): Raster {
  const out = new Uint8Array(r.rgba.length);
  for (let i = 0; i < r.rgba.length; i += 4) {
    const a = r.rgba[i + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(r.rgba[i + c]! * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return { width: r.width, height: r.height, rgba: out };
}

/** Insert an EXIF APP1 segment with the given orientation tag right after the JPEG SOI. */
export function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = Uint8Array.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD0 at 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation SHORT x1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const payload = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
  const len = payload.length + 2;
  const seg = new Uint8Array([0xff, 0xe1, len >> 8, len & 255, ...payload]);
  // Drop any existing APP1 so ours is the only EXIF block.
  const out: number[] = [0xff, 0xd8];
  let p = 2;
  while (p < jpeg.length && jpeg[p] === 0xff && jpeg[p + 1] !== 0xda) {
    const l = (jpeg[p + 2]! << 8) | jpeg[p + 3]!;
    if (jpeg[p + 1] !== 0xe1) for (let i = 0; i < l + 2; i++) out.push(jpeg[p + i]!);
    p += l + 2;
  }
  const head = Uint8Array.from(out);
  const res = new Uint8Array(head.length + seg.length + (jpeg.length - p));
  res.set(head, 0);
  res.set(seg, head.length);
  res.set(jpeg.subarray(p), head.length + seg.length);
  return res;
}

/** PNG whose header claims a huge canvas but carries almost no data (decompression bomb). */
export function bombPng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0; // 8-bit gray
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(new Uint8Array(1000))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const hex = (b: Uint8Array, n = 8) => Buffer.from(b.subarray(0, n)).toString('hex');

/**
 * Tiny GIF whose frames are 1x1 pixels on a huge logical screen: cheap to build, but every
 * frame expands to the full canvas when coalesced (the memory a frame budget must account for).
 */
export function hugeCanvasGif(canvas: number, frames: number): Uint8Array {
  const out: number[] = [...Buffer.from('GIF89a'), canvas & 255, canvas >> 8, canvas & 255, canvas >> 8, 0x80, 0, 0, 255, 255, 255, 0, 0, 0];
  for (let i = 0; i < frames; i++) out.push(0x21, 0xf9, 4, 0x04, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0);
  out.push(0x3b);
  return Uint8Array.from(out);
}
