import { type Ctx, fmtBytes, i32le, matchAscii, restUnknown, seg, u16le, u32le } from './util';

const COMPRESSION: Record<number, string> = { 0: 'uncompressed', 1: 'RLE8', 2: 'RLE4', 3: 'bitfields', 4: 'JPEG', 5: 'PNG', 6: 'alpha bitfields' };

export async function parseBmp(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const h = await r.read(0, 14 + 124);
  if (h.length < 26 || !matchAscii(h, 0, 'BM')) return;
  const declared = u32le(h, 2);
  const pixelOffset = u32le(h, 10);
  out.push(seg('BITMAPFILEHEADER', 'signature', 0, 14, `declared size ${declared.toLocaleString('en-US')} · pixel data at ${pixelOffset}`));
  const dibSize = u32le(h, 14);
  if (dibSize < 12 || dibSize > 124 + 4 || 14 + dibSize > size) {
    return;
  }
  let w = 0;
  let ht = 0;
  let bpp = 0;
  let comp = 0;
  let colours = 0;
  let topDown = false;
  let dibName = 'BITMAPINFOHEADER';
  if (dibSize === 12) {
    dibName = 'BITMAPCOREHEADER';
    w = u16le(h, 18);
    ht = u16le(h, 20);
    bpp = u16le(h, 24);
  } else {
    w = i32le(h, 18);
    const rawH = i32le(h, 22);
    topDown = rawH < 0;
    ht = Math.abs(rawH);
    bpp = u16le(h, 28);
    comp = u32le(h, 30);
    colours = u32le(h, 46);
    if (dibSize === 52) dibName = 'BITMAPV2INFOHEADER';
    else if (dibSize === 56) dibName = 'BITMAPV3INFOHEADER';
    else if (dibSize === 108) dibName = 'BITMAPV4HEADER';
    else if (dibSize === 124) dibName = 'BITMAPV5HEADER';
  }
  out.push(
    seg(dibName, 'header', 14, dibSize, `${w}×${ht} · ${bpp} bpp · ${COMPRESSION[comp] ?? `compression ${comp}`}${topDown ? ' · top-down' : ''}`),
  );
  let pos = 14 + dibSize;
  if (comp === 3 && dibSize === 40) {
    out.push(seg('colour masks', 'header', pos, 12, 'R/G/B bit masks'));
    pos += 12;
  } else if (comp === 6 && dibSize === 40) {
    out.push(seg('colour masks', 'header', pos, 16, 'R/G/B/A bit masks'));
    pos += 16;
  }
  const entrySize = dibSize === 12 ? 3 : 4;
  const palCount = bpp > 0 && bpp <= 8 ? (colours || 1 << bpp) : colours;
  const palEnd = Math.min(pixelOffset, pos + palCount * entrySize);
  if (palCount > 0 && palEnd > pos) {
    out.push(seg('colour table', 'palette', pos, palEnd - pos, `${Math.floor((palEnd - pos) / entrySize)} colours`));
    pos = palEnd;
  }
  if (pixelOffset > pos && pixelOffset <= size) {
    out.push(seg('gap before pixels', 'padding', pos, pixelOffset - pos));
    pos = pixelOffset;
  }
  if (pos < size) {
    // The pixel array runs to the end of the file unless a colour profile trails it (V5).
    let end = size;
    const rowBytes = Math.floor((w * bpp + 31) / 32) * 4;
    if (comp === 0 && rowBytes > 0 && ht > 0) end = Math.min(size, pos + rowBytes * ht);
    else if (declared > pos && declared <= size) end = declared;
    out.push(seg('pixel array', 'pixels', pos, end - pos, `${w}×${ht} · ${bpp} bpp · ${fmtBytes(end - pos)}`));
    pos = end;
  }
  if (pos < size) {
    if (dibSize === 124) {
      const pd = h.length >= 14 + 124 ? { off: u32le(h, 14 + 112), len: u32le(h, 14 + 116) } : { off: 0, len: 0 };
      if (pd.len > 0) out.push(seg('ICC profile', 'palette', 14 + pd.off, pd.len, `${fmtBytes(pd.len)} embedded profile`));
    }
    restUnknown(ctx, pos, 'data after pixels');
  }
  ctx.summary = `BMP ${w}×${ht} · ${bpp} bpp · ${COMPRESSION[comp] ?? 'compressed'}${palCount ? ` · ${palCount} colour palette` : ''}`;
}
