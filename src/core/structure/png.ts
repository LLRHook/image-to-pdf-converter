import type { Segment, SegmentRole } from './types';
import { type Ctx, fmtBytes, fourcc, latin1, matchAscii, pushMerged, restUnknown, seg, u16be, u32be } from './util';

const COLOUR_TYPES: Record<number, string> = { 0: 'grayscale', 2: 'RGB', 3: 'indexed', 4: 'grayscale+alpha', 6: 'RGBA' };

function chunkRole(type: string): SegmentRole {
  switch (type) {
    case 'IHDR':
    case 'acTL':
    case 'fcTL':
      return 'header';
    case 'PLTE':
    case 'tRNS':
    case 'iCCP':
    case 'sPLT':
      return 'palette';
    case 'IDAT':
    case 'fdAT':
      return 'pixels';
    case 'IEND':
      return 'trailer';
    case 'tEXt':
    case 'iTXt':
    case 'zTXt':
    case 'eXIf':
    case 'tIME':
    case 'pHYs':
    case 'gAMA':
    case 'cHRM':
    case 'sRGB':
    case 'sBIT':
    case 'bKGD':
    case 'hIST':
    case 'cICP':
    case 'mDCV':
    case 'cLLI':
      return 'metadata';
    default:
      // Ancillary (lowercase first letter) chunks are metadata-like; critical unknowns stay unknown.
      return type.charCodeAt(0) >= 97 ? 'metadata' : 'unknown';
  }
}

export async function parsePng(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const sig = await r.read(0, 8);
  if (sig.length < 8 || sig[0] !== 0x89 || !matchAscii(sig, 1, 'PNG\r\n\x1a\n')) return;
  out.push(seg('PNG signature', 'signature', 0, 8));

  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ct = -1;
  let interlaced = false;
  let idat = 0;
  let frames = 0;
  let sawIend = false;

  while (pos + 12 <= size) {
    const head = await r.read(pos, 8);
    if (head.length < 8) break;
    const len = u32be(head, 0);
    const type = fourcc(head, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) break;
    let total = 12 + len;
    let clipped = false;
    if (pos + total > size) {
      total = size - pos;
      clipped = true;
    }
    let detail: string | undefined;
    const want = Math.min(len, type === 'IHDR' ? 13 : 96);
    const needsData = ['IHDR', 'tEXt', 'iTXt', 'zTXt', 'iCCP', 'pHYs', 'gAMA', 'sRGB', 'tIME', 'acTL', 'fcTL', 'sPLT'].includes(type);
    const data = needsData ? await r.read(pos + 8, want) : undefined;
    switch (type) {
      case 'IHDR':
        if (data && data.length >= 13) {
          w = u32be(data, 0);
          h = u32be(data, 4);
          depth = data[8] ?? 0;
          ct = data[9] ?? 0;
          interlaced = data[12] === 1;
          detail = `${w}×${h} · ${depth}-bit ${COLOUR_TYPES[ct] ?? `type ${ct}`}${interlaced ? ' · Adam7 interlaced' : ''}`;
        }
        break;
      case 'PLTE':
        detail = `${Math.floor(len / 3)} colours`;
        break;
      case 'tRNS':
        detail = ct === 3 ? `${len} alpha entries` : 'transparent colour key';
        break;
      case 'IDAT':
      case 'fdAT':
        idat++;
        break;
      case 'tEXt':
      case 'iTXt':
      case 'zTXt':
        if (data) {
          const nul = data.indexOf(0);
          const key = latin1(data.subarray(0, nul < 0 ? data.length : Math.min(nul, 79)));
          let val = '';
          if (type === 'tEXt' && nul >= 0) val = latin1(data.subarray(nul + 1, nul + 1 + 40));
          detail = val ? `${key}: ${val}` : key;
        }
        break;
      case 'eXIf':
        detail = `Exif · ${fmtBytes(len)}`;
        break;
      case 'iCCP':
        if (data) {
          const nul = data.indexOf(0);
          detail = `ICC profile "${latin1(data.subarray(0, nul < 0 ? Math.min(data.length, 79) : nul))}" · ${fmtBytes(len)}`;
        }
        break;
      case 'pHYs':
        if (data && data.length >= 9) {
          const ppu = u32be(data, 0);
          detail = data[8] === 1 ? `${Math.round(ppu * 0.0254)} dpi` : `${ppu}×${u32be(data, 4)} (unit unknown)`;
        }
        break;
      case 'gAMA':
        if (data && data.length >= 4) detail = `gamma ${(u32be(data, 0) / 100000).toFixed(5)}`;
        break;
      case 'sRGB':
        detail = 'sRGB colour space';
        break;
      case 'tIME':
        if (data && data.length >= 7) {
          const p2 = (n: number) => String(n).padStart(2, '0');
          detail = `${u16be(data, 0)}-${p2(data[2] ?? 0)}-${p2(data[3] ?? 0)} ${p2(data[4] ?? 0)}:${p2(data[5] ?? 0)}:${p2(data[6] ?? 0)}`;
        }
        break;
      case 'acTL':
        if (data && data.length >= 8) {
          frames = u32be(data, 0);
          detail = `${frames} frames · ${u32be(data, 4) || '∞'} plays`;
        }
        break;
      case 'fcTL':
        if (data && data.length >= 12) detail = `${u32be(data, 4)}×${u32be(data, 8)} frame`;
        break;
      default:
        break;
    }
    if (clipped) detail = `${detail ? detail + ' · ' : ''}cut off by end of file`;
    pushMerged(out, seg(type, chunkRole(type), pos, total, detail));
    pos += total;
    if (clipped) break;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }

  for (const s of out) {
    if (!s.count || s.count < 2) continue;
    if (s.name === 'IDAT' || s.name === 'fdAT') s.detail = `${s.count.toLocaleString('en-US')} chunks · ${fmtBytes(s.length)} deflate`;
    else if (s.name === 'tEXt' || s.name === 'iTXt' || s.name === 'zTXt') s.detail = `${s.count} text entries`;
  }
  const idatSeg = out.find((s: Segment) => s.name === 'IDAT');
  if (idatSeg && !idatSeg.detail) idatSeg.detail = `${fmtBytes(idatSeg.length)} deflate`;

  if (pos < size) restUnknown(ctx, pos, sawIend ? 'data after IEND' : 'unparsed data');
  if (w) {
    const idatCount = out.filter((s) => s.name === 'IDAT').reduce((a, s) => a + (s.count ?? 1), 0);
    ctx.summary =
      `PNG ${w}×${h} ${depth}-bit ${COLOUR_TYPES[ct] ?? '?'}` +
      (frames ? ` · animated ${frames} frames` : '') +
      ` · ${idatCount.toLocaleString('en-US')} IDAT chunk${idatCount === 1 ? '' : 's'}` +
      (interlaced ? ' · interlaced' : '');
  }
}
