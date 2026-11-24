import type { Segment } from './types';
import { type Ctx, type Reader, cleanText, fmtBytes, fmtChannels, fmtDuration, fmtRate, latin1, matchAscii, pushUnknown, restUnknown, seg, u32be, u32le, utf8 } from './util';

const BR_V1 = [
  [], // layer 0 invalid
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // index 1 → Layer I
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // Layer II
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // Layer III
];
const BR_V2 = [
  [],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const SR = [
  [11025, 12000, 8000], // MPEG 2.5
  [],
  [22050, 24000, 16000], // MPEG 2
  [44100, 48000, 32000], // MPEG 1
];

export interface MpegFrame {
  version: number; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  layer: number; // 1..3 (Layer I..III)
  bitrate: number; // kbps
  rate: number;
  channels: number;
  length: number;
  samples: number;
}

export function parseMpegHeader(b: Uint8Array, o: number): MpegFrame | undefined {
  if ((b[o] ?? 0) !== 0xff || ((b[o + 1] ?? 0) & 0xe0) !== 0xe0) return undefined;
  const version = ((b[o + 1] ?? 0) >> 3) & 3;
  const layerBits = ((b[o + 1] ?? 0) >> 1) & 3;
  if (version === 1 || layerBits === 0) return undefined;
  const layer = 4 - layerBits; // bits 3→Layer I
  const brIdx = (b[o + 2] ?? 0) >> 4;
  const srIdx = ((b[o + 2] ?? 0) >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return undefined;
  const table = (version === 3 ? BR_V1 : BR_V2)[layer];
  const bitrate = table?.[brIdx] ?? 0;
  const rate = SR[version]?.[srIdx] ?? 0;
  if (!bitrate || !rate) return undefined;
  const pad = ((b[o + 2] ?? 0) >> 1) & 1;
  const channels = ((b[o + 3] ?? 0) >> 6) === 3 ? 1 : 2;
  let length: number;
  let samples: number;
  if (layer === 1) {
    length = (Math.floor((12 * bitrate * 1000) / rate) + pad) * 4;
    samples = 384;
  } else if (layer === 2 || version === 3) {
    length = Math.floor((144 * bitrate * 1000) / rate) + pad;
    samples = 1152;
  } else {
    length = Math.floor((72 * bitrate * 1000) / rate) + pad;
    samples = 576;
  }
  return { version, layer, bitrate, rate, channels, length, samples };
}

/** Size of a leading ID3v2 tag (0 if absent). */
export async function id3v2Length(r: Reader, pos = 0): Promise<number> {
  const h = await r.read(pos, 10);
  if (h.length < 10 || !matchAscii(h, 0, 'ID3')) return 0;
  const ss = ((h[6] ?? 0) & 0x7f) * 2097152 + ((h[7] ?? 0) & 0x7f) * 16384 + ((h[8] ?? 0) & 0x7f) * 128 + ((h[9] ?? 0) & 0x7f);
  const footer = (h[3] ?? 0) >= 4 && ((h[5] ?? 0) & 0x10) ? 10 : 0;
  return Math.min(r.size - pos, 10 + ss + footer);
}

function decodeText(enc: number, b: Uint8Array): string {
  try {
    if (enc === 1 || enc === 2) {
      const le = enc === 1 ? !(b[0] === 0xfe && b[1] === 0xff) : false;
      const start = enc === 1 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) ? 2 : 0;
      return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(b.subarray(start));
    }
    return enc === 3 ? utf8(b) : latin1(b);
  } catch {
    return '';
  }
}

async function id3Frames(r: Reader, pos: number, tagLen: number): Promise<{ frames: Segment[]; version: string }> {
  const h = await r.read(pos, 10);
  const major = h[3] ?? 3;
  const flags = h[5] ?? 0;
  const end = pos + tagLen;
  let p = pos + 10;
  const frames: Segment[] = [];
  if (flags & 0x40 && major >= 3) {
    const ext = await r.read(p, 6);
    const extLen = major === 4 ? ((ext[0] ?? 0) & 0x7f) * 2097152 + ((ext[1] ?? 0) & 0x7f) * 16384 + ((ext[2] ?? 0) & 0x7f) * 128 + ((ext[3] ?? 0) & 0x7f) : u32be(ext, 0) + 4;
    p += Math.max(0, extLen);
  }
  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;
  let guard = 0;
  while (p + hdrLen <= end && guard++ < 5000) {
    const fh = await r.read(p, hdrLen);
    if (fh.length < hdrLen || (fh[0] ?? 0) === 0) break;
    const id = latin1(fh.subarray(0, idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let size: number;
    if (major === 2) size = ((fh[3] ?? 0) << 16) | ((fh[4] ?? 0) << 8) | (fh[5] ?? 0);
    else if (major === 4) size = ((fh[4] ?? 0) & 0x7f) * 2097152 + ((fh[5] ?? 0) & 0x7f) * 16384 + ((fh[6] ?? 0) & 0x7f) * 128 + ((fh[7] ?? 0) & 0x7f);
    else size = u32be(fh, 4);
    const total = hdrLen + size;
    if (p + total > end) break;
    let detail: string | undefined;
    let role: 'metadata' | 'media' = 'metadata';
    if (id[0] === 'T' && id !== 'TXXX' && size > 1) {
      const d = await r.read(p + hdrLen, Math.min(size, 120));
      detail = cleanText(decodeText(d[0] ?? 0, d.subarray(1)), 48);
    } else if (id === 'TXXX' && size > 1) {
      const d = await r.read(p + hdrLen, Math.min(size, 120));
      detail = cleanText(decodeText(d[0] ?? 0, d.subarray(1)).replace(/\0+/g, ' = '), 48);
    } else if (id === 'APIC' || id === 'PIC') {
      role = 'media';
      const d = await r.read(p + hdrLen, Math.min(size, 64));
      const nul = d.indexOf(0, 1);
      detail = `cover art${nul > 1 ? ` · ${latin1(d.subarray(1, nul))}` : ''} · ${fmtBytes(size)}`;
    } else if (id === 'COMM' || id === 'COM' || id === 'USLT') {
      detail = `${fmtBytes(size)} text`;
    }
    frames.push(seg(id, role, p, total, detail));
    p += total;
  }
  const major2 = `2.${major}.${h[4] ?? 0}`;
  if (p < end) frames.push(seg('padding', 'padding', p, end - p));
  return { frames, version: major2 };
}

export async function parseMp3(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  let pos = 0;
  let tagInfo = '';
  const tagLen = await id3v2Length(r, 0);
  if (tagLen > 0) {
    const { frames, version } = await id3Frames(r, 0, tagLen);
    const real = frames.filter((f) => f.role !== 'padding').length;
    out.push(seg(`ID3v${version}`, 'metadata', 0, tagLen, `${real} frame${real === 1 ? '' : 's'}`, { children: frames }));
    pos = tagLen;
    tagInfo = ` · ID3v${version}`;
  }

  // Find the first frame (skip junk/zero padding), requiring a second valid header after it.
  const scan = await r.read(pos, 65536);
  let first = -1;
  let f0: MpegFrame | undefined;
  for (let i = 0; i + 4 <= scan.length; i++) {
    if (scan[i] !== 0xff) continue;
    const f = parseMpegHeader(scan, i);
    if (!f) continue;
    const next = i + f.length;
    if (next + 4 <= size) {
      const nb = await r.read(pos + next, 4);
      if (!parseMpegHeader(nb, 0)) continue;
    }
    first = pos + i;
    f0 = f;
    break;
  }
  if (first < 0 || !f0) {
    restUnknown(ctx, pos, 'no MPEG audio frames found');
    return;
  }
  if (first > pos) out.push(seg('junk before audio', 'padding', pos, first - pos));
  pos = first;

  // Trailers.
  let audioEnd = size;
  const trailers: Segment[] = [];
  const tail = await r.read(Math.max(0, size - 160), 160);
  const hasV1 = tail.length >= 128 && matchAscii(tail, tail.length - 128, 'TAG');
  if (hasV1) {
    audioEnd = size - 128;
    trailers.push(seg('ID3v1', 'metadata', audioEnd, 128, `${cleanText(latin1(tail.subarray(tail.length - 125, tail.length - 95)), 30)}`));
  }
  const apeAt = audioEnd - 32;
  if (apeAt > pos) {
    const ape = await r.read(apeAt, 32);
    if (matchAscii(ape, 0, 'APETAGEX')) {
      const tagSize = u32le(ape, 12);
      const hasHeader = (u32le(ape, 20) & 0x80000000) !== 0;
      const total = tagSize + (hasHeader ? 32 : 0);
      if (total <= audioEnd - pos) {
        audioEnd -= total;
        trailers.unshift(seg('APEv2', 'metadata', audioEnd, total, `${u32le(ape, 16)} items`));
      }
    }
  }

  // Xing / Info / VBRI header inside the first frame.
  let xingFrames = 0;
  let encoder = '';
  const fb = await r.read(pos, Math.min(f0.length, 512));
  const sideInfo = f0.version === 3 ? (f0.channels === 1 ? 17 : 32) : f0.channels === 1 ? 9 : 17;
  const xo = 4 + sideInfo;
  let xingKind = '';
  if (matchAscii(fb, xo, 'Xing') || matchAscii(fb, xo, 'Info')) {
    xingKind = latin1(fb.subarray(xo, xo + 4));
    const flags = u32be(fb, xo + 4);
    if (flags & 1) xingFrames = u32be(fb, xo + 8);
    const lame = latin1(fb).indexOf('LAME');
    const lavf = latin1(fb).search(/Lav[cf]/);
    const at = lame >= 0 ? lame : lavf;
    if (at >= 0) encoder = cleanText(latin1(fb.subarray(at, at + 9)), 9);
  } else if (matchAscii(fb, 36, 'VBRI')) {
    xingKind = 'VBRI';
    xingFrames = u32be(fb, 50);
  }
  let audioStart = pos;
  if (xingKind) {
    out.push(seg(xingKind === 'Info' ? 'Info header' : `${xingKind} header`, 'index', pos, f0.length, `${xingKind === 'Info' ? 'CBR' : 'VBR'} header${xingFrames ? ` · ${xingFrames.toLocaleString('en-US')} frames` : ''}${encoder ? ` · ${encoder}` : ''}`));
    audioStart = pos + f0.length;
  }

  // Walk frames from the first real audio frame to establish the stream, up to a cap.
  let p = audioStart;
  let frames = 0;
  let samples = 0;
  const bitrates = new Set<number>();
  let lastGood = p;
  let broke = false;
  let a0: MpegFrame | undefined;
  while (p + 4 <= audioEnd && frames < 4000) {
    const b = await r.read(p, 4);
    const f = parseMpegHeader(b, 0);
    if (!f || f.rate !== f0.rate || f.layer !== f0.layer) {
      broke = true;
      break;
    }
    a0 ??= f;
    bitrates.add(f.bitrate);
    frames++;
    samples += f.samples;
    p += f.length;
    lastGood = p;
    if (p > audioEnd) {
      lastGood = audioEnd;
      break;
    }
  }
  const walkedAll = !broke && lastGood >= audioEnd - 4;
  let count = frames;
  let regionEnd = Math.min(lastGood, audioEnd);
  let est = false;
  if (!walkedAll && !broke && frames >= 4000) {
    // Sampled the head; extrapolate to the trailer boundary.
    est = true;
    regionEnd = audioEnd;
    const avg = (lastGood - audioStart) / frames;
    count = xingFrames || Math.round((audioEnd - audioStart) / avg);
    samples = count * (a0?.samples ?? f0.samples);
    ctx.truncated = false;
  } else if (xingFrames && walkedAll) count = xingFrames;
  if (broke && frames < 3) {
    restUnknown(ctx, audioStart, 'unrecognised audio data');
    return;
  }
  if (regionEnd > audioStart) {
    const brText = bitrates.size === 1 ? `CBR ${[...bitrates][0]} kbps` : `VBR ${Math.min(...bitrates)}–${Math.max(...bitrates)} kbps`;
    const seconds = samples / f0.rate;
    out.push(
      seg('MPEG frames', 'samples', audioStart, regionEnd - audioStart, `${est ? '~' : ''}${count.toLocaleString('en-US')} frames · ${brText} · ${fmtRate(f0.rate)} ${fmtChannels(f0.channels)} · ${fmtDuration(seconds)}`, { count }),
    );
  }
  if (regionEnd < audioEnd) pushUnknown(out, regionEnd, audioEnd, 'unparsed audio data');
  out.push(...trailers);
  const layerName = ['', 'Layer I', 'Layer II', 'MP3'][f0.layer] ?? '';
  const brSummary = bitrates.size === 1 ? `${[...bitrates][0]} kbps` : `${Math.round(((regionEnd - audioStart) * 8) / Math.max(0.001, samples / f0.rate) / 1000)} kbps avg`;
  ctx.summary = `MPEG ${f0.version === 3 ? '1' : f0.version === 2 ? '2' : '2.5'} ${layerName} · ${brSummary} · ${fmtRate(f0.rate)} ${fmtChannels(f0.channels)} · ${fmtDuration(samples / f0.rate)}${tagInfo}`;
}

// ------------------------------------------------------------------ ADTS (raw AAC)

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export function isAdts(b: Uint8Array, o: number): boolean {
  return (b[o] ?? 0) === 0xff && ((b[o + 1] ?? 0) & 0xf6) === 0xf0 && ((b[o + 2] ?? 0) >> 2 & 15) < 13;
}

export async function parseAdts(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  let pos = 0;
  const tag = await id3v2Length(r, 0);
  if (tag > 0) {
    out.push(seg('ID3v2', 'metadata', 0, tag));
    pos = tag;
  }
  const h = await r.read(pos, 7);
  if (h.length < 7 || !isAdts(h, 0)) return;
  const rate = ADTS_RATES[((h[2] ?? 0) >> 2) & 15] ?? 0;
  const channels = (((h[2] ?? 0) & 1) << 2) | ((h[3] ?? 0) >> 6);
  const profile = (((h[2] ?? 0) >> 6) & 3) + 1;
  let p = pos;
  let frames = 0;
  while (p + 7 <= size && frames < 4000) {
    const b = await r.read(p, 7);
    if (b.length < 7 || !isAdts(b, 0)) break;
    const len = (((b[3] ?? 0) & 3) << 11) | ((b[4] ?? 0) << 3) | ((b[5] ?? 0) >> 5);
    if (len < 7) break;
    frames++;
    p += len;
  }
  let end = Math.min(p, size);
  let count = frames;
  let est = false;
  if (frames >= 4000 && end < size) {
    est = true;
    count = Math.round(((size - pos) / (end - pos)) * frames);
    end = size;
  }
  out.push(seg('ADTS frames', 'samples', pos, end - pos, `${est ? '~' : ''}${count.toLocaleString('en-US')} frames · AAC profile ${profile} · ${fmtRate(rate)} ${fmtChannels(channels)} · ${fmtDuration((count * 1024) / rate)}`, { count }));
  if (end < size) restUnknown(ctx, end);
  ctx.summary = `AAC (ADTS) ${fmtRate(rate)} ${fmtChannels(channels)} · ${count.toLocaleString('en-US')} frames · ${fmtDuration((count * 1024) / rate)}`;
}
