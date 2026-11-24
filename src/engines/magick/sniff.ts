import type { MagickSource } from './meta';

const ascii = (b: Uint8Array, at: number, s: string) => {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * Identify the image by its own magic bytes. We then force that one decoder, so
 * hostile input can never steer ImageMagick into one of its other coders
 * (MVG, MSL, SVG, text, ...) which this app does not want to run.
 */
export function sniffImage(b: Uint8Array): MagickSource | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0x89 && ascii(b, 1, 'PNG\r\n')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 0, 'BM')) return 'bmp';
  // classic TIFF (42) and BigTIFF (43), either byte order
  if ((ascii(b, 0, 'II') && (b[2] === 0x2a || b[2] === 0x2b) && b[3] === 0) || (ascii(b, 0, 'MM') && b[2] === 0 && (b[3] === 0x2a || b[3] === 0x2b))) return 'tiff';
  if (ascii(b, 0, '8BPS')) return 'psd';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] || b[5])) return 'ico';
  if (b[0] === 0xff && b[1] === 0x0a) return 'jxl';
  if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0c && ascii(b, 4, 'JXL ')) return 'jxl';
  if (ascii(b, 4, 'ftyp')) {
    const size = Math.min(b.length, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0 || 32);
    const brands: string[] = [String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!));
    if (brands[0] === 'avif' || brands[0] === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brands[0]!)) return 'heic';
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
    if (brands.some((x) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(x))) return 'heic';
    if (brands[0] === 'mif1' || brands[0] === 'msf1') return 'heic';
  }
  return undefined;
}

/**
 * Cheap, bounds-checked dimension read for the formats where it is a few bytes
 * of header. Lets us reject a decompression bomb with the real numbers before
 * ImageMagick allocates anything. Returns undefined when unsure.
 */
export function peekSize(b: Uint8Array, fmt: MagickSource): { width: number; height: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number, le = false) => (o + 2 <= b.length ? dv.getUint16(o, le) : 0);
  const u32 = (o: number, le = false) => (o + 4 <= b.length ? dv.getUint32(o, le) : 0);
  switch (fmt) {
    case 'png':
      return ascii(b, 12, 'IHDR') ? { width: u32(16), height: u32(20) } : undefined;
    case 'gif':
      return { width: u16(6, true), height: u16(8, true) };
    case 'bmp': {
      const header = u32(14, true);
      if (header === 12) return { width: u16(18, true), height: u16(20, true) };
      if (header >= 40) return { width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) };
      return undefined;
    }
    case 'psd':
      return { width: u32(18), height: u32(14) };
    case 'webp': {
      const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
      if (kind === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
      if (kind === 'VP8L' && b[20] === 0x2f) {
        const v = u32(21, true);
        return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: u16(26, true) & 0x3fff, height: u16(28, true) & 0x3fff };
      return undefined;
    }
    case 'jpg': {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) return undefined;
        const marker = b[p + 1]!;
        if (marker === 0xff) {
          p++;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: u16(p + 7), height: u16(p + 5) };
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          p += 2;
          continue;
        }
        p += 2 + u16(p + 2);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
