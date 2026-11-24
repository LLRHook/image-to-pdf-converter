import type { Segment, SegmentRole } from './types';
import {
  type Ctx,
  type Reader,
  ascii,
  cleanText,
  fmtBytes,
  fmtChannels,
  fmtDuration,
  fmtRate,
  fourcc,
  latin1,
  pushMerged,
  restUnknown,
  seg,
  u16be,
  u32be,
  u64be,
} from './util';

export interface BoxHeader {
  type: string;
  start: number;
  /** Total box length including its header, clamped to `end`. */
  size: number;
  /** Header length (8, 16, +16 for uuid). */
  hdr: number;
  clipped: boolean;
}

/** Read a box header at `pos`; undefined when it is not a plausible box. */
export async function readBoxHeader(r: Reader, pos: number, end: number): Promise<BoxHeader | undefined> {
  if (pos + 8 > end) return undefined;
  const b = await r.read(pos, 32);
  if (b.length < 8) return undefined;
  let size = u32be(b, 0);
  let type = '';
  for (let i = 4; i < 8; i++) {
    const c = b[i] ?? 0;
    if (c < 0x20 || c === 0x7f) return undefined;
    type += String.fromCharCode(c);
  }
  let hdr = 8;
  if (size === 1) {
    if (b.length < 16) return undefined;
    size = u64be(b, 8);
    hdr = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (type === 'uuid') hdr += 16;
  if (!Number.isFinite(size) || size < hdr) return undefined;
  let clipped = false;
  if (pos + size > end) {
    size = end - pos;
    clipped = true;
  }
  return { type, start: pos, size, hdr, clipped };
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta', 'mvex', 'moof', 'traf', 'mfra', 'tref', 'sinf', 'schi', 'ipro', 'iprp', 'ipco', 'grpl', 'trgr', 'ilst']);
const HEADERS = new Set(['ftyp', 'styp', 'mvhd', 'tkhd', 'mdhd', 'hdlr', 'elst', 'vmhd', 'smhd', 'nmhd', 'hmhd', 'sthd', 'mehd', 'trex', 'mfhd', 'tfhd', 'tfdt', 'stsd', 'url ', 'urn ', 'dref', 'pitm', 'ispe', 'pixi', 'pasp', 'clap', 'irot', 'imir', 'auxC', 'hvcC', 'avcC', 'av1C', 'vpcC', 'esds', 'btrt', 'jxll', 'ihdr']);
const INDEXES = new Set(['stts', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'stss', 'ctts', 'cslg', 'sgpd', 'sbgp', 'subs', 'saiz', 'saio', 'stps', 'sdtp', 'trun', 'tfra', 'mfro', 'sidx', 'ssix', 'iloc', 'iinf', 'infe', 'iref', 'ipma', 'jxli', 'stbl']);

const CODECS: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'HEVC',
  hev1: 'HEVC',
  dvh1: 'Dolby Vision',
  av01: 'AV1',
  vp08: 'VP8',
  vp09: 'VP9',
  mp4v: 'MPEG-4 Visual',
  jpeg: 'JPEG',
  mjp2: 'JPEG 2000',
  apcn: 'ProRes 422',
  apch: 'ProRes 422 HQ',
  mp4a: 'AAC',
  alac: 'ALAC',
  'ac-3': 'AC-3',
  'ec-3': 'E-AC-3',
  Opus: 'Opus',
  fLaC: 'FLAC',
  '.mp3': 'MP3',
  sowt: 'PCM (little-endian)',
  ipcm: 'PCM',
  fpcm: 'PCM (float)',
  in24: 'PCM 24-bit',
  in32: 'PCM 32-bit',
  fl32: 'PCM float32',
  fl64: 'PCM float64',
  'raw ': 'PCM',
  twos: 'PCM (big-endian)',
  lpcm: 'PCM',
  ulaw: 'µ-law',
  samr: 'AMR-NB',
  tx3g: 'timed text',
  wvtt: 'WebVTT',
  c608: 'CEA-608',
  mett: 'metadata',
  tmcd: 'timecode',
};

interface Track {
  id?: number;
  handler?: string;
  timescale?: number;
  duration?: number;
  entry?: string;
  w?: number;
  h?: number;
  rate?: number;
  channels?: number;
  bits?: number;
  samples?: number;
}

interface State {
  ctx: Ctx;
  fmt: string;
  nodes: number;
  tracks: Track[];
  cur?: Track;
  movieTimescale: number;
  movieDuration: number;
  brand: string;
  compat: string[];
  ispe: Array<[number, number]>;
  itemTypes: Map<string, number>;
  curItemTypes?: Map<string, number>;
  moofs: number;
}

function roleOf(type: string, parent: string, fmt: string): SegmentRole {
  if (parent === 'ilst') return 'metadata';
  if (type === 'mdat') return fmt === 'heic' || fmt === 'avif' || fmt === 'jxl' ? 'pixels' : 'samples';
  if (type === 'idat' || type === 'jxlc' || type === 'jxlp') return 'pixels';
  if (type === 'free' || type === 'skip' || type === 'wide' || type === 'junk') return 'padding';
  if (type === 'colr') return 'palette';
  if (type === 'udta' || type === 'ilst' || type === 'Exif' || type === 'xml ' || type === 'XMP_' || type === 'uuid' || type === 'emsg' || type === 'mime' || type === 'brob' || type === 'keys' || type === 'cdsc') return 'metadata';
  if (CONTAINERS.has(type) && type !== 'stbl') return 'container';
  if (type === 'meta') return parent === 'udta' ? 'metadata' : 'container';
  if (HEADERS.has(type)) return 'header';
  if (INDEXES.has(type)) return 'index';
  if (parent === 'stsd') return 'header';
  return 'unknown';
}

function fixed1616(b: Uint8Array, o: number): number {
  return u32be(b, o) / 65536;
}

async function boxPayload(r: Reader, b: BoxHeader, max: number): Promise<Uint8Array> {
  return r.read(b.start + b.hdr, Math.max(0, Math.min(b.size - b.hdr, max)));
}

async function describeLeaf(st: State, b: BoxHeader, parent: string): Promise<string | undefined> {
  const r = st.ctx.r;
  const t = b.type;
  switch (t) {
    case 'ftyp':
    case 'styp': {
      const d = await boxPayload(r, b, 128);
      const major = ascii(d, 0, 4);
      const compat: string[] = [];
      for (let o = 8; o + 4 <= d.length; o += 4) compat.push(ascii(d, o, 4));
      if (t === 'ftyp') {
        st.brand = major;
        st.compat = compat;
      }
      return `${major}${compat.length ? ' · compatible: ' + compat.join(' ') : ''}`;
    }
    case 'mvhd':
    case 'mdhd': {
      const d = await boxPayload(r, b, 40);
      const v1 = d[0] === 1;
      const ts = u32be(d, v1 ? 20 : 12);
      const dur = v1 ? u64be(d, 24) : u32be(d, 16);
      if (t === 'mvhd') {
        st.movieTimescale = ts;
        st.movieDuration = dur;
      } else if (st.cur) {
        st.cur.timescale = ts;
        st.cur.duration = dur;
      }
      return ts > 0 ? `timescale ${ts} · duration ${fmtDuration(dur / ts)}` : undefined;
    }
    case 'tkhd': {
      const d = await boxPayload(r, b, 100);
      const v1 = d[0] === 1;
      const id = u32be(d, v1 ? 20 : 12);
      const wo = v1 ? 88 : 76;
      const w = fixed1616(d, wo);
      const h = fixed1616(d, wo + 4);
      if (st.cur) st.cur.id = id;
      return `track ${id}${w > 0 ? ` · ${Math.round(w)}×${Math.round(h)}` : ''}`;
    }
    case 'hdlr': {
      const d = await boxPayload(r, b, 64);
      const handler = ascii(d, 8, 4);
      if (st.cur && parent === 'mdia') st.cur.handler = handler;
      const name = cleanText(latin1(d.subarray(24)), 30);
      return `handler ${handler}${name ? ` · ${name}` : ''}`;
    }
    case 'stsz': {
      const d = await boxPayload(r, b, 16);
      const n = u32be(d, 8);
      if (st.cur) st.cur.samples = n;
      return `${n.toLocaleString('en-US')} samples${u32be(d, 4) ? ` · fixed size ${u32be(d, 4)}` : ''}`;
    }
    case 'stz2': {
      const d = await boxPayload(r, b, 16);
      return `${u32be(d, 8).toLocaleString('en-US')} samples`;
    }
    case 'stts':
    case 'stsc':
    case 'stco':
    case 'co64':
    case 'stss':
    case 'ctts':
    case 'elst': {
      const d = await boxPayload(r, b, 8);
      const n = u32be(d, 4);
      return `${n.toLocaleString('en-US')} ${t === 'stco' || t === 'co64' ? 'chunk offsets' : t === 'stss' ? 'sync samples' : 'entries'}`;
    }
    case 'trun': {
      const d = await boxPayload(r, b, 8);
      return `${u32be(d, 4).toLocaleString('en-US')} samples in run`;
    }
    case 'mfhd': {
      const d = await boxPayload(r, b, 8);
      return `fragment ${u32be(d, 4)}`;
    }
    case 'sidx': {
      const d = await boxPayload(r, b, 40);
      const v = d[0] ?? 0;
      const refs = u16be(d, v === 0 ? 22 : 30);
      return `${refs} segment reference${refs === 1 ? '' : 's'}`;
    }
    case 'pitm': {
      const d = await boxPayload(r, b, 12);
      return `primary item ${(d[0] ?? 0) === 0 ? u16be(d, 4) : u32be(d, 4)}`;
    }
    case 'ispe': {
      const d = await boxPayload(r, b, 12);
      const w = u32be(d, 4);
      const h = u32be(d, 8);
      st.ispe.push([w, h]);
      return `${w}×${h}`;
    }
    case 'pixi': {
      const d = await boxPayload(r, b, 12);
      const n = d[4] ?? 0;
      return `${n} channel${n === 1 ? '' : 's'} · ${d[5] ?? 0}-bit`;
    }
    case 'colr': {
      const d = await boxPayload(r, b, 12);
      const kind = ascii(d, 0, 4);
      return kind === 'nclx' ? 'nclx colour description' : kind === 'prof' || kind === 'rICC' ? `ICC profile · ${fmtBytes(b.size - b.hdr - 4)}` : kind;
    }
    case 'irot': {
      const d = await boxPayload(r, b, 1);
      return `rotate ${((d[0] ?? 0) & 3) * 90}°`;
    }
    case 'iloc': {
      const d = await boxPayload(r, b, 12);
      const v = d[0] ?? 0;
      const count = v < 2 ? u16be(d, 6) : u32be(d, 6);
      return `${count} item location${count === 1 ? '' : 's'}`;
    }
    case 'infe': {
      const d = await boxPayload(r, b, 24);
      const v = d[0] ?? 0;
      let type = '';
      if (v === 2) type = ascii(d, 8, 4);
      else if (v >= 3) type = ascii(d, 10, 4);
      if (type) {
        st.itemTypes.set(type, (st.itemTypes.get(type) ?? 0) + 1);
        st.curItemTypes?.set(type, (st.curItemTypes.get(type) ?? 0) + 1);
      }
      return type ? `item type ${type}` : undefined;
    }
    case 'esds':
      return 'MPEG-4 elementary stream descriptor';
    case 'avcC': {
      const d = await boxPayload(r, b, 8);
      return `AVC profile ${d[1] ?? 0}, level ${((d[3] ?? 0) / 10).toFixed(1)}`;
    }
    case 'hvcC': {
      const d = await boxPayload(r, b, 8);
      return `HEVC profile ${(d[1] ?? 0) & 31}, level ${((d[12] ?? 0) / 30).toFixed(1)}`;
    }
    case 'av1C': {
      const d = await boxPayload(r, b, 4);
      return `AV1 profile ${(d[1] ?? 0) >> 5}, level ${(d[1] ?? 0) & 31}`;
    }
    case 'Exif':
      return `Exif · ${fmtBytes(b.size - b.hdr)}`;
    case 'xml ':
      return `XML metadata · ${fmtBytes(b.size - b.hdr)}`;
    case 'uuid': {
      const d = await r.read(b.start + 8, 16);
      let s = '';
      for (const x of d) s += x.toString(16).padStart(2, '0');
      return `extended type ${s.slice(0, 8)}-${s.slice(8, 12)}-…`;
    }
    case 'data': {
      if (parent === 'ilst' || b.type === 'data') {
        const d = await boxPayload(r, b, 48);
        const kind = u32be(d, 0) & 0xffffff;
        if (kind === 1) return `text: ${cleanText(latin1(d.subarray(8)), 40)}`;
        return kind === 13 ? 'JPEG cover art' : kind === 14 ? 'PNG cover art' : `data type ${kind}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];
const AOT_NAMES: Record<number, string> = { 1: 'AAC Main', 2: 'AAC-LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'HE-AAC', 29: 'HE-AACv2', 23: 'AAC-LD', 39: 'AAC-ELD', 42: 'USAC' };

/** AudioSpecificConfig from the 'esds' box nested in an audio sample entry (payload starts after the 8-byte box header). */
function readEsds(p: Uint8Array): { aot: number; rate: number; channels: number } | undefined {
  // Audio sample entry v0 has 28 bytes of fixed fields, then child boxes.
  let o = 28;
  while (o + 8 <= p.length) {
    const size = u32be(p, o);
    if (size < 8) return undefined;
    if (fourcc(p, o + 4) === 'esds') {
      let q = o + 8 + 4; // skip version/flags
      const end = Math.min(p.length, o + size);
      while (q + 2 <= end) {
        const tag = p[q] ?? 0;
        q++;
        let len = 0;
        for (let k = 0; k < 4 && q < end; k++) {
          const b = p[q++] ?? 0;
          len = (len << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        if (tag === 0x03) q += 3; // ES_ID + flags: descend into the nested descriptors
        else if (tag === 0x04) q += 13; // object type, stream type, buffer size, bitrates: descend
        else if (tag === 0x05) {
          let bit = q * 8;
          const take = (n: number): number => {
            let v = 0;
            for (let i = 0; i < n; i++) {
              v = (v << 1) | (((p[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
              bit++;
            }
            return v;
          };
          let aot = take(5);
          if (aot === 31) aot = 32 + take(6);
          const fi = take(4);
          const rate = fi === 15 ? take(24) : (AAC_RATES[fi] ?? 0);
          const cc = take(4);
          return { aot, rate, channels: AAC_CHANNELS[cc] ?? 0 };
        } else q += len;
      }
      return undefined;
    }
    o += size;
  }
  return undefined;
}

async function stsdEntries(st: State, b: BoxHeader, list: Segment[]): Promise<string | undefined> {
  const r = st.ctx.r;
  const d = await boxPayload(r, b, 8);
  const count = u32be(d, 4);
  let pos = b.start + b.hdr + 8;
  const end = b.start + b.size;
  let first: string | undefined;
  for (let i = 0; i < count && i < 64 && pos + 8 <= end; i++) {
    const eb = await readBoxHeader(r, pos, end);
    if (!eb) break;
    const p = await boxPayload(r, eb, 200);
    let detail = CODECS[eb.type] ? `${CODECS[eb.type]}` : undefined;
    const tr = st.cur;
    if (i === 0 && tr) {
      tr.entry = eb.type;
      if (tr.handler === 'vide' && p.length >= 28) {
        tr.w = u16be(p, 24);
        tr.h = u16be(p, 26);
        detail = `${detail ?? eb.type} ${tr.w}×${tr.h}`;
      } else if (tr.handler === 'soun' && p.length >= 28) {
        tr.channels = u16be(p, 16);
        tr.bits = u16be(p, 18);
        tr.rate = u32be(p, 24) >>> 16;
        let codec = detail ?? eb.type;
        if (eb.type === 'mp4a') {
          // The sample entry's channel count is often a placeholder; the AudioSpecificConfig is authoritative.
          const asc = readEsds(p);
          if (asc && asc.rate) {
            tr.rate = asc.rate;
            if (asc.channels) tr.channels = asc.channels;
            codec = AOT_NAMES[asc.aot] ?? 'AAC';
            tr.bits = 0;
          }
        }
        detail = `${codec} ${fmtRate(tr.rate)} ${fmtChannels(tr.channels)}${tr.bits ? ` ${tr.bits}-bit` : ''}`;
      }
    }
    first ??= eb.type;
    list.push(seg(eb.type, 'header', pos, eb.size, detail));
    pos += eb.size;
  }
  return first ? `${count} sample entr${count === 1 ? 'y' : 'ies'} · ${first}` : undefined;
}

function trackDetail(t: Track): string {
  const parts: string[] = [];
  const kind = t.handler === 'vide' ? 'video' : t.handler === 'soun' ? 'audio' : t.handler === 'sbtl' || t.handler === 'text' || t.handler === 'subt' ? 'subtitles' : t.handler === 'pict' ? 'image' : t.handler ?? 'track';
  parts.push(`${kind} (${t.handler ?? '?'})`);
  if (t.entry) parts.push(`${t.entry}${CODECS[t.entry] ? ' ' + CODECS[t.entry] : ''}`);
  if (t.w && t.h) parts.push(`${t.w}×${t.h}`);
  if (t.rate) parts.push(`${fmtRate(t.rate)} ${fmtChannels(t.channels ?? 0)}`);
  const secs = t.timescale && t.duration !== undefined ? t.duration / t.timescale : 0;
  if (t.handler === 'vide' && t.samples && secs > 0) parts.push(`${+(t.samples / secs).toFixed(2)} fps`);
  if (t.samples) parts.push(`${t.samples.toLocaleString('en-US')} samples`);
  return parts.join(' · ');
}

async function walk(st: State, start: number, end: number, depth: number, parent: string, list: Segment[]): Promise<number> {
  const r = st.ctx.r;
  let pos = start;
  let guard = 0;
  while (pos + 8 <= end && guard++ < 100_000) {
    if (st.nodes > 40_000 || r.truncated) {
      st.ctx.truncated = true;
      break;
    }
    const b = await readBoxHeader(r, pos, end);
    if (!b) break;
    st.nodes++;
    const { type } = b;
    const boxEnd = b.start + b.size;
    const role = roleOf(type, parent, st.fmt);
    let detail: string | undefined;
    const children: Segment[] = [];
    const isTrak = type === 'trak';
    const prevCur = st.cur;
    if (isTrak) {
      st.cur = {};
      st.tracks.push(st.cur);
    }
    const payload = b.start + b.hdr;
    if (type === 'stsd') {
      detail = await stsdEntries(st, b, children);
    } else if (type === 'meta') {
      // ISOBMFF meta is a FullBox; QuickTime's is a plain box whose first child is hdlr.
      const probe = await r.read(payload, 8);
      const plain = fourcc(probe, 4) === 'hdlr';
      if (depth < 8) await walk(st, payload + (plain ? 0 : 4), boxEnd, depth + 1, type, children);
    } else if (type === 'iinf') {
      const probe = await r.read(payload, 8);
      const v = probe[0] ?? 0;
      const types = new Map<string, number>();
      st.curItemTypes = types;
      if (depth < 8) await walk(st, payload + (v === 0 ? 6 : 8), boxEnd, depth + 1, type, children);
      st.curItemTypes = undefined;
      const total = [...types.values()].reduce((a, c) => a + c, 0);
      detail = `${total} item${total === 1 ? '' : 's'}: ${[...types.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ')}`;
    } else if (type === 'dref') {
      if (depth < 8) await walk(st, payload + 8, boxEnd, depth + 1, type, children);
    } else if ((CONTAINERS.has(type) || parent === 'ilst') && depth < 8) {
      await walk(st, payload, boxEnd, depth + 1, type, children);
    } else if (type !== 'mdat') {
      detail = await describeLeaf(st, b, parent);
    } else {
      detail = `${fmtBytes(b.size - b.hdr)} of ${st.fmt === 'heic' || st.fmt === 'avif' ? 'image' : 'media'} data`;
    }
    if (isTrak && st.cur) {
      detail = trackDetail(st.cur);
      st.cur = prevCur;
    }
    if (type === 'moov' && !detail) {
      const n = st.tracks.length;
      detail = `${n} track${n === 1 ? '' : 's'}${st.movieTimescale ? ` · ${fmtDuration(st.movieDuration / st.movieTimescale)}` : ''}`;
    }
    if (b.clipped) detail = `${detail ? detail + ' · ' : ''}cut off by end of file`;
    const s = seg(type, role, b.start, b.size, detail, { children });
    if (type === 'trak') list.push(s);
    else pushMerged(list, s);
    pos = boxEnd;
    if (b.clipped) break;
  }
  return pos;
}

/** Combine alternating moof+mdat pairs (fragmented MP4) so thousands of fragments stay readable. */
function pairFragments(list: Segment[], fmt: string): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    const b = list[i + 1];
    if (a.name === 'moof' && b && b.name === 'mdat' && !a.count && a.offset + a.length === b.offset) {
      const trun = a.children?.flatMap((c) => c.children ?? []).find((c) => c.name === 'trun');
      const frag: Segment = {
        name: 'moof + mdat',
        role: 'container',
        offset: a.offset,
        length: a.length + b.length,
        detail: `fragment · ${fmtBytes(b.length)} ${fmt === 'm4a' ? 'audio' : 'media'}${trun?.detail ? ' · ' + trun.detail : ''}`,
        children: [a, b],
      };
      i++;
      const last = out[out.length - 1];
      if (last && last.name === 'moof + mdat' && last.offset + last.length === frag.offset) {
        last.length += frag.length;
        last.count = (last.count ?? 1) + 1;
        delete last.children;
        last.detail = `${last.count} fragments · ${fmtBytes(last.length)}`;
      } else out.push(frag);
    } else out.push(a);
  }
  return out;
}

export async function parseIsobmff(ctx: Ctx): Promise<void> {
  const { r } = ctx;
  const size = r.size;
  const st: State = {
    ctx,
    fmt: ctx.format,
    nodes: 0,
    tracks: [],
    movieTimescale: 0,
    movieDuration: 0,
    brand: '',
    compat: [],
    ispe: [],
    itemTypes: new Map(),
    moofs: 0,
  };
  const first = await r.read(0, 16);
  if (first.length < 8) return;
  const firstType = fourcc(first, 4);
  const known = ['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'meta', 'moof', 'sidx', 'uuid', 'jP  ', 'mfra'];
  if (!known.includes(firstType)) return;

  const list: Segment[] = [];
  const end = await walk(st, 0, size, 0, '', list);
  const paired = pairFragments(list, ctx.format);
  ctx.out.push(...paired);
  if (end < size) restUnknown(ctx, end);

  const major = st.brand;
  const label =
    ctx.format === 'heic' ? 'HEIC' : ctx.format === 'avif' ? 'AVIF' : ctx.format === 'm4a' ? 'M4A' : ctx.format === 'mov' ? 'QuickTime' : 'MP4';
  const bits: string[] = [];
  if (ctx.format === 'heic' || ctx.format === 'avif') {
    const img = st.ispe[0];
    if (img) bits.push(`${img[0]}×${img[1]}`);
    const total = [...st.itemTypes.values()].reduce((a, c) => a + c, 0);
    if (total) bits.push(`${total} item${total === 1 ? '' : 's'}`);
  } else {
    for (const t of st.tracks) {
      if (t.handler === 'vide') bits.push(`${CODECS[t.entry ?? ''] ?? t.entry ?? 'video'} ${t.w ?? '?'}×${t.h ?? '?'}`);
      else if (t.handler === 'soun') bits.push(`${CODECS[t.entry ?? ''] ?? t.entry ?? 'audio'} ${fmtRate(t.rate ?? 0)} ${fmtChannels(t.channels ?? 0)}`);
    }
    if (st.movieTimescale && st.movieDuration) bits.push(fmtDuration(st.movieDuration / st.movieTimescale));
    if (paired.some((s) => s.name === 'moof + mdat')) bits.push('fragmented');
  }
  ctx.summary = `${label}${major ? ` (${major.trim()})` : ''}${bits.length ? ' · ' + bits.join(' · ') : ''}`;
}
