import { describe, expect, it } from 'vitest';
import { parseStructure } from './index';
import { structureViolations } from './invariants';
import { Bytes, concat, fixture, utf8 } from './testkit';
import type { ByteSource } from './types';
import type { FormatId } from '../formats';

const GB = 1024 * 1024 * 1024;

/** A source of `size` bytes that is zeros except for a prefix and a suffix; it never stores the middle. */
function sparse(size: number, prefix: Uint8Array, suffix: Uint8Array = new Uint8Array(0)): ByteSource & { bytesRead: number; reads: number } {
  const src = {
    size,
    bytesRead: 0,
    reads: 0,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const end = Math.min(size, offset + length);
      const out = new Uint8Array(Math.max(0, end - offset));
      src.bytesRead += out.length;
      src.reads++;
      if (offset < prefix.length) out.set(prefix.subarray(offset, Math.min(prefix.length, end)), 0);
      const sufStart = size - suffix.length;
      if (end > sufStart) {
        const from = Math.max(offset, sufStart);
        out.set(suffix.subarray(from - sufStart, end - sufStart), from - offset);
      }
      return out;
    },
  };
  return src;
}

async function timed(src: ByteSource, format: FormatId) {
  const t0 = performance.now();
  const st = await parseStructure(src, format);
  return { st, ms: performance.now() - t0 };
}

describe('1 GB sparse files parse from headers only (< 200 ms, < 1 MB read)', () => {
  it('mp4-like: ftyp + moov + a 1 GB 64-bit mdat', async () => {
    const real = fixture('video.mp4');
    const head = real.subarray(0, 2205); // ftyp + moov + free
    const mdat = new Bytes().u32be(1).ascii('mdat').u64be(GB - head.length).done();
    const src = sparse(GB, concat(head, mdat));
    await parseStructure(src, 'mp4'); // warm up the JIT like a real session would
    src.bytesRead = 0;
    const { st, ms } = await timed(src, 'mp4');
    expect(ms).toBeLessThan(200);
    expect(src.bytesRead).toBeLessThan(1_000_000);
    expect(structureViolations(st, GB)).toEqual([]);
    expect(st.segments.map((s) => s.name)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
    expect(st.segments.at(-1)).toMatchObject({ offset: head.length, length: GB - head.length, role: 'samples' });
    expect(st.truncated).toBeUndefined();
  });

  it('mov and m4a flavours', async () => {
    const mov = fixture('video.mov');
    const head = concat(mov.subarray(0, 28), new Bytes().u32be(1).ascii('mdat').u64be(GB - 28).done());
    const { st, ms } = await timed(sparse(GB, head), 'mov');
    expect(ms).toBeLessThan(200);
    expect(st.segments.map((s) => s.name)).toEqual(['ftyp', 'wide', 'mdat']);
  });

  it('mkv-like: EBML header, tracks, then a gigantic Cluster', async () => {
    const w = fixture('video.webm');
    const clusterAt = 668;
    const segHdr = new Bytes().u8(0x18, 0x53, 0x80, 0x67).u8(0x01).u64be(GB - 36 - 12).done().subarray(0, 12);
    const head = concat(w.subarray(0, 36), segHdr, w.subarray(48, clusterAt));
    const cluster = new Bytes().u8(0x1f, 0x43, 0xb6, 0x75).u8(0x01, 0, 0).u32be(GB - head.length - 12).u8(0).done();
    const src = sparse(GB, concat(head, cluster));
    const { st, ms } = await timed(src, 'mkv');
    expect(ms).toBeLessThan(200);
    expect(src.bytesRead).toBeLessThan(1_000_000);
    expect(structureViolations(st, GB)).toEqual([]);
    expect(st.segments[0]!.name).toBe('EBML');
    expect(st.segments[1]!.name).toBe('Segment');
  });

  it('wav and flac with a 1 GB audio body', async () => {
    const wav = new Bytes().ascii('RIFF').u32le(0xffffffff).ascii('WAVE').ascii('fmt ').u32le(16).u16le(1).u16le(2).u32le(44100).u32le(176400).u16le(4).u16le(16).ascii('data').u32le(GB - 44).done();
    const w = await timed(sparse(GB, wav), 'wav');
    expect(w.ms).toBeLessThan(200);
    expect(w.st.segments.at(-1)).toMatchObject({ name: 'data', length: GB - 36 });
    expect(w.st.summary).toContain('44.1 kHz stereo 16-bit');

    const si = new Bytes().u16be(4096).u16be(4096).u8(0, 0, 0, 0, 0, 0).u8(0x0a, 0xc4, 0x42, 0xf0).u32be(0).zeros(16).done();
    const flac = concat(utf8('fLaC'), new Uint8Array([0x80, 0, 0, 34]), si, new Uint8Array([0xff, 0xf8]));
    const f = await timed(sparse(GB, flac), 'flac');
    expect(f.ms).toBeLessThan(200);
    expect(f.st.segments.map((s) => s.name)).toEqual(['fLaC', 'STREAMINFO', 'frames']);
  });

  it('pdf with a 1 GB stream is skipped via /Length', async () => {
    const pre = utf8('%PDF-1.7\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 40000 /Height 25000 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /Length ');
    const post = utf8('\nendstream\nendobj\n2 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 3 /Root 2 0 R >>\nstartxref\n0\n%%EOF\n');
    const mid = utf8('>>\nstream\n');
    const total = GB;
    const len = total - pre.length - String(total).length - mid.length - post.length;
    const head = concat(pre, utf8(String(len)), mid);
    const src = sparse(total, head, post);
    const { st, ms } = await timed(src, 'pdf');
    expect(ms).toBeLessThan(200);
    expect(src.bytesRead).toBeLessThan(1_000_000);
    expect(structureViolations(st, total)).toEqual([]);
    const img = st.segments.find((s) => s.name === '1 0 obj')!;
    expect(img.detail).toContain('/Subtype /Image 40000×25000');
    expect(st.segments.some((s) => s.name === '%%EOF')).toBe(true);
    expect(st.truncated).toBeUndefined();
  });

  it('zip with two 500 MB entries reads only local headers and the central directory', async () => {
    const entry = (name: string, size: number) => new Bytes().u32le(0x04034b50).u16le(20).u16le(0).u16le(0).u16le(0).u16le(0).u32le(0).u32le(size).u32le(size).u16le(name.length).u16le(0).ascii(name);
    const a = entry('big-a.bin', 500_000_000).done();
    const bOffset = a.length + 500_000_000;
    const b = entry('big-b.bin', GB - bOffset - 30 - 9 - 2 * (46 + 9) - 22).done();
    const bSize = GB - bOffset - b.length - 2 * (46 + 9) - 22;
    const cd = (name: string, size: number, off: number) => new Bytes().u32le(0x02014b50).u16le(20).u16le(20).u16le(0).u16le(0).u16le(0).u16le(0).u32le(0).u32le(size).u32le(size).u16le(name.length).u16le(0).u16le(0).u16le(0).u16le(0).u32le(0).u32le(off).ascii(name).done();
    const cdA = cd('big-a.bin', 500_000_000, 0);
    const cdB = cd('big-b.bin', bSize, bOffset);
    const eocd = new Bytes().u32le(0x06054b50).u16le(0).u16le(0).u16le(2).u16le(2).u32le(cdA.length + cdB.length).u32le(GB - 22 - cdA.length - cdB.length).u16le(0).done();
    const suffix = concat(cdA, cdB, eocd);
    const src = sparse(GB, concat(a), concat(suffix));
    // second local header lives in the middle of the file
    const withB: ByteSource & { bytesRead: number } = {
      size: GB,
      bytesRead: 0,
      async read(offset, length) {
        const out = await src.read(offset, length);
        if (offset <= bOffset && offset + length > bOffset) out.set(b.subarray(0, Math.min(b.length, offset + length - bOffset)), bOffset - offset);
        withB.bytesRead += out.length;
        return out;
      },
    };
    const { st, ms } = await timed(withB, 'zip');
    expect(ms).toBeLessThan(200);
    expect(withB.bytesRead).toBeLessThan(1_000_000);
    expect(structureViolations(st, GB)).toEqual([]);
    expect(st.segments.map((s) => s.name)).toEqual(['big-a.bin', 'big-b.bin', 'Central directory', 'End of central directory']);
    expect(st.segments[0]).toMatchObject({ offset: 0, length: bOffset });
  });
});

describe('read budget on hostile many-chunk files', () => {
  it('stops after the read cap on a PNG made of 200,000 tiny chunks', async () => {
    const chunk = new Bytes().u32be(0).ascii('tEXt').u32be(0).done();
    const parts = [new Bytes().u8(0x89).ascii('PNG\r\n\x1a\n').done(), new Bytes().u32be(13).ascii('IHDR').u32be(1).u32be(1).u8(8, 6, 0, 0, 0).u32be(0).done()];
    const body = new Uint8Array(chunk.length * 200_000);
    for (let i = 0; i < 200_000; i++) body.set(chunk, i * chunk.length);
    parts.push(body);
    const t0 = performance.now();
    const st = await parseStructure({ size: parts.reduce((a, p) => a + p.length, 0), read: async (o, n) => concat(...parts).subarray(o, o + n) }, 'png');
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(st.segments.length).toBeLessThan(2000);
    expect(structureViolations(st)).toEqual([]);
  });
});
