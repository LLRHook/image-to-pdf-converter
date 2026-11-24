import type { Segment, SegmentRole } from './types';
import { type Ctx, type Reader, fmtBytes, latin1, matchAscii, pushMerged, restUnknown, seg, u16le, u32le, u64le, utf8 } from './util';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  csize: number;
  usize: number;
  /** Offset of the local file header (already adjusted for any prefix data). */
  offset: number;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  cdOffset: number;
  cdSize: number;
  eocdOffset: number;
  eocdLength: number;
  zip64Record?: { offset: number; length: number };
  zip64Locator?: { offset: number; length: number };
  totalEntries: number;
  /** Central directory was bigger than what was read. */
  partial: boolean;
}

const MAX_CD_READ = 4 * 1024 * 1024;

/** Read the central directory from the end of the file; never scans the whole file. */
export async function readZipDirectory(r: Reader): Promise<ZipDirectory | undefined> {
  const size = r.size;
  if (size < 22) return undefined;
  const tailLen = Math.min(size, 22 + 65535);
  const tail = await r.read(size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && matchAscii(tail, i, 'PK\x05\x06') && i + 22 + u16le(tail, i + 20) === tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) return undefined;
  const eocdOffset = size - tailLen + at;
  const eocdLength = tail.length - at;
  let total = u16le(tail, at + 10);
  let cdSize = u32le(tail, at + 12);
  let cdOffset = u32le(tail, at + 16);
  let zip64Record: ZipDirectory['zip64Record'];
  let zip64Locator: ZipDirectory['zip64Locator'];
  if (at >= 20 && matchAscii(tail, at - 20, 'PK\x06\x07')) {
    const recOff = u64le(tail, at - 20 + 8);
    zip64Locator = { offset: eocdOffset - 20, length: 20 };
    if (Number.isFinite(recOff) && recOff + 56 <= size) {
      const rec = await r.read(recOff, 56);
      if (matchAscii(rec, 0, 'PK\x06\x06')) {
        const recSize = u64le(rec, 4);
        zip64Record = { offset: recOff, length: Math.min(12 + recSize, eocdOffset - 20 - recOff) };
        if (total === 0xffff) total = u64le(rec, 32);
        if (cdSize === 0xffffffff) cdSize = u64le(rec, 40);
        if (cdOffset === 0xffffffff) cdOffset = u64le(rec, 48);
      }
    }
  }
  if (!Number.isFinite(cdSize) || !Number.isFinite(cdOffset) || !Number.isFinite(total)) return undefined;
  // Prefix data (self-extractors) shifts every offset.
  let shift = 0;
  const probe = await r.read(cdOffset, 4);
  if (!matchAscii(probe, 0, 'PK\x01\x02')) {
    const guess = eocdOffset - (zip64Record ? 0 : 0) - cdSize - (zip64Record ? 56 + 20 : 0);
    const p2 = await r.read(guess, 4);
    if (guess >= 0 && matchAscii(p2, 0, 'PK\x01\x02')) shift = guess - cdOffset;
    else if (total > 0 && cdSize > 0) return undefined;
  }
  cdOffset += shift;
  const readLen = Math.min(cdSize, MAX_CD_READ);
  const cd = await r.read(cdOffset, readLen);
  const entries: ZipEntry[] = [];
  let o = 0;
  while (o + 46 <= cd.length && entries.length < 200_000 && matchAscii(cd, o, 'PK\x01\x02')) {
    const flags = u16le(cd, o + 8);
    const method = u16le(cd, o + 10);
    let csize = u32le(cd, o + 20);
    let usize = u32le(cd, o + 24);
    const nlen = u16le(cd, o + 28);
    const elen = u16le(cd, o + 30);
    const clen = u16le(cd, o + 32);
    let off = u32le(cd, o + 42);
    if (o + 46 + nlen + elen + clen > cd.length) break;
    const nameBytes = cd.subarray(o + 46, o + 46 + nlen);
    const name = flags & 0x800 ? utf8(nameBytes) : latin1(nameBytes);
    // ZIP64 extended information.
    let e = o + 46 + nlen;
    const eEnd = e + elen;
    while (e + 4 <= eEnd) {
      const id = u16le(cd, e);
      const len = u16le(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (usize === 0xffffffff) {
          usize = u64le(cd, q);
          q += 8;
        }
        if (csize === 0xffffffff) {
          csize = u64le(cd, q);
          q += 8;
        }
        if (off === 0xffffffff) off = u64le(cd, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, flags, csize, usize, offset: off + shift });
    o += 46 + nlen + elen + clen;
  }
  return { entries, cdOffset, cdSize, eocdOffset, eocdLength, zip64Record, zip64Locator, totalEntries: total, partial: cdSize > readLen || entries.length < total };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|emf|wmf|ico|avif|heic|mp3|wav|ogg|mp4|mov|webm|m4a)$/i;
const FONT_EXT = /\.(ttf|otf|woff2?|eot)$/i;

export function zipRole(name: string, fmt: string): SegmentRole {
  const n = name.toLowerCase();
  if (n.endsWith('/')) return 'container';
  if (n === 'mimetype') return 'header';
  if (n === '[content_types].xml' || n.endsWith('.rels') || n.startsWith('meta-inf/') || n.startsWith('docprops/') || n === 'meta.xml' || n === 'manifest.rdf' || n === 'settings.xml') return 'metadata';
  if (n.startsWith('word/media/') || n.startsWith('pictures/') || n.startsWith('xl/media/') || n.startsWith('thumbnails/') || n.includes('/media/') || IMAGE_EXT.test(n)) return 'media';
  if (n.startsWith('word/theme/') || n.startsWith('xl/theme/') || n === 'styles.xml' || n === 'word/styles.xml' || n === 'xl/styles.xml' || n === 'word/fonttable.xml' || n.endsWith('.css') || FONT_EXT.test(n) || n.startsWith('fonts/')) return 'style';
  if (n === 'word/document.xml' || /^word\/(header|footer|footnotes|endnotes|comments)\d*\.xml$/.test(n)) return 'text';
  if (n === 'content.xml') return fmt === 'ods' ? 'records' : 'text';
  if (n.startsWith('xl/worksheets/') || n === 'xl/sharedstrings.xml' || n.startsWith('xl/tables/') || n === 'xl/calcchain.xml') return 'records';
  if (n === 'xl/workbook.xml' || n === 'word/settings.xml' || n === 'word/numbering.xml' || n === 'word/websettings.xml') return 'header';
  if (n.endsWith('.opf')) return 'header';
  if (n.endsWith('.ncx') || n.endsWith('nav.xhtml')) return 'index';
  if (/\.(xhtml|html?|txt|md|rtf|tex)$/.test(n)) return 'text';
  return 'records';
}

const METHODS: Record<number, string> = { 0: 'stored', 1: 'shrunk', 6: 'imploded', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'LZMA', 93: 'zstd', 95: 'xz', 98: 'PPMd' };

function dirOf(name: string): string {
  const i = name.lastIndexOf('/', name.length - 2);
  return i < 0 ? '' : name.slice(0, i + 1);
}

export async function parseZip(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const sig = await r.read(0, 4);
  const dir = await readZipDirectory(r);
  if (!dir) {
    // No readable central directory: walk local headers as far as sizes are known.
    if (!matchAscii(sig, 0, 'PK\x03\x04')) return;
    let pos = 0;
    let n = 0;
    while (pos + 30 <= size && n++ < 2000) {
      const h = await r.read(pos, 30);
      if (!matchAscii(h, 0, 'PK\x03\x04')) break;
      const flags = u16le(h, 6);
      const csize = u32le(h, 18);
      const nlen = u16le(h, 26);
      const elen = u16le(h, 28);
      if (flags & 8 && csize === 0) break;
      const nm = await r.read(pos + 30, nlen);
      const name = flags & 0x800 ? utf8(nm) : latin1(nm);
      const total = Math.min(30 + nlen + elen + csize, size - pos);
      out.push(seg(name, zipRole(name, ctx.format), pos, total, `${METHODS[u16le(h, 8)] ?? 'method ' + u16le(h, 8)} ${fmtBytes(csize)} → ${fmtBytes(u32le(h, 22))} · no central directory`));
      pos += total;
    }
    if (pos < size) restUnknown(ctx, pos, 'unreadable central directory');
    ctx.summary = `${ctx.format.toUpperCase()} · damaged: central directory not found · ${out.length} entries recovered`;
    return;
  }

  const entries = [...dir.entries].sort((a, b) => a.offset - b.offset);
  const boundaryAfter = (i: number): number => {
    const next = entries[i + 1];
    return Math.min(next ? next.offset : dir.cdOffset, dir.cdOffset);
  };
  const detailed = entries.length <= 1000;
  let totalC = 0;
  let totalU = 0;
  for (const e of entries) {
    totalC += e.csize;
    totalU += e.usize;
  }
  const list: Segment[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.offset >= size) continue;
    const end = Math.max(e.offset, boundaryAfter(i));
    const len = end - e.offset;
    if (len <= 0) continue;
    const role = zipRole(e.name, ctx.format);
    const method = METHODS[e.method] ?? `method ${e.method}`;
    const sizes = e.method === 0 ? fmtBytes(e.csize) : `${fmtBytes(e.csize)} → ${fmtBytes(e.usize)}`;
    const detail = `${method} ${sizes}${e.flags & 1 ? ' · encrypted' : ''}`;
    if (detailed) {
      const lh = await r.read(e.offset, 30);
      const lhLen = matchAscii(lh, 0, 'PK\x03\x04') ? 30 + u16le(lh, 26) + u16le(lh, 28) : 0;
      let children: Segment[] | undefined;
      if (lhLen > 0 && lhLen <= len) {
        children = [seg('local file header', 'header', e.offset, lhLen)];
        const dataLen = Math.min(e.csize, len - lhLen);
        if (dataLen > 0) children.push(seg('data', role, e.offset + lhLen, dataLen, method));
        if (len - lhLen - dataLen > 0) children.push(seg('data descriptor', 'header', e.offset + lhLen + dataLen, len - lhLen - dataLen));
      }
      list.push(seg(e.name || '(unnamed)', role, e.offset, len, detail, { children }));
    } else {
      const d = dirOf(e.name);
      pushMerged(list, seg(d ? d : '(top level)', role, e.offset, len, undefined));
    }
  }
  if (!detailed) {
    for (const s of list) {
      if (s.count && s.count > 1) s.detail = `${s.count.toLocaleString('en-US')} files · ${fmtBytes(s.length)} on disk`;
    }
  }
  out.push(...list);
  if (dir.partial) ctx.truncated = true;
  if (dir.cdSize > 0) out.push(seg('Central directory', 'index', dir.cdOffset, Math.min(dir.cdSize, size - dir.cdOffset), `${dir.entries.length.toLocaleString('en-US')} entries`));
  if (dir.zip64Record) out.push(seg('ZIP64 end of central directory', 'trailer', dir.zip64Record.offset, dir.zip64Record.length));
  if (dir.zip64Locator) out.push(seg('ZIP64 locator', 'trailer', dir.zip64Locator.offset, dir.zip64Locator.length));
  out.push(seg('End of central directory', 'trailer', dir.eocdOffset, dir.eocdLength));

  const label = ctx.format.toUpperCase();
  ctx.summary = `${label} · ${plural(entries.length)} · ${fmtBytes(totalC)}${totalU !== totalC ? ` compressed → ${fmtBytes(totalU)} uncompressed` : ' stored'}`;
}

function plural(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'entry' : 'entries'}`;
}
