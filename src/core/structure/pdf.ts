import type { Segment, SegmentRole } from './types';
import { type Ctx, type Reader, fmtBytes, indexOfAscii, latin1, matchAscii, pushMerged, seg } from './util';

const isWs = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** Index just past the matching '>>' for the '<<' at `from`, or -1. */
function dictEnd(b: Uint8Array, from: number): number {
  let depth = 0;
  let i = from;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (c === 0x28) {
      // literal string, parens nest, backslash escapes
      let level = 1;
      i++;
      while (i < n && level > 0) {
        const d = b[i];
        if (d === 0x5c) {
          i += 2;
          continue;
        }
        if (d === 0x28) level++;
        else if (d === 0x29) level--;
        i++;
      }
    } else if (c === 0x3c && b[i + 1] === 0x3c) {
      depth++;
      i += 2;
    } else if (c === 0x3e && b[i + 1] === 0x3e) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else if (c === 0x3c) {
      i = b.indexOf(0x3e, i + 1);
      if (i < 0) return -1;
      i++;
    } else if (c === 0x25) {
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
    } else i++;
  }
  return -1;
}

async function skipWs(r: Reader, pos: number): Promise<number> {
  let p = pos;
  for (let g = 0; g < 1000 && p < r.size; g++) {
    const b = await r.read(p, 256);
    if (b.length === 0) break;
    let i = 0;
    while (i < b.length && isWs(b[i] ?? 0)) i++;
    p += i;
    if (i < b.length) break;
  }
  return p;
}

interface ObjHead {
  num: number;
  gen: number;
  bodyAt: number;
}

function parseObjHead(b: Uint8Array): ObjHead | undefined {
  let i = 0;
  let num = 0;
  let d = 0;
  while (isDigit(b[i] ?? 0) && d < 10) {
    num = num * 10 + ((b[i] ?? 48) - 48);
    i++;
    d++;
  }
  if (d === 0 || !isWs(b[i] ?? 255)) return undefined;
  while (isWs(b[i] ?? 255)) i++;
  let gen = 0;
  d = 0;
  while (isDigit(b[i] ?? 0) && d < 6) {
    gen = gen * 10 + ((b[i] ?? 48) - 48);
    i++;
    d++;
  }
  if (d === 0 || !isWs(b[i] ?? 255)) return undefined;
  while (isWs(b[i] ?? 255)) i++;
  if (b[i] !== 0x6f || b[i + 1] !== 0x62 || b[i + 2] !== 0x6a) return undefined;
  const after = b[i + 3];
  if (after !== undefined && isDigit(after)) return undefined;
  return { num, gen, bodyAt: i + 3 };
}

const FILTERS: Record<string, string> = {
  FlateDecode: 'Flate',
  DCTDecode: 'DCT',
  JPXDecode: 'JPX',
  CCITTFaxDecode: 'CCITT',
  LZWDecode: 'LZW',
  ASCII85Decode: 'ASCII85',
  ASCIIHexDecode: 'ASCIIHex',
  RunLengthDecode: 'RunLength',
  JBIG2Decode: 'JBIG2',
  Crypt: 'Crypt',
};

interface Classified {
  role: SegmentRole;
  kind: string;
  detail: string;
  suffix?: string;
}

function classify(txt: string, hasStream: boolean, streamLen: number): Classified {
  const type = /\/Type\s*\/([A-Za-z0-9]+)/.exec(txt)?.[1];
  const sub = /\/Subtype\s*\/([A-Za-z0-9]+)/.exec(txt)?.[1];
  const filterMatch = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(txt)?.[1];
  const filters = filterMatch ? [...filterMatch.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => FILTERS[m[1]!] ?? m[1]!) : [];
  const f = filters.join('+');
  const sz = hasStream ? ` · ${fmtBytes(streamLen)}${f ? ' ' + f : ''}` : '';
  const num = (key: string): number | undefined => {
    const m = new RegExp(`/${key}\\s+(-?\\d+)(?!\\s+\\d+\\s+R)`).exec(txt);
    return m ? Number(m[1]) : undefined;
  };
  if (type === 'ObjStm') return { role: 'records', kind: 'ObjStm', detail: `/Type /ObjStm · ${num('N') ?? '?'} compressed objects${sz}`, suffix: ' (ObjStm)' };
  if (type === 'XRef') return { role: 'index', kind: 'XRef', detail: `/Type /XRef · cross-reference stream · ${/\/W\s*\[([^\]]*)\]/.exec(txt)?.[1]?.trim() ? 'W [' + /\/W\s*\[([^\]]*)\]/.exec(txt)![1]!.trim() + ']' : ''}${sz}`, suffix: ' (XRef)' };
  if (type === 'Page') {
    const mb = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(txt);
    return { role: 'records', kind: 'Page', detail: `/Type /Page${mb ? ` · ${Math.round(Number(mb[3]) - Number(mb[1]))}×${Math.round(Number(mb[4]) - Number(mb[2]))} pt` : ''}` };
  }
  if (type === 'Pages') return { role: 'records', kind: 'Pages', detail: `/Type /Pages · ${num('Count') ?? '?'} pages` };
  if (type === 'Catalog') return { role: 'records', kind: 'Catalog', detail: '/Type /Catalog' };
  if (type === 'Font') return { role: 'style', kind: 'Font', detail: `/Type /Font · /Subtype /${sub ?? '?'}${/\/BaseFont\s*\/([^\s/<>[\]()]+)/.exec(txt)?.[1] ? ' · ' + /\/BaseFont\s*\/([^\s/<>[\]()]+)/.exec(txt)![1] : ''}` };
  if (type === 'FontDescriptor') return { role: 'style', kind: 'FontDescriptor', detail: '/Type /FontDescriptor' };
  if (type === 'Metadata' || sub === 'XML') return { role: 'metadata', kind: 'Metadata', detail: `/Type /Metadata · XMP${sz}` };
  if (type === 'Annot' || sub === 'Link' || sub === 'Widget') return { role: 'records', kind: 'Annot', detail: `/Type /Annot · /Subtype /${sub ?? '?'}` };
  if (sub === 'Image') {
    const w = num('Width');
    const h = num('Height');
    const bpc = num('BitsPerComponent');
    const cs = /\/ColorSpace\s*\/([A-Za-z0-9]+)/.exec(txt)?.[1];
    return { role: 'media', kind: 'Image', detail: `/Subtype /Image ${w ?? '?'}×${h ?? '?'}${f ? ' ' + (f.split('+').pop() ?? '') : ''}${bpc ? ` · ${bpc}-bit` : ''}${cs ? ' ' + cs.replace('Device', '') : ''}${hasStream ? ' · ' + fmtBytes(streamLen) : ''}` };
  }
  if (sub === 'Form') return { role: 'text', kind: 'Form', detail: `/Subtype /Form · form XObject${sz}` };
  if (hasStream && /\/Length1\b/.test(txt)) return { role: 'style', kind: 'FontFile', detail: `embedded font program (TrueType)${sz}` };
  if (hasStream && /\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)/.test(txt)) return { role: 'style', kind: 'FontFile', detail: `embedded font program (${sub})${sz}` };
  if (hasStream && /\/Alternate\s*\/Device/.test(txt) && /\/N\s+\d/.test(txt)) return { role: 'palette', kind: 'ICC', detail: `ICC profile · ${num('N')} components${sz}` };
  if (hasStream && !type && !sub) return { role: 'text', kind: 'Content', detail: `content stream${sz}` };
  if (type) return { role: 'records', kind: type, detail: `/Type /${type}${sub ? ' /Subtype /' + sub : ''}${sz}` };
  return { role: 'records', kind: 'dict', detail: hasStream ? `stream${sz}` : txt.slice(0, 60).replace(/\s+/g, ' ') };
}

const CHUNK = 256 * 1024;

/** Absolute offset of `needle`, scanning forward in chunks (inclusive of overlap); -1 if absent or the budget ran out. */
async function findForward(r: Reader, from: number, needle: string, limit = r.size): Promise<number> {
  let pos = from;
  const overlap = needle.length - 1;
  while (pos < limit) {
    const b = await r.readUpTo(pos, Math.min(CHUNK, limit - pos));
    if (b.length === 0) return -1;
    const i = indexOfAscii(b, needle, 0);
    if (i >= 0) return pos + i;
    if (pos + b.length >= limit) return -1;
    pos += b.length - overlap;
  }
  return -1;
}

export async function parsePdf(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const head = await r.read(0, 1024);
  const at = indexOfAscii(head, '%PDF-', 0);
  if (at < 0) return;
  let eol = at;
  while (eol < head.length && head[eol] !== 10 && head[eol] !== 13) eol++;
  const version = latin1(head.subarray(at + 5, Math.min(eol, at + 5 + 8))).trim();
  let headerEnd = eol;
  while (headerEnd < head.length && (head[headerEnd] === 10 || head[headerEnd] === 13)) headerEnd++;
  if (head[headerEnd] === 0x25 && (head[headerEnd + 1] ?? 0) >= 0x80) {
    while (headerEnd < head.length && head[headerEnd] !== 10 && head[headerEnd] !== 13) headerEnd++;
    while (headerEnd < head.length && (head[headerEnd] === 10 || head[headerEnd] === 13)) headerEnd++;
  }
  if (at > 0) out.push(seg('data before header', 'padding', 0, at));
  out.push(seg(`%PDF-${version}`, 'signature', at, headerEnd - at, `PDF ${version}${headerEnd - at > eol - at + 2 ? ' · binary marker comment' : ''}`));

  type Obj = { seg: Segment; kind: string };
  const objs: Obj[] = [];
  const rest: Segment[] = [];
  const lengths = new Map<number, number>();
  let cursor = headerEnd;
  let eofCount = 0;
  let revision = 1;
  let encrypted = false;
  let linearized = false;
  let compressed = 0;
  let objstms = 0;
  let pagesCount = 0;
  let declaredPages = 0;
  let xrefStream = false;
  let xrefTable = false;
  let stoppedEarly = false;
  let steps = 0;

  const push = (s: Segment): void => {
    rest.push(s);
    cursor = s.offset + s.length;
  };

  while (cursor < size && steps++ < 200_000) {
    if (r.truncated) {
      stoppedEarly = true;
      break;
    }
    const tok = await skipWs(r, cursor);
    if (tok >= size) {
      if (rest.length || objs.length) {
        // trailing whitespace: attach to the last segment
        const last = objs.length && (!rest.length || objs[objs.length - 1]!.seg.offset > rest[rest.length - 1]!.offset) ? objs[objs.length - 1]!.seg : rest[rest.length - 1];
        if (last) last.length = size - last.offset;
      }
      cursor = size;
      break;
    }
    const b = await r.read(tok, 64);
    if (b.length === 0) break;
    const first = b[0] ?? 0;

    // ---- indirect object
    if (isDigit(first)) {
      const hd = parseObjHead(b);
      if (hd) {
        const dictBuf = await r.read(tok, 4096);
        let bodyAt = hd.bodyAt;
        while (bodyAt < dictBuf.length && isWs(dictBuf[bodyAt] ?? 255)) bodyAt++;
        let dictTxt = '';
        let after = -1; // absolute offset just past the dictionary
        let isDict = false;
        if (dictBuf[bodyAt] === 0x3c && dictBuf[bodyAt + 1] === 0x3c) {
          isDict = true;
          let e = dictEnd(dictBuf, bodyAt);
          let buf = dictBuf;
          if (e < 0 && dictBuf.length >= 4096) {
            buf = await r.read(tok, 65536);
            e = dictEnd(buf, bodyAt);
          }
          if (e >= 0) {
            dictTxt = latin1(buf.subarray(bodyAt, Math.min(e, bodyAt + 3000)));
            after = tok + e;
          }
        } else {
          // number / array / string / name object; remember bare integers (stream lengths)
          const m = /^(\d{1,12})\s+endobj/.exec(latin1(dictBuf.subarray(bodyAt, bodyAt + 40)));
          if (m) lengths.set(hd.num, Number(m[1]));
        }
        let objEnd = -1;
        let hasStream = false;
        let streamLen = 0;
        if (isDict && after >= 0) {
          const s0 = await skipWs(r, after);
          const kw = await r.read(s0, 16);
          if (matchAscii(kw, 0, 'stream')) {
            hasStream = true;
            let ds = s0 + 6;
            if (kw[6] === 13 && kw[7] === 10) ds += 2;
            else if (kw[6] === 10 || kw[6] === 13) ds += 1;
            const lm = /\/Length(?![0-9A-Za-z])\s+(\d+)(\s+\d+\s+R)?/.exec(dictTxt);
            let len = -1;
            if (lm) len = lm[2] ? (lengths.get(Number(lm[1])) ?? -1) : Number(lm[1]);
            let endStream = -1;
            if (len >= 0 && ds + len <= size) {
              const e1 = await skipWs(r, ds + len);
              const k2 = await r.read(e1, 9);
              if (matchAscii(k2, 0, 'endstream')) {
                endStream = e1;
                streamLen = len;
              }
            }
            if (endStream < 0) {
              const f = await findForward(r, ds, 'endstream');
              if (f < 0) {
                stoppedEarly = true;
                ctx.truncated = true;
                break;
              }
              endStream = f;
              streamLen = Math.max(0, f - ds - (f - ds >= 2 ? 0 : 0));
            }
            const e2 = await skipWs(r, endStream + 9);
            const k3 = await r.read(e2, 6);
            objEnd = matchAscii(k3, 0, 'endobj') ? e2 + 6 : endStream + 9;
          } else if (matchAscii(kw.subarray(0, 6), 0, 'endobj') || kw.length > 0) {
            objEnd = matchAscii(kw, 0, 'endobj') ? s0 + 6 : -1;
          }
        }
        if (objEnd < 0) {
          const f = await findForward(r, tok, 'endobj', Math.min(size, tok + 4 * 1024 * 1024));
          objEnd = f >= 0 ? f + 6 : Math.min(size, tok + 64);
        }
        const finalEnd = await skipWs(r, objEnd);
        const cls = isDict ? classify(dictTxt, hasStream, streamLen) : { role: 'records' as SegmentRole, kind: 'value', detail: 'value object' };
        if (/\/Linearized\s/.test(dictTxt)) {
          linearized = true;
          cls.detail = `linearization parameters · ${cls.detail}`;
        }
        if (cls.kind === 'Page') pagesCount++;
        if (cls.kind === 'Pages') declaredPages = Math.max(declaredPages, Number(/\/Count\s+(\d+)/.exec(dictTxt)?.[1] ?? 0));
        if (cls.kind === 'ObjStm') {
          objstms++;
          compressed += Number(/\/N\s+(\d+)/.exec(dictTxt)?.[1] ?? 0);
        }
        if (cls.kind === 'XRef') xrefStream = true;
        if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(dictTxt) || (cls.kind === 'XRef' && /\/Encrypt/.test(dictTxt))) encrypted = true;
        const s = seg(`${hd.num} ${hd.gen} obj${cls.suffix ?? ''}`, cls.role, cursor, Math.max(1, finalEnd - cursor), cls.detail);
        objs.push({ seg: s, kind: cls.kind });
        rest.push(s);
        cursor = Math.max(finalEnd, cursor + 1);
        continue;
      }
    }

    // ---- xref table
    if (first === 0x78 && matchAscii(b, 0, 'xref') && isWs(b[4] ?? 0)) {
      let p = await skipWs(r, tok + 4);
      let entries = 0;
      let subs = 0;
      for (let g = 0; g < 100_000; g++) {
        const line = await r.read(p, 40);
        const m = /^(\d+)\s+(\d+)\s*(\r\n|\n|\r)?/.exec(latin1(line));
        if (!m) break;
        const count = Number(m[2]);
        subs++;
        entries += count;
        p += m[0].length + count * 20;
        p = await skipWs(r, p);
        if (p >= size) break;
      }
      // Entries are 20 bytes but some writers use 19/21; re-sync on the 'trailer' keyword.
      const t = await r.read(p, 7);
      if (!matchAscii(t, 0, 'trailer')) {
        const f = await findForward(r, tok, 'trailer', Math.min(size, tok + entries * 22 + 4096));
        if (f >= 0) p = f;
      }
      xrefTable = true;
      push(seg('xref', 'index', cursor, Math.max(1, p - cursor), `cross-reference table · ${entries.toLocaleString('en-US')} entries · ${subs} subsection${subs === 1 ? '' : 's'}`));
      continue;
    }

    // ---- trailer dictionary
    if (first === 0x74 && matchAscii(b, 0, 'trailer')) {
      const buf = await r.read(tok, 4096);
      let i = 7;
      while (i < buf.length && isWs(buf[i] ?? 255)) i++;
      let e = dictEnd(buf, i);
      if (e < 0) e = Math.min(buf.length, i + 2);
      const txt = latin1(buf.subarray(i, Math.min(e, i + 800)));
      if (/\/Encrypt\b/.test(txt)) encrypted = true;
      const size_ = /\/Size\s+(\d+)/.exec(txt)?.[1];
      const prev = /\/Prev\s+(\d+)/.exec(txt)?.[1];
      const end = await skipWs(r, tok + e);
      push(seg('trailer', 'trailer', cursor, Math.max(1, end - cursor), `trailer dictionary${size_ ? ` · /Size ${size_}` : ''}${prev ? ` · /Prev ${prev}` : ''}${/\/Encrypt\b/.test(txt) ? ' · encrypted' : ''}`));
      continue;
    }

    // ---- startxref
    if (first === 0x73 && matchAscii(b, 0, 'startxref')) {
      const m = /^startxref\s+(\d+)/.exec(latin1(b));
      let end = tok + 9;
      if (m) end = tok + m[0].length;
      end = await skipWs(r, end);
      push(seg('startxref', 'trailer', cursor, Math.max(1, end - cursor), m ? `xref at byte ${Number(m[1]).toLocaleString('en-US')}` : undefined));
      continue;
    }

    // ---- %%EOF and other comments
    if (first === 0x25) {
      let e = tok;
      const line = await r.read(tok, 256);
      let i = 0;
      while (i < line.length && line[i] !== 10 && line[i] !== 13) i++;
      e = tok + i;
      const isEof = matchAscii(line, 0, '%%EOF');
      const end = await skipWs(r, e);
      if (isEof) {
        eofCount++;
        push(seg('%%EOF', 'trailer', cursor, Math.max(1, end - cursor), `end of revision ${revision}`));
        revision++;
      } else push(seg('comment', 'padding', cursor, Math.max(1, end - cursor)));
      continue;
    }

    // ---- unknown line
    {
      const line = await r.read(tok, 512);
      let i = 0;
      while (i < line.length && line[i] !== 10 && line[i] !== 13) i++;
      const end = await skipWs(r, tok + Math.max(1, i));
      pushMerged(rest, seg('unparsed data', 'unknown', cursor, Math.max(1, end - cursor)));
      cursor = Math.max(end, cursor + 1);
    }
  }

  // Merge long runs of same-kind objects so big files stay inside the segment cap.
  let body: Segment[] = rest;
  if (objs.length > 1500) {
    const kindOf = new Map<Segment, string>(objs.map((o) => [o.seg, o.kind]));
    body = [];
    let prevKind = '';
    for (const s of rest) {
      const k = kindOf.get(s);
      const last = body[body.length - 1];
      if (k && last && prevKind === k && last.role === s.role && last.offset + last.length === s.offset) {
        last.length += s.length;
        last.count = (last.count ?? 1) + 1;
        last.detail = `${last.count.toLocaleString('en-US')} × ${k === 'dict' ? 'objects' : k}`;
      } else body.push(s);
      prevKind = k ?? '';
    }
  }
  if (linearized) {
    let k = 0;
    for (const s of body) if (s.name === '%%EOF') s.detail = `end of ${++k === 1 ? 'first-page section' : 'main section'}`;
  }
  out.push(...body);
  if (stoppedEarly || r.truncated) {
    ctx.truncated = true;
    // Still describe the file end (startxref / %%EOF) from a small reserved read.
    const tailLen = Math.min(size - cursor, 2048);
    if (tailLen > 0) {
      const tailStart = size - tailLen;
      const tail = await r.readReserved(tailStart, tailLen);
      const sx = indexOfAscii(tail, 'startxref');
      if (sx >= 0 && tailStart + sx > cursor) {
        if (tailStart + sx > cursor) out.push(seg('unparsed objects', 'unknown', cursor, tailStart + sx - cursor, 'not walked (read budget reached)'));
        const eof = indexOfAscii(tail, '%%EOF', sx);
        out.push(seg('startxref', 'trailer', tailStart + sx, eof >= 0 ? eof - sx : tail.length - sx));
        if (eof >= 0) out.push(seg('%%EOF', 'trailer', tailStart + eof, tail.length - eof, 'end of file'));
      } else if (cursor < size) out.push(seg('unparsed data', 'unknown', cursor, size - cursor, 'not walked (read budget reached)'));
    }
  }

  const objCount = objs.length;
  const images = objs.filter((o) => o.kind === 'Image').length;
  const fonts = objs.filter((o) => o.kind === 'Font').length;
  const pages = declaredPages || pagesCount;
  const bits = [`PDF ${version}`];
  if (pages) bits.push(`${pages.toLocaleString('en-US')} page${pages === 1 ? '' : 's'}`);
  bits.push(`${objCount.toLocaleString('en-US')} objects`);
  if (compressed) bits.push(`+${compressed.toLocaleString('en-US')} in ${objstms} object stream${objstms === 1 ? '' : 's'}`);
  if (images) bits.push(`${images} image${images === 1 ? '' : 's'}`);
  if (fonts) bits.push(`${fonts} font${fonts === 1 ? '' : 's'}`);
  bits.push(xrefStream ? 'xref stream' : xrefTable ? 'xref table' : 'no xref');
  if (eofCount > 1 && !linearized) bits.push(`${eofCount} revisions (incremental updates)`);
  if (linearized) bits.push('linearized');
  if (encrypted) bits.push('encrypted');
  ctx.summary = bits.join(' · ');
}
