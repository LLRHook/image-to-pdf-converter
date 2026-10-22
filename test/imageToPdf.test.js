import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { imageToPdf } from '../src/conversion/imageToPdf.js';
import { MAX_FILE_SIZE } from '../src/shared/constants.js';

const png = await readFile(new URL('../public/icons/icon16.png', import.meta.url));

for (const type of ['image/png', 'application/octet-stream', 'image/jpeg', '']) {
  test(`converts PNG bytes with MIME type ${type || '(missing)'}`, async () => {
    const blob = await imageToPdf(new Blob([png], { type }));
    assert.equal(blob.type, 'application/pdf');
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    assert.equal(pdf.getPageCount(), 1);
    assert.equal(pdf.getPage(0).getWidth(), 16);
    assert.equal(pdf.getPage(0).getHeight(), 16);
  });
}

test('rejects an oversized input before reading it', async () => {
  let read = false;
  const file = {
    size: MAX_FILE_SIZE + 1,
    async arrayBuffer() { read = true; throw new Error('must not read'); },
  };
  await assert.rejects(imageToPdf(file), /16 MB/);
  assert.equal(read, false);
});

test('rejects empty and unsupported images with actionable errors', async () => {
  await assert.rejects(imageToPdf(new Blob()), /empty/i);
  await assert.rejects(imageToPdf(new Blob(['GIF89a'], { type: 'image/png' })), /PNG or JPEG/i);
});

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function makePng({ width = 1, height = 1, colorType = 6, depth = 8, interlace = 0, compressed, metadata = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = Buffer.alloc((Math.ceil(width * channels * depth / 8) + 1) * height);
  const palette = colorType === 3 ? [chunk('PLTE', Buffer.from([0, 0, 0]))] : [];
  return Buffer.concat([
    png.subarray(0, 8), chunk('IHDR', header), ...palette, ...metadata,
    chunk('IDAT', compressed || deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [colorType, depth] of [[0, 1], [0, 16], [2, 8], [3, 2], [4, 16], [6, 8], [6, 16]]) {
  test(`converts PNG color type ${colorType}, bit depth ${depth}`, async () => {
    const pdf = await imageToPdf(new Blob([makePng({ colorType, depth })]));
    assert.equal((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount(), 1);
  });
}

test('converts a one-pixel Adam7 interlaced PNG', async () => {
  const pdf = await imageToPdf(new Blob([makePng({ interlace: 1 })]));
  assert.equal((await PDFDocument.load(await pdf.arrayBuffer())).getPage(0).getWidth(), 1);
});

test('strips irrelevant PNG metadata before it reaches the PDF decoder', async () => {
  const source = makePng({ metadata: [chunk('tEXt', Buffer.from('no-null-terminator'))] });
  const pdf = await imageToPdf(new Blob([source]));
  assert.equal((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount(), 1);
});

for (const [width, height] of [[16385, 1], [8000, 8000], [0, 1]]) {
  test(`rejects unsafe PNG dimensions ${width} × ${height} before decoding pixels`, async () => {
    const header = Buffer.from(png.subarray(16, 29));
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    const source = Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), png.subarray(33)]);
    await assert.rejects(imageToPdf(new Blob([source])), /too large|invalid dimensions/i);
  });
}

test('rejects truncated chunks, invalid checksums and missing PNG trailers', async () => {
  const badCrc = Buffer.from(png);
  badCrc[29] ^= 1;
  const badLength = Buffer.from(png);
  badLength.writeUInt32BE(0xffffffff, 33);
  for (const source of [png.subarray(0, 24), png.subarray(0, -12), badCrc, badLength]) {
    await assert.rejects(imageToPdf(new Blob([source])), /Invalid or truncated PNG/i);
  }
});

test('rejects corrupt deflate and excess decompressed pixels without hanging', { timeout: 2000 }, async () => {
  for (const compressed of [Buffer.from([0, 0, 0]), deflateSync(Buffer.alloc(100_000)), deflateSync(Buffer.alloc(1))]) {
    await assert.rejects(imageToPdf(new Blob([makePng({ compressed })])), /corrupted PNG pixel data/i);
  }
});

test('rejects animated PNGs before allocating any frame buffers', async () => {
  const control = Buffer.alloc(8);
  control.writeUInt32BE(1_000_000);
  await assert.rejects(imageToPdf(new Blob([makePng({ metadata: [chunk('acTL', control)] })])), /Animated PNG/i);
});

test('reports a truncated JPEG as corrupt rather than leaking a decoder exception', async () => {
  await assert.rejects(imageToPdf(new Blob([Uint8Array.of(0xff, 0xd8, 0xff)])), /corrupted JPEG/i);
});
