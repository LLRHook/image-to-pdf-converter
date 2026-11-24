import type { Segment, SegmentRole } from './types';
import { type Ctx, type Reader, fmtBytes, fmtChannels, fmtDuration, fmtRate, pushMerged, restUnknown, seg, utf8 } from './util';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  Void: 0xec,
  CRC32: 0xbf,
} as const;

const LEVEL1 = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);
const NAMES = new Map<number, [string, SegmentRole]>([
  [ID.EBML, ['EBML', 'header']],
  [ID.Segment, ['Segment', 'container']],
  [ID.SeekHead, ['SeekHead', 'index']],
  [ID.Info, ['Info', 'header']],
  [ID.Tracks, ['Tracks', 'header']],
  [ID.Cluster, ['Cluster', 'samples']],
  [ID.Cues, ['Cues', 'index']],
  [ID.Tags, ['Tags', 'metadata']],
  [ID.Chapters, ['Chapters', 'metadata']],
  [ID.Attachments, ['Attachments', 'media']],
  [ID.Void, ['Void', 'padding']],
  [ID.CRC32, ['CRC-32', 'header']],
]);

const CODECS: Record<string, string> = {
  V_VP8: 'VP8',
  V_VP9: 'VP9',
  V_AV1: 'AV1',
  'V_MPEG4/ISO/AVC': 'H.264',
  'V_MPEGH/ISO/HEVC': 'HEVC',
  V_MPEG4: 'MPEG-4',
  A_OPUS: 'Opus',
  A_VORBIS: 'Vorbis',
  A_AAC: 'AAC',
  A_FLAC: 'FLAC',
  A_AC3: 'AC-3',
  'A_MPEG/L3': 'MP3',
  A_PCM: 'PCM',
  'S_TEXT/UTF8': 'SubRip text',
  'S_TEXT/WEBVTT': 'WebVTT',
  S_TEXT_ASS: 'ASS',
};

interface Hdr {
  id: number;
  idLen: number;
  /** Payload size; -1 when the size is "unknown". */
  size: number;
  hdr: number;
}

function parseHeader(b: Uint8Array, o: number): Hdr | undefined {
  const first = b[o];
  if (first === undefined || first === 0) return undefined;
  const idLen = Math.clz32(first) - 24 + 1;
  if (idLen > 4 || o + idLen >= b.length) return undefined;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + (b[o + i] ?? 0);
  const s0 = b[o + idLen];
  if (s0 === undefined || s0 === 0) return undefined;
  const sLen = Math.clz32(s0) - 24 + 1;
  if (o + idLen + sLen > b.length) return undefined;
  let size = s0 & (0xff >> sLen);
  let allOnes = size === (0xff >> sLen);
  for (let i = 1; i < sLen; i++) {
    const v = b[o + idLen + i] ?? 0;
    if (v !== 0xff) allOnes = false;
    size = size * 256 + v;
  }
  if (allOnes) size = -1;
  if (size > Number.MAX_SAFE_INTEGER) return undefined;
  return { id, idLen, size, hdr: idLen + sLen };
}

async function readHeader(r: Reader, pos: number): Promise<Hdr | undefined> {
  const b = await r.read(pos, 12);
  return parseHeader(b, 0);
}

function readUint(b: Uint8Array, o: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + (b[o + i] ?? 0);
  return v;
}

function readFloat(b: Uint8Array, o: number, n: number): number {
  if (n === 4) return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0);
  if (n === 8) return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0);
  return 0;
}

/** Iterate the direct children of an in-memory master element. */
function children(b: Uint8Array, start: number, end: number, cb: (id: number, dataStart: number, dataLen: number, elemStart: number) => void): void {
  let o = start;
  let guard = 0;
  while (o < end && guard++ < 10_000) {
    const h = parseHeader(b, o);
    if (!h) return;
    const dataStart = o + h.hdr;
    const len = h.size < 0 ? end - dataStart : Math.min(h.size, end - dataStart);
    cb(h.id, dataStart, len, o);
    o = dataStart + Math.max(0, len);
  }
}

interface TrackInfo {
  num?: number;
  type?: number;
  codec?: string;
  lang?: string;
  w?: number;
  h?: number;
  rate?: number;
  channels?: number;
  bits?: number;
  fps?: number;
}

function parseTrackEntry(b: Uint8Array, start: number, end: number): TrackInfo {
  const t: TrackInfo = {};
  children(b, start, end, (id, o, n) => {
    switch (id) {
      case 0xd7:
        t.num = readUint(b, o, n);
        break;
      case 0x83:
        t.type = readUint(b, o, n);
        break;
      case 0x86:
        t.codec = utf8(b.subarray(o, o + n)).replace(/\0+$/, '');
        break;
      case 0x22b59c:
        t.lang = utf8(b.subarray(o, o + n)).replace(/\0+$/, '');
        break;
      case 0x23e383: {
        const ns = readUint(b, o, n);
        if (ns > 0) t.fps = 1e9 / ns;
        break;
      }
      case 0xe0:
        children(b, o, o + n, (cid, co, cn) => {
          if (cid === 0xb0) t.w = readUint(b, co, cn);
          else if (cid === 0xba) t.h = readUint(b, co, cn);
        });
        break;
      case 0xe1:
        children(b, o, o + n, (cid, co, cn) => {
          if (cid === 0xb5) t.rate = Math.round(readFloat(b, co, cn));
          else if (cid === 0x9f) t.channels = readUint(b, co, cn);
          else if (cid === 0x6264) t.bits = readUint(b, co, cn);
        });
        break;
      default:
        break;
    }
  });
  return t;
}

function trackDetail(t: TrackInfo): string {
  const kind = t.type === 1 ? 'video' : t.type === 2 ? 'audio' : t.type === 17 ? 'subtitles' : `type ${t.type ?? '?'}`;
  const p = [`track ${t.num ?? '?'} · ${kind}`, `${t.codec ?? '?'}${t.codec && CODECS[t.codec] ? ` (${CODECS[t.codec]})` : ''}`];
  if (t.w && t.h) p.push(`${t.w}×${t.h}`);
  if (t.fps) p.push(`${+t.fps.toFixed(2)} fps`);
  if (t.rate) p.push(`${fmtRate(t.rate)} ${fmtChannels(t.channels ?? 0)}${t.bits ? ` ${t.bits}-bit` : ''}`);
  if (t.lang && t.lang !== 'und') p.push(t.lang);
  return p.join(' · ');
}

export async function parseEbml(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const first = await readHeader(r, 0);
  if (!first || first.id !== ID.EBML || first.size < 0) return;

  let docType = '';
  let docVersion = 0;
  let timecodeScale = 1_000_000;
  let durationSec = 0;
  let muxer = '';
  const tracks: TrackInfo[] = [];
  let clusterCount = 0;

  // EBML header
  const ebmlLen = Math.min(first.hdr + first.size, size);
  {
    const body = await r.read(first.hdr, Math.min(first.size, 256));
    children(body, 0, body.length, (id, o, n) => {
      if (id === 0x4282) docType = utf8(body.subarray(o, o + n)).replace(/\0+$/, '');
      else if (id === 0x4287) docVersion = readUint(body, o, n);
    });
    out.push(seg('EBML', 'header', 0, ebmlLen, `DocType ${docType || '?'}${docVersion ? ` v${docVersion}` : ''}`));
  }

  let pos = ebmlLen;
  let guard = 0;
  while (pos < size && guard++ < 1000) {
    const h = await readHeader(r, pos);
    if (!h) break;
    if (h.id !== ID.Segment) {
      const total = h.size < 0 ? size - pos : Math.min(h.hdr + h.size, size - pos);
      out.push(seg(NAMES.get(h.id)?.[0] ?? `0x${h.id.toString(16)}`, NAMES.get(h.id)?.[1] ?? 'unknown', pos, total));
      pos += total;
      continue;
    }
    const segEnd = h.size < 0 ? size : Math.min(size, pos + h.hdr + h.size);
    const kids: Segment[] = [];
    let p = pos + h.hdr;
    let inner = 0;
    while (p < segEnd && inner++ < 200_000) {
      if (r.truncated) {
        ctx.truncated = true;
        break;
      }
      const e = await readHeader(r, p);
      if (!e) break;
      const info = NAMES.get(e.id);
      const name = info?.[0] ?? `0x${e.id.toString(16).toUpperCase()}`;
      const role = info?.[1] ?? 'unknown';
      let total: number;
      if (e.size < 0) {
        if (e.id === ID.Cluster) {
          // Unknown-size cluster (live streams): ends where the next level-1 element starts.
          let q = p + e.hdr;
          let n = 0;
          total = segEnd - p;
          while (q < segEnd && n++ < 50_000) {
            const c = await readHeader(r, q);
            if (!c) break;
            if (LEVEL1.has(c.id)) {
              total = q - p;
              break;
            }
            if (c.size < 0) break;
            q += c.hdr + c.size;
          }
        } else total = segEnd - p;
      } else total = Math.min(e.hdr + e.size, segEnd - p);
      if (total < e.hdr) total = Math.min(e.hdr, segEnd - p);
      let detail: string | undefined;
      let sub: Segment[] | undefined;
      const dataLen = total - e.hdr;
      if (e.id === ID.Info && dataLen > 0 && dataLen <= 65536) {
        const b = await r.read(p + e.hdr, dataLen);
        const bits: string[] = [];
        children(b, 0, b.length, (id, o, n) => {
          if (id === 0x2ad7b1) timecodeScale = readUint(b, o, n) || timecodeScale;
          else if (id === 0x4489) durationSec = readFloat(b, o, n);
          else if (id === 0x4d80) muxer = utf8(b.subarray(o, o + n)).replace(/\0+$/, '');
        });
        durationSec = (durationSec * timecodeScale) / 1e9;
        if (durationSec) bits.push(`duration ${fmtDuration(durationSec)}`);
        if (muxer) bits.push(`muxer ${muxer}`);
        detail = bits.join(' · ') || undefined;
      } else if (e.id === ID.Tracks && dataLen > 0 && dataLen <= 1 << 20) {
        const b = await r.read(p + e.hdr, dataLen);
        sub = [];
        children(b, 0, b.length, (id, o, n, es) => {
          if (id !== 0xae) return;
          const t = parseTrackEntry(b, o, o + n);
          tracks.push(t);
          sub!.push(seg('TrackEntry', 'header', p + e.hdr + es, o - es + n, trackDetail(t)));
        });
        detail = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
      } else if (e.id === ID.SeekHead && dataLen > 0 && dataLen <= 4096) {
        const b = await r.read(p + e.hdr, dataLen);
        const names: string[] = [];
        children(b, 0, b.length, (id, o, n) => {
          if (id !== 0x4dbb) return;
          children(b, o, o + n, (cid, co, cn) => {
            if (cid === 0x53ab) {
              const target = readUint(b, co, cn);
              names.push(NAMES.get(target)?.[0] ?? `0x${target.toString(16)}`);
            }
          });
        });
        detail = names.length ? `${names.length} entries: ${names.join(', ')}` : undefined;
      } else if (e.id === ID.Cluster) {
        clusterCount++;
        detail = fmtBytes(dataLen);
      } else if (e.id === ID.Cues || e.id === ID.Tags || e.id === ID.Chapters || e.id === ID.Attachments) {
        detail = fmtBytes(dataLen);
      }
      pushMerged(kids, seg(name, role, p, total, detail, { children: sub }));
      p += total;
    }
    for (const k of kids) if (k.name === 'Cluster' && k.count && k.count > 1) k.detail = `${k.count.toLocaleString('en-US')} clusters · ${fmtBytes(k.length)}`;
    out.push(seg('Segment', 'container', pos, segEnd - pos, `${kids.length} top-level element${kids.length === 1 ? '' : 's'}`, { children: kids }));
    pos = segEnd;
  }
  if (pos < size) restUnknown(ctx, pos);

  const parts: string[] = [];
  for (const t of tracks) {
    const c = t.codec ? (CODECS[t.codec] ?? t.codec) : '?';
    if (t.type === 1) parts.push(`${c} ${t.w ?? '?'}×${t.h ?? '?'}`);
    else if (t.type === 2) parts.push(`${c} ${fmtRate(t.rate ?? 0)} ${fmtChannels(t.channels ?? 0)}`);
  }
  if (durationSec) parts.push(fmtDuration(durationSec));
  if (clusterCount) parts.push(`${clusterCount.toLocaleString('en-US')} cluster${clusterCount === 1 ? '' : 's'}`);
  ctx.summary = `${docType === 'webm' ? 'WebM' : docType === 'matroska' ? 'Matroska' : (ctx.format === 'webm' ? 'WebM' : 'Matroska')}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
}
