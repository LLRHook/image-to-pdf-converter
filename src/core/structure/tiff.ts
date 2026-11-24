import type { Segment } from './types';
import { type Ctx, fmtBytes, pushMerged, seg, u16be, u16le, u32be, u32le, u64be, u64le } from './util';

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];
const COMPRESSION: Record<number, string> = {
  1: 'uncompressed',
  2: 'CCITT RLE',
  3: 'CCITT G3',
  4: 'CCITT G4',
  5: 'LZW',
  6: 'old JPEG',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  32946: 'Deflate',
  34712: 'JPEG 2000',
  50000: 'ZSTD',
  50001: 'WebP',
};
const PHOTOMETRIC: Record<number, string> = { 0: 'white-is-zero', 1: 'black-is-zero', 2: 'RGB', 3: 'palette', 4: 'mask', 5: 'CMYK', 6: 'YCbCr', 8: 'CIELab' };

const MAX_IFDS = 64;
const MAX_VALUES = 20_000;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Absolute file offset of the value bytes, or -1 when stored inline in `inline`. */
  at: number;
  inline: Uint8Array;
  byteLen: number;
}

export async function parseTiff(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const h = await r.read(0, 16);
  if (h.length < 8) return;
  const le = h[0] === 0x49 && h[1] === 0x49;
  const be = h[0] === 0x4d && h[1] === 0x4d;
  if (!le && !be) return;
  const u16 = (b: Uint8Array, o: number) => (le ? u16le(b, o) : u16be(b, o));
  const u32 = (b: Uint8Array, o: number) => (le ? u32le(b, o) : u32be(b, o));
  const u64 = (b: Uint8Array, o: number) => (le ? u64le(b, o) : u64be(b, o));
  const version = u16(h, 2);
  const big = version === 43;
  if (version !== 42 && !big) return;
  const headerLen = big ? 16 : 8;
  const firstIfd = big ? u64(h, 8) : u32(h, 4);
  out.push(seg(big ? 'BigTIFF header' : 'TIFF header', 'signature', 0, headerLen, `${le ? 'little' : 'big'}-endian · first IFD at ${firstIfd}`));

  const entrySize = big ? 20 : 12;
  const inlineMax = big ? 8 : 4;
  const visited = new Set<number>();
  const queue: Array<{ off: number; name: string }> = [{ off: firstIfd, name: 'IFD0' }];
  const strips: Segment[] = [];
  const valueAreas: Segment[] = [];
  let ifdCount = 0;
  let pages = 0;
  let main: { w: number; h: number; bps: number; spp: number; comp: number; photo: number } | undefined;

  async function readNumbers(e: Entry, limit = MAX_VALUES): Promise<number[]> {
    const per = TYPE_SIZE[e.type] ?? 0;
    if (per === 0 || ![1, 3, 4, 8, 9, 16, 17, 13, 18].includes(e.type)) return [];
    const n = Math.min(e.count, limit);
    const data = e.at < 0 ? e.inline : await r.read(e.at, n * per);
    const res: number[] = [];
    for (let i = 0; i < n && (i + 1) * per <= data.length; i++) {
      const o = i * per;
      res.push(per === 1 ? (data[o] ?? 0) : per === 2 ? u16(data, o) : per === 4 ? u32(data, o) : u64(data, o));
    }
    return res;
  }

  let steps = 0;
  while (queue.length && ifdCount < MAX_IFDS && steps++ < 1000) {
    const { off, name } = queue.shift()!;
    if (!Number.isFinite(off) || off < headerLen || off + 2 > size || visited.has(off)) continue;
    visited.add(off);
    const cb = await r.read(off, big ? 8 : 2);
    const n = big ? u64(cb, 0) : u16(cb, 0);
    if (!Number.isFinite(n) || n === 0 || n > 65535) continue;
    const head = big ? 8 : 2;
    const body = await r.read(off + head, n * entrySize + inlineMax);
    if (body.length < n * entrySize) continue;
    ifdCount++;
    const tags = new Map<number, Entry>();
    for (let i = 0; i < n; i++) {
      const o = i * entrySize;
      const type = u16(body, o + 2);
      const count = big ? u64(body, o + 4) : u32(body, o + 4);
      const per = TYPE_SIZE[type] ?? 1;
      const byteLen = Number.isFinite(count) ? per * count : Infinity;
      const valOff = o + (big ? 12 : 8);
      const e: Entry = { tag: u16(body, o), type, count, at: -1, inline: body.subarray(valOff, valOff + inlineMax), byteLen };
      if (byteLen > inlineMax) e.at = big ? u64(body, valOff) : u32(body, valOff);
      tags.set(e.tag, e);
      if (e.at >= 0 && Number.isFinite(e.at) && Number.isFinite(byteLen) && e.at + byteLen <= size && e.at >= headerLen) {
        const known: Record<number, [string, 'metadata' | 'palette']> = {
          700: ['XMP packet', 'metadata'],
          34675: ['ICC profile', 'palette'],
          34377: ['Photoshop resources', 'metadata'],
          33723: ['IPTC-NAA', 'metadata'],
        };
        const k = known[e.tag];
        // Strip/tile arrays are described via the strip runs; everything else is tag payload.
        if (![273, 279, 324, 325].includes(e.tag)) {
          valueAreas.push(seg(k ? k[0] : 'tag values', k ? k[1] : 'metadata', e.at, byteLen, k ? fmtBytes(byteLen) : undefined));
        } else {
          valueAreas.push(seg('strip table', 'index', e.at, byteLen));
        }
      }
    }
    const next = await r.read(off + head + n * entrySize, inlineMax);
    const nextIfd = big ? u64(next, 0) : u32(next, 0);

    const num = async (tag: number): Promise<number | undefined> => {
      const e = tags.get(tag);
      return e ? (await readNumbers(e, 1))[0] : undefined;
    };
    const w = (await num(256)) ?? 0;
    const ht = (await num(257)) ?? 0;
    const comp = (await num(259)) ?? 1;
    const photo = (await num(262)) ?? -1;
    const spp = (await num(277)) ?? 1;
    const bpsE = tags.get(258);
    const bps = bpsE ? ((await readNumbers(bpsE, 1))[0] ?? 0) : 1;
    const sub = name === 'IFD0' || name.startsWith('IFD');
    if (sub && w && !main) main = { w, h: ht, bps, spp, comp, photo };
    if (/^IFD\d+$/.test(name)) pages++;

    // Strips or tiles.
    const isTiled = tags.has(324);
    const offE = tags.get(isTiled ? 324 : 273);
    const cntE = tags.get(isTiled ? 325 : 279);
    let stripSummary = '';
    if (offE && cntE && w) {
      const offs = await readNumbers(offE);
      const cnts = await readNumbers(cntE);
      const m = Math.min(offs.length, cnts.length);
      const pieces: Array<[number, number]> = [];
      for (let i = 0; i < m; i++) {
        const o = offs[i]!;
        const c = cnts[i]!;
        if (o >= headerLen && c > 0 && o + c <= size) pieces.push([o, c]);
      }
      pieces.sort((a, b) => a[0] - b[0]);
      const label = `${name} ${isTiled ? 'tiles' : 'strips'}`;
      for (const [o, c] of pieces) pushMerged(strips, seg(label, 'pixels', o, c));
      if (offs.length >= MAX_VALUES) ctx.truncated = true;
      stripSummary = `${m} ${isTiled ? 'tile' : 'strip'}${m === 1 ? '' : 's'}`;
    }
    for (const s of strips) {
      if (s.count && s.count > 1 && s.name.startsWith(name + ' ')) s.detail = `${s.count} ${s.name.endsWith('tiles') ? 'tiles' : 'strips'} · ${fmtBytes(s.length)} ${COMPRESSION[comp] ?? ''}`.trim();
    }
    const parts = [`${n} tags`];
    if (w) parts.push(`${w}×${ht}`, `${spp}×${bps}-bit ${PHOTOMETRIC[photo] ?? ''}`.trim(), COMPRESSION[comp] ?? `compression ${comp}`);
    if (stripSummary) parts.push(stripSummary);
    out.push(seg(name, 'index', off, head + n * entrySize + inlineMax, parts.join(' · ')));

    // Follow sub-IFD pointers.
    for (const [tag, label] of [
      [34665, 'Exif IFD'],
      [34853, 'GPS IFD'],
      [40965, 'Interop IFD'],
      [330, 'SubIFD'],
    ] as const) {
      const e = tags.get(tag);
      if (e) for (const p of await readNumbers(e, 8)) queue.push({ off: p, name: label });
    }
    if (nextIfd > 0 && Number.isFinite(nextIfd) && /^IFD\d+$/.test(name)) queue.push({ off: nextIfd, name: `IFD${Number(name.slice(3)) + 1}` });
  }

  // Tag payload areas: merge neighbours of the same kind.
  valueAreas.sort((a, b) => a.offset - b.offset);
  for (const s of valueAreas) pushMerged(out, s);
  for (const s of strips) out.push(s);

  const area = (s: Segment) => (s.count && s.count > 1 ? `${s.count} tag value blocks` : s.detail);
  for (const s of out) if (s.name === 'tag values') s.detail = area(s);

  if (main) {
    ctx.summary = `${big ? 'BigTIFF' : 'TIFF'} ${main.w}×${main.h} · ${main.spp}×${main.bps}-bit ${PHOTOMETRIC[main.photo] ?? ''} · ${COMPRESSION[main.comp] ?? `compression ${main.comp}`}${pages > 1 ? ` · ${pages} pages` : ''}`.replace(/\s+/g, ' ');
  } else ctx.summary = 'TIFF · no readable IFD';
}
