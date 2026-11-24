import type { Segment, SegmentRole } from './types';
import { type Ctx, type Reader, ascii, cleanText, fmtBytes, fmtChannels, fmtDuration, fmtRate, fourcc, latin1, pushMerged, restUnknown, seg, u16le, u24le, u32le } from './util';

const WAV_TAGS: Record<number, string> = {
  1: 'PCM',
  2: 'MS ADPCM',
  3: 'IEEE float',
  6: 'A-law',
  7: 'µ-law',
  0x11: 'IMA ADPCM',
  0x55: 'MP3',
  0xfffe: 'extensible',
};

function wavRole(id: string): SegmentRole {
  switch (id) {
    case 'fmt ':
    case 'fact':
    case 'ds64':
      return 'header';
    case 'data':
      return 'samples';
    case 'LIST':
    case 'bext':
    case 'iXML':
    case 'id3 ':
    case 'ID3 ':
    case '_PMX':
    case 'cart':
      return 'metadata';
    case 'cue ':
    case 'smpl':
    case 'inst':
      return 'index';
    case 'JUNK':
    case 'PAD ':
    case 'FLLR':
    case 'junk':
      return 'padding';
    default:
      return 'unknown';
  }
}

function webpRole(id: string): SegmentRole {
  switch (id) {
    case 'VP8 ':
    case 'VP8L':
    case 'ALPH':
      return 'pixels';
    case 'VP8X':
    case 'ANIM':
      return 'header';
    case 'ANMF':
      return 'container';
    case 'ICCP':
      return 'palette';
    case 'EXIF':
    case 'XMP ':
      return 'metadata';
    default:
      return 'unknown';
  }
}

interface RiffState {
  fmt?: { tag: number; channels: number; rate: number; byteRate: number; bits: number };
  dataLen?: number;
  webp: { w: number; h: number; kind: string; alpha: boolean; anim: boolean; frames: number; icc: boolean; exif: boolean; xmp: boolean };
}

async function webpDetail(r: Reader, id: string, pos: number, len: number, st: RiffState): Promise<string | undefined> {
  const d = await r.read(pos + 8, Math.min(len, 40));
  switch (id) {
    case 'VP8X': {
      const f = d[0] ?? 0;
      st.webp.alpha = !!(f & 0x10);
      st.webp.anim = !!(f & 0x02);
      st.webp.icc = !!(f & 0x20);
      st.webp.exif = !!(f & 0x08);
      st.webp.xmp = !!(f & 0x04);
      st.webp.w = u24le(d, 4) + 1;
      st.webp.h = u24le(d, 7) + 1;
      const flags = [f & 0x10 ? 'alpha' : '', f & 0x02 ? 'animation' : '', f & 0x20 ? 'ICC' : '', f & 0x08 ? 'EXIF' : '', f & 0x04 ? 'XMP' : ''].filter(Boolean);
      return `canvas ${st.webp.w}×${st.webp.h}${flags.length ? ' · ' + flags.join(', ') : ''}`;
    }
    case 'VP8 ': {
      if (d.length >= 10 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a) {
        const w = u16le(d, 6) & 0x3fff;
        const h = u16le(d, 8) & 0x3fff;
        if (!st.webp.w) {
          st.webp.w = w;
          st.webp.h = h;
        }
        st.webp.kind ||= 'lossy';
        return `lossy VP8 ${w}×${h} · ${fmtBytes(len)}`;
      }
      return 'lossy VP8';
    }
    case 'VP8L': {
      if ((d[0] ?? 0) === 0x2f && d.length >= 5) {
        const bits = u32le(d, 1);
        const w = (bits & 0x3fff) + 1;
        const h = ((bits >> 14) & 0x3fff) + 1;
        if (!st.webp.w) {
          st.webp.w = w;
          st.webp.h = h;
        }
        st.webp.kind ||= 'lossless';
        return `lossless VP8L ${w}×${h}${(bits >> 28) & 1 ? ' · alpha' : ''} · ${fmtBytes(len)}`;
      }
      return 'lossless VP8L';
    }
    case 'ALPH':
      return `alpha plane · compression ${(d[0] ?? 0) & 3}, filter ${((d[0] ?? 0) >> 2) & 3}`;
    case 'ANIM':
      return `loop count ${u16le(d, 4) || '∞'}`;
    case 'ANMF': {
      st.webp.frames++;
      return `frame ${u24le(d, 6) + 1}×${u24le(d, 9) + 1} at (${u24le(d, 0) * 2},${u24le(d, 3) * 2}) · ${u24le(d, 12)} ms`;
    }
    case 'ICCP':
      return `ICC profile · ${fmtBytes(len)}`;
    case 'EXIF':
      return `Exif · ${fmtBytes(len)}`;
    case 'XMP ':
      return `XMP · ${fmtBytes(len)}`;
    default:
      return undefined;
  }
}

async function walkChunks(
  ctx: Ctx,
  kind: 'WEBP' | 'WAVE',
  start: number,
  end: number,
  list: Segment[],
  st: RiffState,
  depth: number,
): Promise<number> {
  const r = ctx.r;
  let pos = start;
  while (pos + 8 <= end) {
    const h = await r.read(pos, 8);
    if (h.length < 8) break;
    const id = fourcc(h, 0);
    if (!/^[\x20-\x7e]{4}$/.test(id)) break;
    const len = u32le(h, 4);
    let total = 8 + len + (len & 1);
    let clipped = false;
    if (pos + total > end) {
      total = end - pos;
      clipped = true;
    }
    let detail: string | undefined;
    let children: Segment[] | undefined;
    let role: SegmentRole = kind === 'WEBP' ? webpRole(id) : wavRole(id);
    if (kind === 'WAVE') {
      if (id === 'fmt ') {
        const d = await r.read(pos + 8, Math.min(len, 40));
        const tag = u16le(d, 0);
        const channels = u16le(d, 2);
        const rate = u32le(d, 4);
        const byteRate = u32le(d, 8);
        const bits = u16le(d, 14);
        st.fmt = { tag, channels, rate, byteRate, bits };
        detail = `${WAV_TAGS[tag] ?? `format 0x${tag.toString(16)}`} · ${fmtRate(rate)} · ${fmtChannels(channels)} · ${bits}-bit`;
      } else if (id === 'data') {
        const avail = Math.max(0, Math.min(len, end - pos - 8));
        st.dataLen = avail;
        detail = st.fmt && st.fmt.byteRate > 0 ? `${fmtBytes(avail)} · ${fmtDuration(avail / st.fmt.byteRate)}` : fmtBytes(avail);
      } else if (id === 'LIST') {
        const t = await r.read(pos + 8, 4);
        const lt = ascii(t, 0, 4);
        detail = `${lt} list`;
        if (depth < 2 && len >= 4) {
          children = [];
          await walkChunks(ctx, kind, pos + 12, Math.min(end, pos + 8 + len), children, st, depth + 1);
        }
      } else if (id === 'fact') {
        const d = await r.read(pos + 8, 4);
        detail = `${u32le(d, 0).toLocaleString('en-US')} sample frames`;
      } else if (depth > 0) {
        const d = await r.read(pos + 8, Math.min(len, 40));
        detail = cleanText(latin1(d), 36);
        role = 'metadata';
      }
    } else {
      detail = await webpDetail(r, id, pos, len, st);
      if (id === 'ANMF' && depth < 1) {
        children = [];
        await walkChunks(ctx, kind, pos + 8 + 16, Math.min(end, pos + 8 + len), children, st, depth + 1);
        children.unshift(seg('frame header', 'header', pos + 8, 16, detail));
      }
    }
    if (clipped) detail = `${detail ? detail + ' · ' : ''}cut off by end of file`;
    pushMerged(list, seg(id, role, pos, total, detail, { children }));
    pos += total;
    if (clipped) break;
  }
  return pos;
}

export async function parseRiff(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const h = await r.read(0, 12);
  if (h.length < 12) return;
  const magic = ascii(h, 0, 4);
  if (magic !== 'RIFF' && magic !== 'RF64') return;
  const kind = ascii(h, 8, 4);
  if (kind !== 'WEBP' && kind !== 'WAVE') return;
  const declared = u32le(h, 4);
  const end = magic === 'RF64' || declared + 8 > size || declared < 4 ? size : declared + 8;
  out.push(seg(`${magic} header`, 'signature', 0, 12, `${kind === 'WEBP' ? 'WebP' : 'WAVE'} · declared size ${declared.toLocaleString('en-US')}${declared + 8 > size && magic === 'RIFF' ? ' (file is shorter)' : ''}`));
  const st: RiffState = { webp: { w: 0, h: 0, kind: '', alpha: false, anim: false, frames: 0, icc: false, exif: false, xmp: false } };
  const pos = await walkChunks(ctx, kind as 'WEBP' | 'WAVE', 12, end, out, st, 0);
  for (const s of out) {
    if (s.count && s.count > 1) {
      if (s.name === 'ANMF') s.detail = `${s.count} animation frames · ${fmtBytes(s.length)}`;
      else s.detail = `${s.count} chunks`;
    }
  }
  if (pos < size) restUnknown(ctx, pos, pos >= end ? 'data after RIFF' : 'unparsed data');

  if (kind === 'WAVE') {
    const f = st.fmt;
    if (f) {
      const dur = f.byteRate > 0 && st.dataLen !== undefined ? ` · ${fmtDuration(st.dataLen / f.byteRate)}` : '';
      ctx.summary = `WAV ${WAV_TAGS[f.tag] ?? 'audio'} ${fmtRate(f.rate)} ${fmtChannels(f.channels)} ${f.bits}-bit${dur}`;
    } else ctx.summary = 'WAV · no fmt chunk';
  } else {
    const w = st.webp;
    const kindName = w.anim ? `animated · ${w.frames} frame${w.frames === 1 ? '' : 's'}` : w.kind || 'unknown coding';
    ctx.summary = `WebP ${w.w || '?'}×${w.h || '?'} · ${kindName}${w.alpha ? ' · alpha' : ''}${w.icc ? ' · ICC' : ''}${w.exif ? ' · EXIF' : ''}${w.xmp ? ' · XMP' : ''}`;
  }
}
