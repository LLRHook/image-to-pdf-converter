import type { SegmentRole } from './types';
import { type Ctx, fmtBytes, fmtChannels, fmtDuration, fmtRate, matchAscii, pushMerged, restUnknown, seg, u16le, u32le, u64le } from './util';

interface Stream {
  serial: number;
  index: number;
  codec: string;
  rate: number;
  channels: number;
  preskip: number;
  pages: number;
  lastGranule: number;
}

function identify(d: Uint8Array): { codec: string; rate: number; channels: number; preskip: number } {
  if (d[0] === 0x01 && matchAscii(d, 1, 'vorbis')) return { codec: 'Vorbis', channels: d[11] ?? 0, rate: u32le(d, 12), preskip: 0 };
  if (matchAscii(d, 0, 'OpusHead')) return { codec: 'Opus', channels: d[9] ?? 0, rate: 48000, preskip: u16le(d, 10) };
  if (d[0] === 0x7f && matchAscii(d, 1, 'FLAC')) return { codec: 'FLAC', channels: 0, rate: 0, preskip: 0 };
  if (d[0] === 0x80 && matchAscii(d, 1, 'theora')) return { codec: 'Theora', channels: 0, rate: 0, preskip: 0 };
  if (matchAscii(d, 0, 'Speex   ')) return { codec: 'Speex', channels: u32le(d, 48), rate: u32le(d, 36), preskip: 0 };
  if (matchAscii(d, 0, 'fishead')) return { codec: 'Skeleton', channels: 0, rate: 0, preskip: 0 };
  return { codec: 'unknown', channels: 0, rate: 0, preskip: 0 };
}

const MAX_PAGES = 4000;

export async function parseOgg(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const streams = new Map<number, Stream>();
  let pos = 0;
  let pages = 0;
  while (pos + 27 <= size && pages < MAX_PAGES) {
    const h = await r.read(pos, 27 + 255);
    if (h.length < 27 || !matchAscii(h, 0, 'OggS')) break;
    const flags = h[5] ?? 0;
    const granule = u64le(h, 6);
    const serial = u32le(h, 14);
    const seq = u32le(h, 18);
    const nseg = h[26] ?? 0;
    if (h.length < 27 + nseg) break;
    let body = 0;
    for (let i = 0; i < nseg; i++) body += h[27 + i] ?? 0;
    let total = 27 + nseg + body;
    let clipped = false;
    if (pos + total > size) {
      total = size - pos;
      clipped = true;
    }
    pages++;
    let st = streams.get(serial);
    if (!st) {
      st = { serial, index: streams.size + 1, codec: 'unknown', rate: 0, channels: 0, preskip: 0, pages: 0, lastGranule: 0 };
      streams.set(serial, st);
    }
    st.pages++;
    let name = 'page';
    let role: SegmentRole = 'samples';
    let detail: string | undefined;
    const first = await r.read(pos + 27 + nseg, Math.min(body, 64));
    if (flags & 0x02) {
      const id = identify(first);
      st.codec = id.codec;
      st.rate = id.rate;
      st.channels = id.channels;
      st.preskip = id.preskip;
      name = `${id.codec} identification header`;
      role = 'header';
      detail = id.rate ? `${id.codec} · ${fmtRate(id.rate)} · ${fmtChannels(id.channels)}` : id.codec;
    } else if (seq <= 2 && (matchAscii(first, 0, 'OpusTags') || (first[0] === 0x03 && matchAscii(first, 1, 'vorbis')))) {
      name = `${st.codec} comment header`;
      role = 'metadata';
    } else if (seq <= 2 && first[0] === 0x05 && matchAscii(first, 1, 'vorbis')) {
      name = 'Vorbis setup header';
      role = 'header';
    } else if (seq <= 1 && st.codec === 'FLAC') {
      name = 'FLAC header';
      role = 'header';
    } else {
      name = `${st.codec} pages`;
    }
    if (st.index > 1) name += ` (stream ${st.index})`;
    if (granule !== Infinity && granule < 2 ** 52) st.lastGranule = Math.max(st.lastGranule, granule);
    pushMerged(out, seg(name, role, pos, total, detail));
    pos += total;
    if (clipped) break;
    if (flags & 0x04) {
      // EOS: keep going — chained streams follow.
    }
  }
  for (const s of out) if (s.count && s.count > 1 && /pages( \(stream \d+\))?$/.test(s.name)) s.detail = `${s.count.toLocaleString('en-US')} pages · ${fmtBytes(s.length)}`;

  if (pos < size && pages >= MAX_PAGES) {
    // Too many pages to walk: describe the remainder as one run and read the final page for the duration.
    ctx.truncated = true;
    const tail = await r.readReserved(Math.max(0, size - 65536), 65536);
    let at = -1;
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && matchAscii(tail, i, 'OggS')) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      const serial = u32le(tail, at + 14);
      const g = u64le(tail, at + 6);
      const st = streams.get(serial);
      if (st && g < 2 ** 52) st.lastGranule = Math.max(st.lastGranule, g);
    }
    const lastStream = [...streams.values()][streams.size - 1];
    out.push(seg(`${lastStream?.codec ?? 'Ogg'} pages`, 'samples', pos, size - pos, `remaining pages not walked · ${fmtBytes(size - pos)}`));
  } else if (pos < size) {
    restUnknown(ctx, pos);
  }

  const list = [...streams.values()];
  if (list.length === 0) return;
  const parts = list.map((s) => {
    const secs = s.rate ? Math.max(0, s.lastGranule - s.preskip) / s.rate : 0;
    return `${s.codec}${s.rate ? ` ${fmtRate(s.rate)} ${fmtChannels(s.channels)}` : ''}${secs ? ` · ${fmtDuration(secs)}` : ''}`;
  });
  ctx.summary = `Ogg · ${parts.join(' + ')} · ${pages.toLocaleString('en-US')} page${pages === 1 ? '' : 's'}${pos < size && pages >= MAX_PAGES ? '+' : ''}`;
}
