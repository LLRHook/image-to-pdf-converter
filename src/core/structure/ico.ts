import { type Ctx, fmtBytes, matchAscii, restUnknown, seg, u16le, u32le } from './util';
import type { Segment } from './types';

export async function parseIco(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const h = await r.read(0, 6);
  if (h.length < 6 || u16le(h, 0) !== 0 || ![1, 2].includes(u16le(h, 2))) return;
  const isCur = u16le(h, 2) === 2;
  const count = u16le(h, 4);
  out.push(seg('ICONDIR', 'signature', 0, 6, `${count} ${isCur ? 'cursor' : 'icon'} image${count === 1 ? '' : 's'}`));
  const dirLen = Math.min(count * 16, Math.max(0, size - 6));
  const dir = await r.read(6, dirLen);
  const entries = Math.floor(dir.length / 16);
  if (entries > 0) out.push(seg('ICONDIRENTRY', 'index', 6, entries * 16, `${entries} directory entries`, { count: entries }));
  const images: Segment[] = [];
  const sizes: string[] = [];
  for (let i = 0; i < entries; i++) {
    const o = i * 16;
    const w = dir[o] || 256;
    const hh = dir[o + 1] || 256;
    const bpp = u16le(dir, o + 6);
    const len = u32le(dir, o + 8);
    const off = u32le(dir, o + 12);
    if (off >= size || len === 0) continue;
    const head = await r.read(off, 8);
    const kind = head.length >= 8 && head[0] === 0x89 && matchAscii(head, 1, 'PNG') ? 'PNG' : 'BMP/DIB';
    sizes.push(`${w}×${hh}`);
    images.push(seg(`image ${w}×${hh}`, 'pixels', off, Math.min(len, size - off), `${kind} · ${bpp || '?'} bpp · ${fmtBytes(len)}`));
  }
  images.sort((a, b) => a.offset - b.offset);
  out.push(...images);
  const end = images.reduce((m, s) => Math.max(m, s.offset + s.length), 6 + entries * 16);
  if (end < size) restUnknown(ctx, end);
  ctx.summary = `${isCur ? 'CUR' : 'ICO'} · ${entries} image${entries === 1 ? '' : 's'}${sizes.length ? ': ' + sizes.join(', ') : ''}`;
}
