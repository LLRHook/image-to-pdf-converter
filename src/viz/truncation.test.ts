import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { parseStructure } from '../core/structure';
import { bytesSource, type ByteSource } from '../core/structure/types';
import { truncationNote } from './scene';

/** A PNG chunk with a zero CRC (the parser does not check CRCs). */
function chunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out;
}

function pngWithChunks(n: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // Alternating names so neighbours are never merged into one segment.
  const extra = Array.from({ length: n }, (_, i) => chunk(i % 2 ? 'tEXt' : 'zTXt', new TextEncoder().encode('k\0v')));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(new Uint8Array(5))), chunk('IEND')];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('why a structure is only partly drawn', () => {
  it('says the read budget ran out, with the real budget', async () => {
    // A 9 MB text file, generated on demand.
    const big: ByteSource = { size: 9 * 1024 * 1024, read: async (_offset, length) => new Uint8Array(length).fill(0x61) };
    const st = await parseStructure(big, 'txt');
    expect(st).toMatchObject({ truncated: true, truncatedBy: 'budget' });
    expect(truncationNote(st)).toBe(' (only the first 8 MB were read)');
  });

  it('says there were too many parts when a segment cap is hit', async () => {
    const st = await parseStructure(bytesSource(pngWithChunks(2500)), 'png');
    expect(st).toMatchObject({ truncated: true, truncatedBy: 'segments' });
    expect(truncationNote(st)).toBe(' (too many to list them all)');
  });

  it('says the rest could not be read when the source fails', async () => {
    const failing: ByteSource = {
      size: 4096,
      read: () => Promise.reject(new Error('file went away')),
    };
    const st = await parseStructure(failing, 'txt');
    expect(st).toMatchObject({ truncated: true, truncatedBy: 'error' });
    expect(truncationNote(st)).toBe(' (the rest couldn’t be read)');
  });

  it('says nothing for a complete parse', async () => {
    const st = await parseStructure(bytesSource(new TextEncoder().encode('hello\nworld\n')), 'txt');
    expect(st.truncated).toBeUndefined();
    expect(st.truncatedBy).toBeUndefined();
    expect(truncationNote(st)).toBe('');
  });
});
