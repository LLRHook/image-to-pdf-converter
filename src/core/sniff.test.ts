import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { FORMATS, type FormatId } from './formats';
import { sniffFormat } from './sniff';
import { bytesSource } from './structure/types';
import { Bytes, SAMPLES, buildXls, concat, countingSource, fixture, rng, utf8 } from './structure/testkit';

const sniff = (bytes: Uint8Array, name?: string) => sniffFormat(bytesSource(bytes), name);

describe('sniffFormat — every catalog format', () => {
  it('has a sample for every format', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(FORMATS.map((f) => f.id).sort());
  });

  it.each(FORMATS.map((f) => [f.id, f.exts[0]!] as const))('%s from bytes alone', async (id) => {
    expect(await sniff(SAMPLES[id as FormatId]!())).toBe(id);
  });

  it.each(FORMATS.map((f) => [f.id, f.exts[0]!] as const))('%s with its own extension', async (id, ext) => {
    expect(await sniff(SAMPLES[id as FormatId]!(), `file.${ext}`)).toBe(id);
  });

  it('trusts bytes over a lying extension for binary formats', async () => {
    expect(await sniff(fixture('rgba.png'), 'photo.jpg')).toBe('png');
    expect(await sniff(fixture('pil.pdf'), 'notes.txt')).toBe('pdf');
    expect(await sniff(fixture('sample.docx'), 'archive.zip')).toBe('docx');
    expect(await sniff(fixture('tone.wav'), 'music.mp3')).toBe('wav');
  });
});

describe('sniffFormat — container disambiguation', () => {
  it('tells zip flavours apart by mimetype / content types', async () => {
    expect(await sniff(fixture('sample.odt'))).toBe('odt');
    expect(await sniff(fixture('sample.ods'))).toBe('ods');
    expect(await sniff(fixture('sample.epub'))).toBe('epub');
    expect(await sniff(fixture('sample.docx'))).toBe('docx');
    expect(await sniff(fixture('sample.xlsx'))).toBe('xlsx');
    const odp = zipSync({ mimetype: [utf8('application/vnd.oasis.opendocument.presentation'), { level: 0 }], 'content.xml': utf8('<x/>') });
    expect(await sniff(odp)).toBe('zip');
    const pptx = zipSync({ '[Content_Types].xml': utf8('<x/>'), 'ppt/slides/slide1.xml': utf8('<x/>') });
    expect(await sniff(pptx)).toBe('zip');
    expect(await sniff(zipSync({ 'a.txt': utf8('hi') }))).toBe('zip');
  });

  it('identifies a zip with prefix data and a damaged tail by its first entry', async () => {
    const docx = fixture('sample.docx');
    expect(await sniff(docx.subarray(0, 2000))).toBe('zip');
    expect(await sniff(concat(new Uint8Array(500), docx))).toBeUndefined();
  });

  it('uses ftyp brands, falling back to the extension where brands are generic', async () => {
    const ftyp = (major: string, ...compat: string[]) => {
      const b = new Bytes().u32be(16 + compat.length * 4).ascii('ftyp').ascii(major).u32be(0);
      for (const c of compat) b.ascii(c);
      return concat(b.done(), new Uint8Array(32));
    };
    expect(await sniff(ftyp('heic', 'mif1'))).toBe('heic');
    expect(await sniff(ftyp('mif1', 'avif', 'miaf'))).toBe('avif');
    expect(await sniff(ftyp('mif1', 'heic'))).toBe('heic');
    expect(await sniff(ftyp('avis'))).toBe('avif');
    expect(await sniff(ftyp('qt  '))).toBe('mov');
    expect(await sniff(ftyp('M4A ', 'mp42', 'isom'))).toBe('m4a');
    expect(await sniff(ftyp('isom', 'mp42'))).toBe('mp4');
    expect(await sniff(ftyp('mp42', 'isom'), 'a.m4a')).toBe('m4a');
    expect(await sniff(ftyp('isom'), 'a.mov')).toBe('mov');
    expect(await sniff(ftyp('3gp5'))).toBe('mp4');
    expect(await sniff(ftyp('crx '))).toBeUndefined();
  });

  it('reads the EBML DocType', async () => {
    expect(await sniff(fixture('video.webm'))).toBe('webm');
    expect(await sniff(fixture('video.mkv'))).toBe('mkv');
  });

  it('distinguishes RIFF flavours and rejects others', async () => {
    expect(await sniff(fixture('tone.wav'))).toBe('wav');
    expect(await sniff(fixture('lossy.webp'))).toBe('webp');
    expect(await sniff(new Bytes().ascii('RIFF').u32le(100).ascii('AVI ').zeros(100).done())).toBeUndefined();
  });

  it('separates OLE2 spreadsheets from other legacy Office files', async () => {
    const xls = buildXls();
    expect(await sniff(xls)).toBe('xls');
    expect(await sniff(xls, 'a.doc')).toBeUndefined();
    expect(await sniff(xls, 'a.xls')).toBe('xls');
  });

  it('recognises MP3 with/without ID3, and ADTS AAC as m4a', async () => {
    const mp3 = fixture('tone.mp3');
    expect(await sniff(mp3.subarray(44))).toBe('mp3'); // no ID3 tag
    expect(await sniff(fixture('tone.aac'))).toBe('m4a');
  });

  it('knows both JPEG XL forms', async () => {
    expect(await sniff(fixture('sample.jxl'))).toBe('jxl');
    expect(await sniff(fixture('jpeg-recompressed.jxl'))).toBe('jxl');
  });
});

describe('sniffFormat — text dialects', () => {
  const t = (s: string, name?: string) => sniff(utf8(s), name);

  it('detects markup by its prolog and root element', async () => {
    expect(await t('{\\rtf1\\ansi hello}')).toBe('rtf');
    expect(await t('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('svg');
    expect(await t('<svg width="1" height="1"></svg>')).toBe('svg');
    expect(await t('<!DOCTYPE html><html><body>x</body></html>')).toBe('html');
    expect(await t('<html><body>x</body></html>')).toBe('html');
    expect(await t('<?xml version="1.0"?><feed><entry/></feed>')).toBe('xml');
    expect(await t('<?xml version="1.0"?>\n<!-- c -->\n<html xmlns="http://www.w3.org/1999/xhtml"></html>')).toBe('html');
    expect(await t('<config><a/></config>')).toBe('xml');
  });

  it('does not let HTML inside a markdown/text file win', async () => {
    expect(await t('<div align="center">\n<img src="logo.png">\n</div>\n\n# Project\n\nText.\n', 'README.md')).toBe('md');
    expect(await t('<b>hello</b> there', 'note.txt')).toBe('txt');
  });

  it('detects JSON, falling back to the extension for loose input', async () => {
    expect(await t('{"a": [1, 2, {"b": null}]}')).toBe('json');
    expect(await t('[1, 2, 3]')).toBe('json');
    expect(await t('[link](http://x.y) is markdown', 'a.md')).toBe('md');
    expect(await t('{not json at all', 'broken.json')).toBe('json');
    expect(await t('{not json at all')).toBe('txt');
  });

  it('detects LaTeX, YAML and Markdown', async () => {
    expect(await t('\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n')).toBe('tex');
    expect(await t('\\section{Intro}\nText', 'a.tex')).toBe('tex');
    expect(await t('---\nname: x\nlist:\n  - a\n  - b\n')).toBe('yaml');
    expect(await t('name: demo\nversion: 3\nitems:\n  - a\n')).toBe('yaml');
    expect(await t('---\ntitle: T\n---\n\n# Heading\n\nSome *text*.\n')).toBe('md');
    expect(await t('# Title\n\n- one\n- two\n\n[x](y)\n')).toBe('md');
    expect(await t('# only a heading')).toBe('txt');
  });

  it('detects delimited data by consistency, with extension tiebreaks', async () => {
    expect(await t('a,b,c\n1,2,3\n4,5,6\n')).toBe('csv');
    expect(await t('a;b;c\n1;2;3\n')).toBe('csv');
    expect(await t('a\tb\tc\n1\t2\t3\n')).toBe('tsv');
    expect(await t('"x, y",z\n"1, 2",3\n')).toBe('csv');
    expect(await t('just, some, prose\nwith commas, but\nnot a table at all here\nreally not\n')).toBe('txt');
    expect(await t('one column only', 'a.csv')).toBe('csv');
    expect(await t('a b c', 'x.tsv')).toBe('tsv');
  });

  it('falls back to plain text, UTF-8 or Latin-1', async () => {
    expect(await t('Hello, world.\nSecond line.\n')).toBe('txt');
    expect(await t('héllo wörld 日本語')).toBe('txt');
    expect(await sniff(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x75, 0x69, 0x0a]))).toBe('txt'); // "café oui" in Latin-1
    expect(await sniff(concat(new Uint8Array([0xff, 0xfe]), new Uint8Array(Array.from('hi there', (c) => [c.charCodeAt(0), 0]).flat())))).toBe('txt'); // UTF-16LE with BOM
  });

  it('treats extension-only hints for markup formats as plain text when no markup is present', async () => {
    expect(await t('just words', 'page.html')).toBe('txt');
    expect(await t('# hi\nthere', 'page.md')).toBe('md');
  });
});

describe('sniffFormat — safety', () => {
  it('returns undefined for empty, random and binary junk', async () => {
    expect(await sniff(new Uint8Array(0))).toBeUndefined();
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const b = new Uint8Array(64 + Math.floor(r() * 2000));
      for (let k = 0; k < b.length; k++) b[k] = Math.floor(r() * 256);
      // random bytes almost never form a known signature; whatever comes back must be a catalog id
      const got = await sniff(b);
      expect(got === undefined || FORMATS.some((f) => f.id === got)).toBe(true);
    }
    expect(await sniff(new Uint8Array(1000))).toBeUndefined();
  });

  it('never throws when the source fails or lies', async () => {
    expect(await sniffFormat({ size: 100, read: async () => { throw new Error('x'); } })).toBeUndefined();
    expect(await sniffFormat({ size: Number.NaN, read: async () => new Uint8Array(0) })).toBeUndefined();
    expect(await sniffFormat({ size: 1e15, read: async () => new Uint8Array(10) })).toBeUndefined();
  });

  it('reads only the head plus targeted tail reads', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.bin`] = new Uint8Array(300_000).fill(i);
    const zip = zipSync({ '[Content_Types].xml': utf8('<x/>'), 'word/document.xml': utf8('<d/>'), ...files }, { level: 0 });
    const src = countingSource(zip);
    expect(await sniffFormat(src, 'x.docx')).toBe('docx');
    expect(src.bytesRead).toBeLessThan(200_000);
    const big = new Uint8Array(5_000_000);
    big.set(utf8('a,b,c\n1,2,3\n'));
    const src2 = countingSource(big);
    await sniffFormat(src2, 'x.csv');
    expect(src2.bytesRead).toBeLessThanOrEqual(70_000);
  });
});
