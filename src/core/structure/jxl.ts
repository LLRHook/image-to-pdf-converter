import type { Segment, SegmentRole } from './types';
import { type Ctx, fmtBytes, matchAscii, pushMerged, restUnknown, seg, u32be } from './util';
import { readBoxHeader } from './isobmff';

/** Decode the codestream SizeHeader (ISO/IEC 18181-1) that follows the FF 0A signature. */
export function decodeJxlSize(b: Uint8Array, o: number): { w: number; h: number } | undefined {
  let bit = o * 8;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = b[bit >> 3];
      if (byte === undefined) return -1;
      v += ((byte >> (bit & 7)) & 1) * 2 ** i;
      bit++;
    }
    return v;
  };
  const u32 = (): number => {
    const sel = take(2);
    if (sel < 0) return -1;
    const bits = [9, 13, 18, 30][sel] ?? 9;
    const v = take(bits);
    return v < 0 ? -1 : v + 1;
  };
  const small = take(1);
  if (small < 0) return undefined;
  let h: number;
  if (small) {
    const v = take(5);
    if (v < 0) return undefined;
    h = (v + 1) * 8;
  } else {
    h = u32();
    if (h < 0) return undefined;
  }
  const ratio = take(3);
  if (ratio < 0) return undefined;
  let w: number;
  if (ratio === 0) {
    if (small) {
      const v = take(5);
      if (v < 0) return undefined;
      w = (v + 1) * 8;
    } else {
      w = u32();
      if (w < 0) return undefined;
    }
  } else {
    const [n, d] = ([[1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]] as const)[ratio - 1] ?? [1, 1];
    w = Math.floor((h * n) / d);
  }
  return { w, h };
}

const BOX_ROLE: Record<string, SegmentRole> = {
  'JXL ': 'signature',
  ftyp: 'header',
  jxll: 'header',
  jxlc: 'pixels',
  jxlp: 'pixels',
  jxli: 'index',
  jbrd: 'metadata',
  Exif: 'metadata',
  'xml ': 'metadata',
  jumb: 'metadata',
  brob: 'metadata',
};

export async function parseJxl(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const head = await r.read(0, 16);
  if (head.length < 2) return;
  if (head[0] === 0xff && head[1] === 0x0a) {
    const dims = decodeJxlSize(head, 2);
    out.push(seg('signature', 'signature', 0, 2, 'FF 0A · bare codestream'));
    out.push(seg('codestream', 'pixels', 2, size - 2, `${dims ? `${dims.w}×${dims.h} · ` : ''}${fmtBytes(size - 2)}`));
    ctx.summary = `JPEG XL${dims ? ` ${dims.w}×${dims.h}` : ''} · bare codestream`;
    return;
  }
  if (!(u32be(head, 0) === 12 && matchAscii(head, 4, 'JXL '))) return;
  let pos = 0;
  let dims: { w: number; h: number } | undefined;
  let jpegRecon = false;
  let guard = 0;
  while (pos + 8 <= size && guard++ < 10_000) {
    const b = await readBoxHeader(r, pos, size);
    if (!b) break;
    let detail: string | undefined;
    if ((b.type === 'jxlc' || b.type === 'jxlp') && !dims) {
      const skip = b.type === 'jxlp' ? 4 : 0;
      const d = await r.read(b.start + b.hdr + skip, 16);
      if (d[0] === 0xff && d[1] === 0x0a) dims = decodeJxlSize(d, 2);
      if (dims) detail = `codestream ${dims.w}×${dims.h}`;
    }
    if (b.type === 'jbrd') {
      jpegRecon = true;
      detail = 'JPEG reconstruction data';
    }
    if (b.type === 'JXL ') detail = 'container signature';
    const s: Segment = seg(b.type, BOX_ROLE[b.type] ?? 'unknown', b.start, b.size, detail ?? (b.size > 64 ? fmtBytes(b.size - b.hdr) : undefined));
    pushMerged(out, s);
    pos += b.size;
    if (b.clipped) break;
  }
  for (const s of out) if (s.count && s.count > 1) s.detail = `${s.count} partial codestream boxes · ${fmtBytes(s.length)}`;
  if (pos < size) restUnknown(ctx, pos);
  ctx.summary = `JPEG XL${dims ? ` ${dims.w}×${dims.h}` : ''} · container${jpegRecon ? ' · lossless JPEG recompression' : ''}`;
}
