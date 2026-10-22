import { validateImageDimensions } from '../shared/validation.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function isPng(bytes) {
  return bytes.length >= 8 && SIGNATURE.every((value, index) => bytes[index] === value);
}

// pdf-lib's PNG decoder also parses ancillary metadata. Only pass the chunks
// needed to render pixels, after checking their bounds, checksums and dimensions.
export async function preparePng(bytes) {
  const invalid = () => { throw new Error('Invalid or truncated PNG image'); };
  if (!isPng(bytes)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [bytes.subarray(0, 8)];
  let offset = 8;
  let hasHeader = false;
  let hasData = false;
  let hasPalette = false;
  let colorType;
  let expectedBytes;
  const imageData = [];

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) invalid();
    if (!hasHeader && type !== 'IHDR') invalid();

    if (type === 'IHDR') {
      if (hasHeader || length !== 13) invalid();
      validateImageDimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      const depth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[colorType]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      const bitsPerPixel = depth * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
      const passes = bytes[offset + 20] === 0
        ? [[0, 0, 1, 1]]
        : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
      expectedBytes = passes.reduce((total, [x, y, dx, dy]) => {
        const columns = Math.max(0, Math.ceil((width - x) / dx));
        const rows = Math.max(0, Math.ceil((height - y) / dy));
        return total + (columns && rows ? (Math.ceil(columns * bitsPerPixel / 8) + 1) * rows : 0);
      }, 0);
      hasHeader = true;
    } else if (type === 'PLTE') {
      if (hasPalette || hasData || length === 0 || length > 768 || length % 3 !== 0) invalid();
      hasPalette = true;
    } else if (type === 'tRNS') {
      if (hasData || (colorType === 0 ? length !== 2 : colorType === 2 ? length !== 6 : colorType !== 3 || !hasPalette || length > 256)) invalid();
    } else if (type === 'IDAT') {
      if (colorType === 3 && !hasPalette) invalid();
      hasData ||= length > 0;
      imageData.push(bytes.subarray(offset + 8, end - 4));
    } else if (type === 'IEND') {
      if (length !== 0 || !hasData || end !== bytes.length) invalid();
      await validateCompressedPixels(imageData, expectedBytes);
      chunks.push(bytes.subarray(offset, end));
      const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let position = 0;
      for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
      return result;
    } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw new Error('Animated PNG images are not supported');
    } else if ((bytes[offset + 4] & 32) === 0) {
      throw new Error(`Unsupported PNG chunk: ${type}`);
    }

    if (['IHDR', 'PLTE', 'tRNS', 'IDAT'].includes(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  invalid();
}

async function validateCompressedPixels(chunks, expectedBytes) {
  // Reject corrupt/truncated deflate streams before entering pdf-lib's older
  // synchronous inflater. Stream the check to bound decompressed memory too.
  const reader = new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedBytes) throw new Error('Unexpected PNG pixel data length');
    }
    if (size !== expectedBytes) throw new Error('Unexpected PNG pixel data length');
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('Invalid or corrupted PNG pixel data');
  } finally {
    reader.releaseLock();
  }
}
