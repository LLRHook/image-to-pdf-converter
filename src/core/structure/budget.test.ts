import { describe, expect, it } from 'vitest';
import { FORMATS, type FormatId } from '../formats';
import { parseStructure } from './index';
import { structureViolations } from './invariants';
import { Bytes, SAMPLES, concat, countingSource, rng, utf8 } from './testkit';

const MB = 1024 * 1024;
/** 8 MB budget plus the small reserved tail window parsers may use after it runs out. */
const CAP = 8 * MB + 256 * 1024;

describe('read budget', () => {
  it('JPEG larger than the budget: stays under the cap, flags truncation, still finds the EOI', async () => {
    const head = new Bytes().u8(0xff, 0xd8).u8(0xff, 0xc2, 0, 11, 8, 0x10, 0, 0x10, 0, 1, 1, 0x11, 0).u8(0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0).done();
    const scan = new Uint8Array(20 * MB).fill(0x55);
    const bytes = concat(head, scan, new Uint8Array([0xff, 0xd9]));
    const src = countingSource(bytes);
    const st = await parseStructure(src, 'jpg');
    expect(src.bytesRead).toBeLessThanOrEqual(CAP);
    expect(st.truncated).toBe(true);
    expect(structureViolations(st, bytes.length)).toEqual([]);
    const names = st.segments.map((s) => s.name);
    expect(names).toEqual(['SOI', 'SOF2', 'SOS', 'EOI']);
    expect(st.segments[2]!.role).toBe('pixels');
    expect(st.segments[3]).toMatchObject({ offset: bytes.length - 2, length: 2 });
  });

  it('PDF with indirect stream lengths over the budget: bounded, with the file end still described', async () => {
    const parts: Uint8Array[] = [utf8('%PDF-1.4\n')];
    for (let i = 1; i <= 4; i++) {
      parts.push(utf8(`${i} 0 obj\n<< /Length ${i + 10} 0 R >>\nstream\n`), new Uint8Array(4 * MB).fill(0x41), utf8('\nendstream\nendobj\n'));
    }
    parts.push(utf8('trailer\n<< /Size 20 >>\nstartxref\n0\n%%EOF\n'));
    const bytes = concat(...parts);
    const src = countingSource(bytes);
    const st = await parseStructure(src, 'pdf');
    expect(src.bytesRead).toBeLessThanOrEqual(CAP);
    expect(st.truncated).toBe(true);
    expect(structureViolations(st, bytes.length)).toEqual([]);
    expect(st.segments.at(-1)!.name).toBe('%%EOF');
    expect(st.segments.some((s) => s.name === 'startxref')).toBe(true);
  });

  it('GIF with 100,000 frames merges them and stays bounded', async () => {
    const frame = new Bytes().u8(0x21, 0xf9, 4, 0, 1, 0, 0, 0).u8(0x2c).u16le(0).u16le(0).u16le(1).u16le(1).u8(0).u8(2, 2, 0x44, 1, 0).done();
    const head = new Bytes().ascii('GIF89a').u16le(1).u16le(1).u8(0, 0, 0).done();
    const body = new Uint8Array(frame.length * 100_000);
    for (let i = 0; i < 100_000; i++) body.set(frame, i * frame.length);
    const bytes = concat(head, body, new Uint8Array([0x3b]));
    const src = countingSource(bytes);
    const st = await parseStructure(src, 'gif');
    expect(src.bytesRead).toBeLessThanOrEqual(CAP);
    expect(structureViolations(st, bytes.length)).toEqual([]);
    expect(st.segments.length).toBeLessThan(10);
  });

  it('every parser stays under the cap and finishes quickly on a 12 MB hostile file', async () => {
    const r = rng(99);
    const noise = new Uint8Array(12 * MB);
    for (let i = 0; i < noise.length; i += 3) noise[i] = Math.floor(r() * 256);
    const slow: string[] = [];
    for (const f of FORMATS) {
      const seed = SAMPLES[f.id]!().subarray(0, 4096);
      const bytes = concat(seed, noise.subarray(0, 12 * MB - seed.length));
      const src = countingSource(bytes);
      const t0 = performance.now();
      const st = await parseStructure(src, f.id as FormatId);
      const dt = performance.now() - t0;
      expect(src.bytesRead, f.id).toBeLessThanOrEqual(CAP);
      expect(structureViolations(st, bytes.length), f.id).toEqual([]);
      if (dt > 3000) slow.push(`${f.id}: ${dt.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);
});

describe('pathological text stays near-linear', () => {
  const big = (unit: string, bytes: number): Uint8Array => utf8(unit.repeat(Math.ceil(bytes / unit.length)));
  const cases: Array<[string, FormatId, Uint8Array]> = [
    ['tex with 100k sections', 'tex', concat(utf8('\\documentclass{article}\n\\begin{document}\n'), big('\\section{S}\ntext line\n', 3 * MB), utf8('\\end{document}\n'))],
    ['markdown with 150k headings', 'md', big('## H\ntext\n', 2 * MB)],
    ['markdown with 150k nested levels', 'md', big('# a\n## b\n### c\n#### d\n', 2 * MB)],
    ['xml with stray closers and deep nesting', 'xml', concat(utf8('<a>'.repeat(5000)), big('</zz>', 3 * MB))],
    ['html of 200k unclosed paragraphs', 'html', big('<p>x', 3 * MB)],
    ['yaml with 100k keys and sequences', 'yaml', big('key: value\nlist:\n  - a\n  - b\n', 3 * MB)],
    ['yaml with one huge sequence', 'yaml', concat(utf8('items:\n'), big('  - item\n', 3 * MB))],
    ['json with 400k small objects', 'json', concat(utf8('['), big('{"a":[1,2,3],"b":{"c":null}},', 5 * MB), utf8('0]'))],
    ['json with deep nesting', 'json', utf8('['.repeat(1_000_000) + ']'.repeat(1_000_000))],
    ['csv with unbalanced quotes', 'csv', big('a,"b,c\nd,e,f\n', 3 * MB)],
    ['txt of one-char lines', 'txt', big('x\n', 4 * MB)],
    ['rtf of nested groups', 'rtf', concat(utf8('{\\rtf1'), big('{\\b x}', 3 * MB), utf8('}'))],
  ];
  it.each(cases)('%s', async (_name, fmt, bytes) => {
    const t0 = performance.now();
    const st = await parseStructure(countingSource(bytes), fmt);
    const dt = performance.now() - t0;
    expect(structureViolations(st, bytes.length)).toEqual([]);
    expect(dt, `${dt.toFixed(0)} ms`).toBeLessThan(3000);
  }, 30_000);
});
