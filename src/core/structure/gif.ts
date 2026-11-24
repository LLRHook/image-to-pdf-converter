import { type Ctx, type Reader, fmtBytes, matchAscii, pushMerged, restUnknown, seg, u16le, ascii, cleanText } from './util';

/** Length in bytes of a sub-block chain starting at `pos` (including the 0 terminator), or -1. */
async function subBlocks(r: Reader, pos: number): Promise<number> {
  let p = pos;
  for (let n = 0; n < 5_000_000; n++) {
    const b = await r.read(p, 1);
    if (b.length === 0) return -1;
    const len = b[0] ?? 0;
    p += 1 + len;
    if (len === 0) return p - pos;
    if (p > r.size) return -1;
  }
  return -1;
}

export async function parseGif(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const head = await r.read(0, 13);
  if (head.length < 13 || !(matchAscii(head, 0, 'GIF87a') || matchAscii(head, 0, 'GIF89a'))) return;
  const version = ascii(head, 0, 6);
  out.push(seg(version, 'signature', 0, 6));
  const w = u16le(head, 6);
  const h = u16le(head, 8);
  const packed = head[10] ?? 0;
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 1 << ((packed & 7) + 1) : 0;
  out.push(
    seg('Logical Screen Descriptor', 'header', 6, 7, `${w}×${h} · ${(((packed >> 4) & 7) + 1)}-bit colour${hasGct ? ` · global palette ${gctSize}` : ''} · background index ${head[11] ?? 0}`),
  );
  let pos = 13;
  if (hasGct) {
    out.push(seg('Global Colour Table', 'palette', pos, gctSize * 3, `${gctSize} colours`));
    pos += gctSize * 3;
  }

  let frames = 0;
  let loop = '';
  let pendingStart = -1; // start of a Graphic Control Extension waiting for its frame
  let delayCs = -1;
  let sawTrailer = false;
  let steps = 0;

  while (pos < size && steps++ < 2_000_000) {
    const b = await r.read(pos, 3);
    if (b.length === 0) break;
    const intro = b[0];
    if (intro === 0x3b) {
      out.push(seg('Trailer', 'trailer', pos, 1));
      pos += 1;
      sawTrailer = true;
      break;
    }
    if (intro === 0x21) {
      const label = b[1] ?? 0;
      const body = await subBlocks(r, pos + 2);
      if (body < 0) break;
      const total = 2 + body;
      if (label === 0xf9) {
        const gce = await r.read(pos + 3, 4);
        delayCs = u16le(gce, 1);
        pendingStart = pos;
      } else if (label === 0xff) {
        const id = await r.read(pos + 3, 11);
        const name = ascii(id, 0, 11);
        if (name.startsWith('NETSCAPE')) {
          const sub = await r.read(pos + 14, 4);
          const n = u16le(sub, 2);
          loop = n === 0 ? 'loops forever' : `loops ${n}×`;
          pushMerged(out, seg('Application Extension', 'header', pos, total, `NETSCAPE 2.0 · ${loop}`));
        } else {
          pushMerged(out, seg('Application Extension', 'metadata', pos, total, cleanText(name, 24)));
        }
      } else if (label === 0xfe) {
        pushMerged(out, seg('Comment Extension', 'metadata', pos, total));
      } else if (label === 0x01) {
        pushMerged(out, seg('Plain Text Extension', 'text', pos, total));
      } else {
        pushMerged(out, seg(`Extension 0x${label.toString(16)}`, 'unknown', pos, total));
      }
      pos += total;
      continue;
    }
    if (intro === 0x2c) {
      const desc = await r.read(pos, 10);
      if (desc.length < 10) break;
      const fw = u16le(desc, 5);
      const fh = u16le(desc, 7);
      const fp = desc[9] ?? 0;
      let p = pos + 10;
      if (fp & 0x80) p += 3 * (1 << ((fp & 7) + 1));
      p += 1; // LZW minimum code size
      const body = await subBlocks(r, p);
      if (body < 0) break;
      p += body;
      const start = pendingStart >= 0 ? pendingStart : pos;
      frames++;
      const detail = `${fw}×${fh}${delayCs >= 0 ? ` · ${delayCs * 10} ms` : ''}${fp & 0x40 ? ' · interlaced' : ''}${fp & 0x80 ? ' · local palette' : ''}`;
      pushMerged(out, seg('Image frame', 'pixels', start, p - start, detail));
      pendingStart = -1;
      delayCs = -1;
      pos = p;
      continue;
    }
    break; // not a valid block introducer
  }

  for (const s of out) {
    if (s.name === 'Image frame' && s.count && s.count > 1) s.detail = `${s.count.toLocaleString('en-US')} frames · ${fmtBytes(s.length)} LZW`;
  }
  if (pos < size) restUnknown(ctx, pos, sawTrailer ? 'data after trailer' : 'unparsed data');
  ctx.summary = `GIF ${version.slice(3)} ${w}×${h} · ${frames.toLocaleString('en-US')} frame${frames === 1 ? '' : 's'}${loop ? ' · ' + loop : ''}`;
}
