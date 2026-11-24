import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FormatId } from '../formats';
import { parseStructure } from './index';
import { structureViolations } from './invariants';
import { bytesSource, type ByteSource, type FileStructure } from './types';
import { concat } from './util';

export { concat };

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIR, name)));
}

/** Parse bytes and assert the universal invariants hold. */
export async function parseChecked(bytes: Uint8Array, format: FormatId): Promise<FileStructure> {
  const st = await parseStructure(bytesSource(bytes), format);
  const bad = structureViolations(st, bytes.length);
  if (bad.length) throw new Error(`${format}: ${bad.slice(0, 5).join('; ')}`);
  return st;
}

/** A ByteSource over `bytes` that records how much was read. */
export function countingSource(bytes: Uint8Array): ByteSource & { bytesRead: number; reads: number } {
  const src = {
    size: bytes.length,
    bytesRead: 0,
    reads: 0,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const out = bytes.subarray(offset, Math.min(bytes.length, offset + length));
      src.bytesRead += out.length;
      src.reads++;
      return out;
    },
  };
  return src;
}

/** Big-endian / little-endian writers for building synthetic files. */
export class Bytes {
  private parts: number[] = [];
  u8(...v: number[]): this {
    this.parts.push(...v.map((x) => x & 0xff));
    return this;
  }
  u16be(v: number): this {
    return this.u8(v >> 8, v);
  }
  u16le(v: number): this {
    return this.u8(v, v >> 8);
  }
  u32be(v: number): this {
    return this.u8(v >>> 24, v >>> 16, v >>> 8, v);
  }
  u32le(v: number): this {
    return this.u8(v, v >>> 8, v >>> 16, v >>> 24);
  }
  u64be(v: number): this {
    return this.u32be(Math.floor(v / 4294967296)).u32be(v >>> 0);
  }
  u64le(v: number): this {
    return this.u32le(v >>> 0).u32le(Math.floor(v / 4294967296));
  }
  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i) & 0xff);
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]! & 0xff);
    return this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.parts.push(0);
    return this;
  }
  get length(): number {
    return this.parts.length;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** Deterministic PRNG for reproducible fuzzing. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A minimal OLE2 compound file: header, FAT, directory, and a 4096-byte 'Workbook' stream. */
export function buildXls(): Uint8Array {
  const S = 512;
  const header = new Bytes().u8(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1).zeros(16).u16le(0x3e).u16le(3).u16le(0xfffe).u16le(9).u16le(6).zeros(6);
  header.u32le(0).u32le(1).u32le(1).u32le(0).u32le(4096).u32le(0xfffffffe).u32le(0).u32le(0xfffffffe).u32le(0);
  header.u32le(0); // DIFAT[0] = sector 0 (the FAT)
  while (header.length < S) header.u32le(0xffffffff);
  const fat = new Bytes();
  const entries = new Array(128).fill(0xffffffff);
  entries[0] = 0xfffffffd; // FAT sector
  entries[1] = 0xfffffffe; // directory
  for (let i = 2; i < 9; i++) entries[i] = i + 1;
  entries[9] = 0xfffffffe;
  for (const e of entries) fat.u32le(e);
  const dir = new Bytes();
  const entry = (name: string, type: number, start: number, size: number) => {
    const e = new Bytes();
    for (const ch of name) e.u16le(ch.charCodeAt(0));
    e.u16le(0);
    while (e.length < 64) e.u8(0);
    e.u16le(name.length * 2 + 2).u8(type, 1).u32le(0xffffffff).u32le(0xffffffff).u32le(0xffffffff).zeros(16).u32le(0).zeros(16).u32le(start).u32le(size).u32le(0);
    return e.done();
  };
  dir.bytes(entry('Root Entry', 5, 0xfffffffe, 0)).bytes(entry('Workbook', 2, 2, 4096));
  while (dir.length < S) dir.u8(0);
  const wb = new Bytes().u16le(0x0809).u16le(16).u16le(0x0600).u16le(0x0005).zeros(12);
  while (wb.length < 4096) wb.u8(0);
  return concat(header.done(), fat.done(), dir.done(), wb.done());
}

/** One real (or minimal synthetic) sample per catalog format id. */
export const SAMPLES: Record<string, () => Uint8Array> = {
  png: () => fixture('rgba.png'),
  jpg: () => fixture('baseline.jpg'),
  webp: () => fixture('lossy.webp'),
  avif: () => fixture('still.avif'),
  heic: () => fixture('sample.heic'),
  jxl: () => fixture('sample.jxl'),
  gif: () => fixture('anim.gif'),
  tiff: () => fixture('rgb.tiff'),
  bmp: () => fixture('rgb.bmp'),
  ico: () => fixture('multi.ico'),
  psd: () => fixture('sample.psd'),
  svg: () => fixture('sample.svg'),
  pdf: () => fixture('pil.pdf'),
  docx: () => fixture('sample.docx'),
  odt: () => fixture('sample.odt'),
  rtf: () => fixture('sample.rtf'),
  epub: () => fixture('sample.epub'),
  md: () => fixture('sample.md'),
  html: () => fixture('sample.html'),
  tex: () => fixture('sample.tex'),
  txt: () => fixture('sample.txt'),
  xlsx: () => fixture('sample.xlsx'),
  xls: () => buildXls(),
  ods: () => fixture('sample.ods'),
  csv: () => fixture('sample.csv'),
  tsv: () => fixture('sample.tsv'),
  json: () => fixture('sample.json'),
  yaml: () => fixture('sample.yaml'),
  xml: () => fixture('sample.xml'),
  mp3: () => fixture('tone.mp3'),
  wav: () => fixture('tone.wav'),
  flac: () => fixture('tone.flac'),
  ogg: () => fixture('tone.opus'),
  m4a: () => fixture('tone.m4a'),
  mp4: () => fixture('video.mp4'),
  webm: () => fixture('video.webm'),
  mov: () => fixture('video.mov'),
  mkv: () => fixture('video.mkv'),
  zip: () => fixture('plain.zip'),
};

