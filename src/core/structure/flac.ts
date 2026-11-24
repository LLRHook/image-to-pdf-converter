import type { Segment, SegmentRole } from './types';
import { type Ctx, cleanText, fmtBytes, fmtChannels, fmtDuration, fmtRate, latin1, matchAscii, restUnknown, seg, u24be, u32be, u32le } from './util';
import { id3v2Length } from './mp3';

const BLOCKS: Record<number, [string, SegmentRole]> = {
  0: ['STREAMINFO', 'header'],
  1: ['PADDING', 'padding'],
  2: ['APPLICATION', 'metadata'],
  3: ['SEEKTABLE', 'index'],
  4: ['VORBIS_COMMENT', 'metadata'],
  5: ['CUESHEET', 'index'],
  6: ['PICTURE', 'media'],
};

export async function parseFlac(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  let pos = 0;
  const tag = await id3v2Length(r, 0);
  if (tag > 0) {
    out.push(seg('ID3v2', 'metadata', 0, tag, 'tag before stream'));
    pos = tag;
  }
  const sig = await r.read(pos, 4);
  if (!matchAscii(sig, 0, 'fLaC')) return;
  out.push(seg('fLaC', 'signature', pos, 4));
  pos += 4;
  let rate = 0;
  let channels = 0;
  let bps = 0;
  let total = 0;
  let minBlock = 0;
  let maxBlock = 0;
  let last = false;
  let guard = 0;
  const blocks: Segment[] = [];
  while (!last && pos + 4 <= size && guard++ < 1000) {
    const h = await r.read(pos, 4);
    if (h.length < 4) break;
    last = ((h[0] ?? 0) & 0x80) !== 0;
    const type = (h[0] ?? 0) & 0x7f;
    const len = u24be(h, 1);
    let blockTotal = 4 + len;
    let detail: string | undefined;
    if (pos + blockTotal > size) blockTotal = size - pos;
    if (type === 127) break;
    if (type === 0 && len >= 34) {
      const d = await r.read(pos + 4, 34);
      minBlock = ((d[0] ?? 0) << 8) | (d[1] ?? 0);
      maxBlock = ((d[2] ?? 0) << 8) | (d[3] ?? 0);
      rate = ((d[10] ?? 0) << 12) | ((d[11] ?? 0) << 4) | ((d[12] ?? 0) >> 4);
      channels = (((d[12] ?? 0) >> 1) & 7) + 1;
      bps = ((((d[12] ?? 0) & 1) << 4) | ((d[13] ?? 0) >> 4)) + 1;
      total = ((d[13] ?? 0) & 0xf) * 4294967296 + u32be(d, 14);
      detail = `${fmtRate(rate)} · ${fmtChannels(channels)} · ${bps}-bit · ${total.toLocaleString('en-US')} samples${rate ? ` · ${fmtDuration(total / rate)}` : ''}`;
    } else if (type === 4) {
      const d = await r.read(pos + 4, Math.min(len, 256));
      const vlen = u32le(d, 0);
      const vendor = cleanText(latin1(d.subarray(4, 4 + Math.min(vlen, 60))), 40);
      const n = u32le(d, 4 + vlen);
      detail = `${vendor ? vendor + ' · ' : ''}${Number.isFinite(n) && vlen < d.length ? n + ' comments' : ''}`.replace(/ · $/, '');
    } else if (type === 3) {
      detail = `${Math.floor(len / 18)} seek points`;
    } else if (type === 2) {
      const d = await r.read(pos + 4, 4);
      detail = `application ${cleanText(latin1(d), 4)}`;
    } else if (type === 6) {
      const d = await r.read(pos + 4, 64);
      const mimeLen = u32be(d, 4);
      detail = `cover picture · ${mimeLen < 40 ? latin1(d.subarray(8, 8 + mimeLen)) : 'image'} · ${fmtBytes(len)}`;
    }
    const [name, role] = BLOCKS[type] ?? [`block ${type}`, 'unknown' as SegmentRole];
    blocks.push(seg(name, role, pos, blockTotal, detail));
    pos += blockTotal;
    if (blockTotal < 4 + len) break;
  }
  out.push(...blocks);
  if (pos < size) {
    const f = await r.read(pos, 2);
    const synced = f.length === 2 && f[0] === 0xff && ((f[1] ?? 0) & 0xfe) === 0xf8;
    if (synced) {
      const fixed = minBlock > 0 && minBlock === maxBlock;
      const count = fixed && total > 0 ? Math.ceil(total / maxBlock) : undefined;
      const pcm = total * channels * (bps / 8);
      out.push(
        seg(
          'frames',
          'samples',
          pos,
          size - pos,
          `${count ? `${count.toLocaleString('en-US')} frames · ` : 'variable block size · '}${fmtBytes(size - pos)}${pcm ? ` (${Math.round(((size - pos) / pcm) * 100)}% of PCM)` : ''}`,
          { count },
        ),
      );
    } else restUnknown(ctx, pos, 'unrecognised audio data');
  }
  ctx.summary = rate ? `FLAC ${fmtRate(rate)} ${fmtChannels(channels)} ${bps}-bit · ${fmtDuration(total / rate)}${tag ? ' · ID3v2 prefix' : ''}` : 'FLAC · no STREAMINFO';
}
