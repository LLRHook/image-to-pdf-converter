import type { Segment, SegmentRole } from './types';
import { type Ctx, fmtBytes, matchAscii, restUnknown, seg, u16be, u32be, u64be } from './util';

const MODES: Record<number, string> = { 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'RGB', 4: 'CMYK', 7: 'multichannel', 8: 'duotone', 9: 'Lab' };
const COMPRESSION: Record<number, string> = { 0: 'raw', 1: 'RLE (PackBits)', 2: 'ZIP', 3: 'ZIP with prediction' };
const RESOURCES: Record<number, [string, SegmentRole]> = {
  1005: ['ResolutionInfo', 'metadata'],
  1006: ['Alpha channel names', 'metadata'],
  1010: ['Background colour', 'palette'],
  1028: ['IPTC-NAA', 'metadata'],
  1032: ['Grid and guides', 'metadata'],
  1033: ['Thumbnail (legacy)', 'media'],
  1036: ['Thumbnail', 'media'],
  1037: ['Global angle', 'metadata'],
  1039: ['ICC profile', 'palette'],
  1044: ['Alpha identifiers', 'metadata'],
  1045: ['Unicode alpha names', 'metadata'],
  1050: ['Slices', 'metadata'],
  1053: ['Alpha identifiers', 'metadata'],
  1058: ['Exif', 'metadata'],
  1060: ['XMP', 'metadata'],
  1064: ['Pixel aspect ratio', 'metadata'],
  1069: ['Layer selection ids', 'metadata'],
  1077: ['Display info', 'metadata'],
  1082: ['Print information', 'metadata'],
};

export async function parsePsd(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const h = await r.read(0, 26);
  if (h.length < 26 || !matchAscii(h, 0, '8BPS')) return;
  const version = u16be(h, 4);
  if (version !== 1 && version !== 2) return;
  const big = version === 2;
  const channels = u16be(h, 12);
  const height = u32be(h, 14);
  const width = u32be(h, 18);
  const depth = u16be(h, 22);
  const mode = u16be(h, 24);
  out.push(seg('File header', 'header', 0, 26, `${big ? 'PSB' : 'PSD'} · ${width}×${height} · ${channels} channels · ${depth}-bit ${MODES[mode] ?? `mode ${mode}`}`));
  let pos = 26;

  // Colour mode data
  const cm = await r.read(pos, 4);
  if (cm.length < 4) return;
  const cmLen = u32be(cm, 0);
  out.push(seg('Colour mode data', 'palette', pos, Math.min(4 + cmLen, size - pos), cmLen ? `${fmtBytes(cmLen)}${mode === 2 ? ' · 256-colour palette' : ''}` : 'empty'));
  pos += 4 + cmLen;

  // Image resources
  const ir = await r.read(pos, 4);
  if (ir.length < 4) return restUnknown(ctx, pos);
  const irLen = u32be(ir, 0);
  const irEnd = Math.min(size, pos + 4 + irLen);
  const resources: Segment[] = [];
  let p = pos + 4;
  let n = 0;
  while (p + 12 <= irEnd && n++ < 500) {
    const b = await r.read(p, 12 + 64);
    if (!matchAscii(b, 0, '8BIM') && !matchAscii(b, 0, 'MeSa')) break;
    const id = u16be(b, 4);
    const nameLen = b[6] ?? 0;
    const nameTotal = 1 + nameLen + ((1 + nameLen) % 2);
    const sizeOff = 6 + nameTotal;
    const dataLen = u32be(await r.read(p + sizeOff, 4), 0);
    const total = sizeOff + 4 + dataLen + (dataLen % 2);
    const info = RESOURCES[id];
    const name = info ? info[0] : id >= 2000 && id <= 2997 ? `Path ${id - 2000 + 1}` : `Resource ${id}`;
    resources.push(seg(name, info?.[1] ?? 'metadata', p, Math.min(total, irEnd - p), `id ${id} · ${fmtBytes(dataLen)}`));
    p += total;
  }
  out.push(seg('Image resources', 'metadata', pos, irEnd - pos, `${resources.length} resource block${resources.length === 1 ? '' : 's'}`, { children: resources }));
  pos = irEnd;

  // Layer and mask information
  const lm = await r.read(pos, big ? 8 : 4);
  if (lm.length < (big ? 8 : 4)) return restUnknown(ctx, pos);
  const lmLen = big ? u64be(lm, 0) : u32be(lm, 0);
  const lmHead = big ? 8 : 4;
  const lmEnd = Number.isFinite(lmLen) ? Math.min(size, pos + lmHead + lmLen) : size;
  const kids: Segment[] = [];
  let layers = 0;
  if (lmLen > 0) {
    const li = await r.read(pos + lmHead, (big ? 8 : 4) + 2);
    const liLen = big ? u64be(li, 0) : u32be(li, 0);
    if (Number.isFinite(liLen) && liLen > 0) {
      const cnt = (u16be(li, big ? 8 : 4) << 16) >> 16;
      layers = Math.abs(cnt);
      const liEnd = Math.min(lmEnd, pos + lmHead + (big ? 8 : 4) + liLen);
      kids.push(seg('Layer info', 'pixels', pos + lmHead, liEnd - (pos + lmHead), `${layers} layer${layers === 1 ? '' : 's'}${cnt < 0 ? ' (first alpha is merged transparency)' : ''} · ${fmtBytes(liLen)}`));
      let q = liEnd;
      if (q + 4 <= lmEnd) {
        const gl = u32be(await r.read(q, 4), 0);
        kids.push(seg('Global layer mask info', 'metadata', q, Math.min(4 + gl, lmEnd - q)));
        q += 4 + gl;
      }
      if (q < lmEnd) kids.push(seg('Additional layer information', 'metadata', q, lmEnd - q, 'tagged blocks'));
    } else kids.push(seg('Layer info', 'pixels', pos + lmHead, lmEnd - pos - lmHead, 'empty'));
  }
  out.push(seg('Layer and mask information', 'container', pos, lmEnd - pos, lmLen ? `${layers} layer${layers === 1 ? '' : 's'} · ${fmtBytes(lmLen)}` : 'none', { children: kids }));
  pos = lmEnd;

  // Image data
  if (pos + 2 <= size) {
    const c = u16be(await r.read(pos, 2), 0);
    out.push(seg('Image data', 'pixels', pos, size - pos, `${COMPRESSION[c] ?? `compression ${c}`} · merged composite · ${fmtBytes(size - pos - 2)}`));
  } else if (pos < size) restUnknown(ctx, pos);
  ctx.summary = `${big ? 'PSB' : 'PSD'} ${width}×${height} · ${depth}-bit ${MODES[mode] ?? ''} · ${channels} channels · ${layers} layer${layers === 1 ? '' : 's'}`.replace(/\s+/g, ' ');
}
