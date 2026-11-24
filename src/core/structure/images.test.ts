import { describe, expect, it } from 'vitest';
import { findAll, findSegment, flatten } from './invariants';
import { Bytes, concat, fixture, parseChecked } from './testkit';
import { deflateSync } from 'node:zlib';

describe('PNG', () => {
  it('reads real IHDR values, merges chunk runs and ends with IEND', async () => {
    const bytes = fixture('rgba.png');
    const st = await parseChecked(bytes, 'png');
    const names = st.segments.map((s) => s.name);
    expect(names).toEqual(['PNG signature', 'IHDR', 'tEXt', 'pHYs', 'IDAT', 'IEND']);
    const ihdr = findSegment(st, 'IHDR')!;
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(ihdr.offset).toBe(8);
    expect(ihdr.length).toBe(25);
    expect(ihdr.detail).toContain(`${dv.getUint32(16)}×${dv.getUint32(20)}`);
    expect(ihdr.detail).toContain('8-bit RGBA');
    expect(findSegment(st, 'tEXt')!.count).toBe(2);
    expect(findSegment(st, 'pHYs')!.detail).toBe('144 dpi');
    const iend = findSegment(st, 'IEND')!;
    expect(iend.offset + iend.length).toBe(bytes.length);
    expect(iend.role).toBe('trailer');
    expect(st.summary).toBe('PNG 200×120 8-bit RGBA · 1 IDAT chunk');
  });

  it('reads palette images', async () => {
    const st = await parseChecked(fixture('indexed.png'), 'png');
    expect(findSegment(st, 'PLTE')!.role).toBe('palette');
    expect(findSegment(st, 'tRNS')).toBeDefined();
    expect(st.summary).toContain('indexed');
  });

  it('merges hundreds of IDAT chunks into one counted segment', async () => {
    const raw = new Uint8Array(300 * 40);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) & 255;
    const z = deflateSync(raw, { level: 0 });
    const chunk = (type: string, data: Uint8Array) => new Bytes().u32be(data.length).ascii(type).bytes(data).u32be(0).done();
    const ihdr = new Bytes().u32be(10).u32be(10).u8(8, 6, 0, 0, 0).done();
    const parts = [new Bytes().u8(0x89).ascii('PNG\r\n\x1a\n').done(), chunk('IHDR', ihdr)];
    const per = 40;
    let n = 0;
    for (let o = 0; o < z.length; o += per) {
      parts.push(chunk('IDAT', z.subarray(o, o + per)));
      n++;
    }
    parts.push(chunk('IEND', new Uint8Array(0)));
    const st = await parseChecked(concat(...parts), 'png');
    const idat = findSegment(st, 'IDAT')!;
    expect(idat.count).toBe(n);
    expect(n).toBeGreaterThan(250);
    expect(st.segments).toHaveLength(4);
    expect(st.summary).toContain(`${n} IDAT chunks`);
  });

  it('flags a cut-off chunk and keeps going safely', async () => {
    const bytes = fixture('rgba.png').subarray(0, 9000);
    const st = await parseChecked(bytes, 'png');
    const idat = findSegment(st, 'IDAT')!;
    expect(idat.offset + idat.length).toBe(9000);
    expect(idat.detail).toContain('cut off');
  });
});

describe('JPEG', () => {
  it('lists markers with real values and one pixels segment per scan', async () => {
    const bytes = fixture('baseline.jpg');
    const st = await parseChecked(bytes, 'jpg');
    expect(st.segments[0]).toMatchObject({ name: 'SOI', offset: 0, length: 2 });
    const sof = findSegment(st, 'SOF0')!;
    expect(sof.detail).toContain('200×120');
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getUint16(sof.offset + 5)).toBe(120); // height
    expect(dv.getUint16(sof.offset + 7)).toBe(200); // width
    const sos = findSegment(st, 'SOS')!;
    expect(sos.role).toBe('pixels');
    const eoi = findSegment(st, 'EOI')!;
    expect(eoi.offset).toBe(bytes.length - 2);
    expect(sos.offset + sos.length).toBe(eoi.offset);
    expect(findAll(st, 'DHT').length).toBe(4);
    expect(st.summary).toBe('JPEG 200×120 · baseline · 3 components');
  });

  it('names APP segments by their identifier', async () => {
    const st = await parseChecked(fixture('sips.jpg'), 'jpg');
    expect(findSegment(st, 'APP1 (Exif)')!.detail).toContain('Exif');
    expect(findSegment(st, 'APP13 (Photoshop)')).toBeDefined();
    expect(findSegment(st, 'APP0 (JFIF)')!.role).toBe('header');
    expect(st.summary).toContain('Exif');
  });

  it('handles progressive JPEG with ten scans', async () => {
    const st = await parseChecked(fixture('progressive.jpg'), 'jpg');
    expect(findAll(st, 'SOS')).toHaveLength(10);
    expect(findSegment(st, 'SOF2')!.detail).toContain('progressive');
    expect(st.summary).toContain('10 scans');
  });
});

describe('GIF', () => {
  it('merges animation frames and reads the loop count', async () => {
    const bytes = fixture('anim.gif');
    const st = await parseChecked(bytes, 'gif');
    expect(findSegment(st, 'Logical Screen Descriptor')!.detail).toContain('64×48');
    const frames = findSegment(st, 'Image frame')!;
    expect(frames.count).toBe(6);
    expect(frames.role).toBe('pixels');
    expect(findSegment(st, 'Application Extension')!.detail).toContain('loops forever');
    expect(findSegment(st, 'Trailer')!.offset).toBe(bytes.length - 1);
    expect(st.summary).toBe('GIF 89a 64×48 · 6 frames · loops forever');
  });

  it('parses a still GIF87a', async () => {
    const st = await parseChecked(fixture('still.gif'), 'gif');
    expect(st.summary).toBe('GIF 87a 64×48 · 1 frame');
  });
});

describe('WebP', () => {
  it.each([
    ['lossy.webp', 'VP8', 'lossy'],
    ['lossless.webp', 'VP8L', 'lossless'],
  ])('%s has a %s chunk', async (file, chunk, kind) => {
    const bytes = fixture(file);
    const st = await parseChecked(bytes, 'webp');
    expect(findSegment(st, chunk)!.detail).toContain('200×120');
    expect(st.summary).toBe(`WebP 200×120 · ${kind}`);
    const riff = st.segments[0]!;
    expect(riff).toMatchObject({ offset: 0, length: 12, role: 'signature' });
  });

  it('reads VP8X flags and the ALPH chunk', async () => {
    const st = await parseChecked(fixture('alpha.webp'), 'webp');
    expect(findSegment(st, 'VP8X')!.detail).toContain('canvas 200×120');
    expect(findSegment(st, 'ALPH')!.role).toBe('pixels');
    expect(st.summary).toContain('alpha');
  });

  it('merges animation frames', async () => {
    const st = await parseChecked(fixture('anim.webp'), 'webp');
    const anmf = findSegment(st, 'ANMF')!;
    expect(anmf.count).toBe(6);
    expect(findSegment(st, 'ANIM')!.detail).toContain('loop count ∞');
    expect(st.summary).toBe('WebP 64×48 · animated · 6 frames');
  });
});

describe('BMP', () => {
  it('lays out header, DIB header and pixel array exactly', async () => {
    const bytes = fixture('rgb.bmp');
    const st = await parseChecked(bytes, 'bmp');
    expect(st.segments.map((s) => [s.name, s.offset, s.length])).toEqual([
      ['BITMAPFILEHEADER', 0, 14],
      ['BITMAPINFOHEADER', 14, 40],
      ['pixel array', 54, 72000],
    ]);
    expect(st.summary).toBe('BMP 200×120 · 24 bpp · uncompressed');
  });

  it('finds the colour table of indexed BMPs', async () => {
    const st = await parseChecked(fixture('indexed.bmp'), 'bmp');
    expect(findSegment(st, 'colour table')).toMatchObject({ offset: 54, length: 64, role: 'palette' });
  });
});

describe('ICO', () => {
  it('lists the directory and every embedded image with its size', async () => {
    const bytes = fixture('multi.ico');
    const st = await parseChecked(bytes, 'ico');
    expect(st.segments[0]).toMatchObject({ name: 'ICONDIR', length: 6 });
    expect(findSegment(st, 'ICONDIRENTRY')).toMatchObject({ offset: 6, length: 64, count: 4 });
    const imgs = st.segments.filter((s) => s.name.startsWith('image'));
    expect(imgs.map((s) => s.name)).toEqual(['image 16×16', 'image 32×32', 'image 48×48', 'image 256×256']);
    expect(imgs[3]!.detail).toContain('PNG');
    expect(st.summary).toBe('ICO · 4 images: 16×16, 32×32, 48×48, 256×256');
  });
});

describe('TIFF', () => {
  it('merges LZW strips and reports the IFD', async () => {
    const st = await parseChecked(fixture('rgb.tiff'), 'tiff');
    expect(st.segments[0]).toMatchObject({ name: 'TIFF header', length: 8 });
    const ifd = findSegment(st, 'IFD0')!;
    expect(ifd.detail).toContain('200×120');
    expect(ifd.detail).toContain('LZW');
    expect(findSegment(st, 'IFD0 strips')!.role).toBe('pixels');
    expect(st.summary).toBe('TIFF 200×120 · 3×8-bit RGB · LZW');
  });

  it('follows big-endian files, the Exif IFD and finds the ICC profile', async () => {
    const st = await parseChecked(fixture('sips.tiff'), 'tiff');
    expect(findSegment(st, 'Exif IFD')).toBeDefined();
    expect(findSegment(st, 'ICC profile')!.role).toBe('palette');
    expect(findSegment(st, 'TIFF header')!.detail).toContain('big-endian');
  });

  it('reads BigTIFF', async () => {
    // header(16) + IFD at 16: 3 entries (width, height, strip offsets/counts inline)
    const b = new Bytes().ascii('II').u16le(43).u16le(8).u16le(0).u64le(16);
    b.u64le(5);
    const entry = (tag: number, type: number, count: number, value: number) => b.u16le(tag).u16le(type).u64le(count).u64le(value);
    entry(256, 4, 1, 8);
    entry(257, 4, 1, 8);
    entry(259, 3, 1, 1);
    entry(273, 16, 1, 16 + 8 + 5 * 20 + 8);
    entry(279, 16, 1, 64);
    b.u64le(0);
    b.zeros(64);
    const bytes = b.done();
    const st = await parseChecked(bytes, 'tiff');
    expect(st.segments[0]!.name).toBe('BigTIFF header');
    expect(findSegment(st, 'IFD0 strips')).toMatchObject({ offset: 16 + 8 + 100 + 8, length: 64 });
    expect(st.summary).toContain('BigTIFF 8×8');
  });
});

describe('PSD', () => {
  it('reads the file header, resources and layers', async () => {
    const bytes = fixture('sample.psd');
    const st = await parseChecked(bytes, 'psd');
    expect(st.segments.map((s) => s.name)).toEqual(['File header', 'Colour mode data', 'Image resources', 'Layer and mask information', 'Image data']);
    expect(st.segments[0]!.detail).toContain('200×120');
    expect(findSegment(st, 'ICC profile')!.role).toBe('palette');
    expect(findSegment(st, 'XMP')).toBeDefined();
    expect(st.segments.at(-1)!.offset + st.segments.at(-1)!.length).toBe(bytes.length);
    expect(st.summary).toContain('PSD 200×120');
  });
});

describe('JPEG XL', () => {
  it('decodes the codestream size header of a bare stream', async () => {
    const st = await parseChecked(fixture('sample.jxl'), 'jxl');
    expect(st.summary).toBe('JPEG XL 200×120 · bare codestream');
    expect(st.segments[1]!.role).toBe('pixels');
  });

  it('walks container boxes and spots JPEG reconstruction data', async () => {
    const st = await parseChecked(fixture('jpeg-recompressed.jxl'), 'jxl');
    expect(st.segments.map((s) => s.name)).toEqual(['JXL', 'ftyp', 'jxlp', 'jbrd', 'jxlp']);
    expect(st.summary).toContain('200×120');
    expect(st.summary).toContain('lossless JPEG recompression');
  });
});

describe('SVG', () => {
  it('uses real byte offsets for root children, even with non-ASCII text', async () => {
    const bytes = fixture('sample.svg');
    const st = await parseChecked(bytes, 'svg');
    const root = findSegment(st, 'svg')!;
    expect(root.children!.map((c) => c.name)).toEqual(['title', 'defs', 'rect', 'g', 'text']);
    const text = findSegment(st, 'text')!;
    expect(new TextDecoder().decode(bytes.subarray(text.offset, text.offset + 5))).toBe('<text');
    expect(root.offset + root.length).toBe(bytes.length);
    expect(findSegment(st, 'circle')!.count).toBe(2);
    expect(st.summary).toContain('SVG 120×80');
    expect(flatten(st.segments).every((s) => s.length > 0)).toBe(true);
  });
});
