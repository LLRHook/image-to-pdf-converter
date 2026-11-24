import { type FormatId, formatFromExtension } from './formats';
import type { ByteSource } from './structure/types';
import { Reader, ascii, matchAscii, u16be, u16le, u32be, u32le } from './structure/util';
import { id3v2Length, isAdts, parseMpegHeader } from './structure/mp3';
import { readZipDirectory } from './structure/zip';

/**
 * Detect the real format of a file from its bytes, using the extension only to
 * break ties where bytes are ambiguous (text dialects, ftyp brands, zip flavours).
 */
export async function sniffFormat(source: ByteSource, filename?: string): Promise<FormatId | undefined> {
  try {
    return await sniff(source, filename);
  } catch {
    return undefined;
  }
}

const HEAD = 65536;

function extOf(filename?: string): string {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

async function sniff(source: ByteSource, filename?: string): Promise<FormatId | undefined> {
  const r = new Reader(source, 16 * 1024 * 1024);
  if (r.size === 0) return undefined;
  const b = await r.read(0, HEAD);
  if (b.length === 0) return undefined;
  const ext = extOf(filename);

  const bin = await sniffBinary(r, b, ext);
  if (bin) return bin === 'text' ? sniffText(r, b, ext) : bin;
  return undefined;
}

// ------------------------------------------------------------------ binary

async function sniffBinary(r: Reader, b: Uint8Array, ext: string): Promise<FormatId | 'text' | undefined> {
  const n = b.length;
  // Images
  if (n >= 8 && b[0] === 0x89 && matchAscii(b, 1, 'PNG\r\n\x1a\n')) return 'png';
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (matchAscii(b, 0, 'GIF87a') || matchAscii(b, 0, 'GIF89a')) return 'gif';
  if (n >= 12 && matchAscii(b, 0, 'RIFF')) {
    if (matchAscii(b, 8, 'WEBP')) return 'webp';
    if (matchAscii(b, 8, 'WAVE')) return 'wav';
    return undefined;
  }
  if (matchAscii(b, 0, 'RF64') && matchAscii(b, 8, 'WAVE')) return 'wav';
  if (matchAscii(b, 0, '8BPS') && (u16be(b, 4) === 1 || u16be(b, 4) === 2)) return 'psd';
  if (n >= 2 && b[0] === 0xff && b[1] === 0x0a) return 'jxl';
  if (n >= 12 && u32be(b, 0) === 12 && matchAscii(b, 4, 'JXL ') && b[8] === 0x0d && b[9] === 0x0a) return 'jxl';
  if ((matchAscii(b, 0, 'II*\0') || matchAscii(b, 0, 'MM\0*') || matchAscii(b, 0, 'II+\0') || matchAscii(b, 0, 'MM\0+')) && n >= 8) return 'tiff';
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const dib = u32le(b, 14);
    if ([12, 40, 52, 56, 64, 108, 124].includes(dib) && u32le(b, 10) >= 14 + dib && u32le(b, 10) <= r.size) return 'bmp';
  }
  if (n >= 22 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    const count = u16le(b, 4);
    if (count >= 1 && count <= 256 && 6 + 16 * count <= n) {
      const off = u32le(b, 6 + 12);
      const len = u32le(b, 6 + 8);
      if (b[6 + 3] === 0 && off >= 6 + 16 * count && len > 0 && off + len <= r.size) return 'ico';
    }
  }

  // ISO base media (mp4 / mov / m4a / heic / avif)
  if (n >= 16 && matchAscii(b, 4, 'ftyp')) return sniffFtyp(b, ext);
  if (n >= 12 && ['moov', 'mdat', 'wide', 'pnot'].includes(ascii(b, 4, 4)) && u32be(b, 0) >= 8) return 'mov';

  // Matroska / WebM
  if (n >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    for (let i = 4; i < Math.min(n - 8, 80); i++) {
      if (b[i] === 0x42 && b[i + 1] === 0x82) {
        const len = (b[i + 2] ?? 0) & 0x7f;
        const doc = ascii(b, i + 3, Math.min(len, 16));
        if (doc.startsWith('webm')) return 'webm';
        if (doc.startsWith('matroska')) return 'mkv';
      }
    }
    return ext === 'webm' ? 'webm' : 'mkv';
  }

  // OLE2 (legacy Office)
  if (n >= 8 && matchAscii(b, 0, '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')) return sniffOle2(b, ext);

  // Documents
  const pdfAt = indexOf(b, '%PDF-', 1024);
  if (pdfAt >= 0) return 'pdf';

  // Audio
  if (matchAscii(b, 0, 'fLaC')) return 'flac';
  if (matchAscii(b, 0, 'OggS')) return 'ogg';
  if (matchAscii(b, 0, 'ID3')) {
    const len = await id3v2Length(r, 0);
    const after = await r.read(len, 16);
    if (matchAscii(after, 0, 'fLaC')) return 'flac';
    if (isAdts(after, 0)) return 'm4a';
    return 'mp3';
  }
  if (n >= 4 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) {
    const f = parseMpegHeader(b, 0);
    if (f) {
      const next = await r.read(f.length, 4);
      const verified = f.length + 4 <= r.size && parseMpegHeader(next, 0) !== undefined;
      // Layer I/II headers are easy to hit by accident (e.g. a UTF-16 BOM), so insist on a second frame for them.
      if (verified || (f.layer === 3 && f.length + 4 > r.size)) return 'mp3';
    }
    if (isAdts(b, 0)) return 'm4a';
  }

  // ZIP family
  if (n >= 4 && matchAscii(b, 0, 'PK') && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8))) return sniffZip(r, b, ext);

  // Anything with NULs (outside UTF-16 text) or lots of control bytes is binary.
  return isTextLike(b) ? 'text' : undefined;
}

function indexOf(b: Uint8Array, s: string, limit: number): number {
  const end = Math.min(b.length - s.length, limit);
  for (let i = 0; i <= end; i++) if (matchAscii(b, i, s)) return i;
  return -1;
}

function sniffFtyp(b: Uint8Array, ext: string): FormatId | undefined {
  const boxLen = Math.min(u32be(b, 0), b.length);
  const major = ascii(b, 8, 4);
  const compat: string[] = [];
  for (let o = 16; o + 4 <= boxLen; o += 4) compat.push(ascii(b, o, 4));
  const all = [major, ...compat];
  const has = (...names: string[]): boolean => all.some((x) => names.includes(x));
  if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(major)) return 'heic';
  if (['avif', 'avis'].includes(major)) return 'avif';
  if (major === 'mif1' || major === 'msf1' || major === 'miaf') {
    if (has('avif', 'avis')) return 'avif';
    if (has('heic', 'heix', 'hevc', 'hevx', 'heim', 'heis')) return 'heic';
    return ext === 'avif' ? 'avif' : 'heic';
  }
  if (major === 'qt  ') return 'mov';
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return 'm4a';
  if (ext === 'm4a' || ext === 'aac') return 'm4a';
  if (ext === 'mov' || ext === 'qt') return 'mov';
  if (major === 'crx ' || major === 'jxl ') return undefined;
  return 'mp4';
}

function sniffOle2(b: Uint8Array, ext: string): FormatId | undefined {
  if (ext === 'xls' || ext === 'xlt') return 'xls';
  if (['doc', 'dot', 'ppt', 'pps', 'msg', 'msi', 'vsd', 'pub'].includes(ext)) return undefined;
  // Directory entry names are UTF-16LE; check both alignments of the sample.
  const hay = new TextDecoder('utf-16le').decode(b.subarray(0, b.length - (b.length % 2))) + new TextDecoder('utf-16le').decode(b.subarray(1, b.length - ((b.length - 1) % 2)));
  if (/WordDocument|PowerPoint Document/.test(hay)) return undefined;
  return 'xls';
}

async function sniffZip(r: Reader, b: Uint8Array, ext: string): Promise<FormatId> {
  const dir = await readZipDirectory(r);
  const byExt: Record<string, FormatId> = { docx: 'docx', xlsx: 'xlsx', odt: 'odt', ods: 'ods', epub: 'epub' };
  if (!dir) {
    // No readable central directory: judge by the first local header.
    const nlen = u16le(b, 26);
    const first = ascii(b, 30, Math.min(nlen, 64));
    if (first.startsWith('word/')) return 'docx';
    if (first.startsWith('xl/')) return 'xlsx';
    return byExt[ext] ?? 'zip';
  }
  const names = new Set(dir.entries.map((e) => e.name));
  const mime = dir.entries.find((e) => e.name === 'mimetype');
  if (mime && mime.offset + 30 < r.size) {
    const lh = await r.read(mime.offset, 30);
    if (matchAscii(lh, 0, 'PK\x03\x04') && u16le(lh, 8) === 0) {
      const data = await r.read(mime.offset + 30 + u16le(lh, 26) + u16le(lh, 28), Math.min(mime.csize, 128));
      const type = ascii(data, 0, data.length);
      if (type === 'application/vnd.oasis.opendocument.text') return 'odt';
      if (type === 'application/vnd.oasis.opendocument.spreadsheet') return 'ods';
      if (type === 'application/epub+zip') return 'epub';
      return 'zip';
    }
  }
  let word = false;
  let xl = false;
  for (const name of names) {
    if (name.startsWith('word/')) word = true;
    else if (name.startsWith('xl/')) xl = true;
  }
  if (word && (names.has('[Content_Types].xml') || names.has('word/document.xml'))) return 'docx';
  if (xl && (names.has('[Content_Types].xml') || names.has('xl/workbook.xml'))) return 'xlsx';
  if (names.has('META-INF/container.xml') && [...names].some((x) => /\.(opf|xhtml)$/.test(x))) return 'epub';
  if (names.has('content.xml') && names.has('META-INF/manifest.xml')) return ext === 'ods' ? 'ods' : ext === 'odt' ? 'odt' : 'zip';
  return 'zip';
}

// ------------------------------------------------------------------ text

function isTextLike(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  if (n === 0) return false;
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true; // UTF-16 BOM
  let ctrl = 0;
  let high = 0;
  let invalid = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
    if (c >= 0x80) {
      high++;
      // validate UTF-8 sequence
      const need = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc2 ? 1 : -1;
      if (need < 0) invalid++;
      else {
        let ok = true;
        for (let k = 1; k <= need; k++) if (((b[i + k] ?? 0) & 0xc0) !== 0x80) ok = false;
        if (!ok && i + need < n) invalid++;
        else i += need;
      }
    }
  }
  if (ctrl > n * 0.01) return false;
  return !(high > 0 && invalid > high * 0.3 && invalid > 8);
}

function decodeHead(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2, b.length - (b.length % 2)));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2, b.length - (b.length % 2)));
  const start = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(b.subarray(start));
}

const TEXT_EXTS = new Set(['csv', 'tsv', 'tab', 'md', 'markdown', 'txt', 'text', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'svg', 'tex', 'rtf']);
const HTML_TAGS = new Set(['html', 'head', 'body', 'div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'a', 'img', 'section', 'article', 'main', 'header', 'footer', 'nav', 'meta', 'link', 'title', 'script', 'style', 'form', 'pre', 'br', 'hr']);

async function sniffText(r: Reader, b: Uint8Array, ext: string): Promise<FormatId | undefined> {
  const whole = b.length >= r.size;
  const s = decodeHead(b);
  const lead = s.replace(/^\s+/, '');
  const extFmt = TEXT_EXTS.has(ext) ? (formatFromExtension(`x.${ext}`) as FormatId | undefined) : undefined;

  if (lead.startsWith('{\\rtf')) return 'rtf';

  // Markup
  if (lead.startsWith('<')) {
    const low = lead.slice(0, 4000).toLowerCase();
    const prolog = /^(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!doctype[^>]*>|\s)*/i.exec(lead)?.[0] ?? '';
    const rest = lead.slice(prolog.length);
    const root = /^<([a-z][\w:.-]*)/i.exec(rest)?.[1]?.toLowerCase();
    const isXmlDecl = low.startsWith('<?xml');
    if (/^<!doctype\s+svg/i.test(lead.replace(/^<\?xml[^>]*\?>\s*/i, '')) || root === 'svg') return 'svg';
    if (/^<!doctype\s+html/i.test(lead) || root === 'html') return extFmt === 'xml' && isXmlDecl ? 'xml' : 'html';
    if (isXmlDecl && root) return extFmt === 'html' ? 'html' : 'xml';
    if (root && (extFmt === 'xml' || extFmt === 'html' || extFmt === 'svg')) return extFmt;
    if (root && (!extFmt || extFmt === 'txt') && !ext) return HTML_TAGS.has(root) ? 'html' : 'xml';
  }

  // JSON
  if (lead[0] === '{' || lead[0] === '[') {
    if (whole) {
      try {
        JSON.parse(s.replace(/^\ufeff/, ''));
        return 'json';
      } catch {
        /* not valid JSON */
      }
    } else if (/^\{\s*("|\})/.test(lead) || /^\[\s*(\{|\[|"|\]|-?\d|true|false|null)/.test(lead)) {
      // Too big to validate: a JSON-looking start is enough unless it is a markdown link/reference.
      if (!/^\[[^\]\n]*\]\(/.test(lead) && !/^\[[^\]\n]+\]:/.test(lead)) return 'json';
    }
    if (extFmt === 'json') return 'json';
  }

  // LaTeX
  const strongTex = /\\documentclass|\\begin\{document\}|\\usepackage/.test(s.slice(0, 8000));
  if (strongTex) return 'tex';
  if (extFmt === 'tex') return 'tex';

  // YAML
  if (/^(?:%YAML|---)(?:\s|$)/.test(lead) || extFmt === 'yaml') {
    if (extFmt === 'md') return 'md';
    if (extFmt === 'yaml') return 'yaml';
    if (yamlish(s)) return 'yaml';
  }

  // The extension breaks ties for text dialects; markup extensions without markup are just text.
  if (extFmt) return extFmt === 'html' || extFmt === 'xml' || extFmt === 'svg' ? 'txt' : extFmt;

  // Heuristics for extension-less text.
  const lines = lead.split(/\r\n|\n|\r/).slice(0, 60);
  if (yamlish(s) && lines.filter((l) => /^[\w.-]+:(\s|$)/.test(l)).length >= 2) return 'yaml';
  if (markdownish(lines)) return 'md';
  const delim = delimited(lead.slice(0, 20000));
  if (delim) return delim;
  return 'txt';
}

function yamlish(s: string): boolean {
  const lines = s.split(/\r\n|\n|\r/).slice(0, 100).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (lines.length === 0) return false;
  let ok = 0;
  let md = 0;
  for (const l of lines) {
    if (/^(---|\.\.\.|%\w+)/.test(l) || /^\s*-\s/.test(l) || /^\s*[\w."'-][^:]*:(\s|$)/.test(l) || /^\s+\S/.test(l)) ok++;
    if (/^#{1,6}\s/.test(l) || /^```/.test(l)) md++;
  }
  return md === 0 && ok / lines.length >= 0.85;
}

function markdownish(lines: string[]): boolean {
  let score = 0;
  let strong = 0;
  for (const l of lines) {
    if (/^#{1,6}\s+\S/.test(l)) {
      score += 2;
      strong++;
    } else if (/^(```|~~~)/.test(l)) {
      score += 2;
      strong++;
    } else if (/\[[^\]]+\]\([^)]+\)/.test(l)) {
      score += 1;
      strong++;
    } else if (/^\s*[-*+]\s+\S/.test(l) || /^\s*\d+\.\s+\S/.test(l) || /^>\s/.test(l)) score += 1;
    else if (/\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|(^|\s)\*[^*\s][^*]*\*(\s|$|[.,;:])/.test(l)) score += 1;
    else if (/^\|.*\|$/.test(l)) score += 1;
  }
  return strong >= 1 && score >= 3;
}

function records(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length && out.length < max; i++) {
    const ch = text[i]!;
    if (ch === '"') q = !q;
    if (!q && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (cur.trim() !== '') out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '' && out.length < max) out.push(cur);
  return out;
}

function delimited(text: string): FormatId | undefined {
  const rows = records(text, 40);
  if (rows.length < 2) return undefined;
  const test = (d: string): boolean => {
    const counts = rows.map((l) => countOutsideQuotes(l, d));
    const first = counts[0]!;
    if (first < 1) return false;
    const same = counts.filter((c) => c === first).length;
    return same / counts.length >= 0.8;
  };
  if (test('\t')) return 'tsv';
  if (test(',') || test(';') || test('|')) return 'csv';
  return undefined;
}

function countOutsideQuotes(line: string, d: string): number {
  let q = false;
  let n = 0;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (!q && ch === d) n++;
  }
  return n;
}
