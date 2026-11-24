import { type Ctx, type Reader, ascii, cleanText, fmtBytes, latin1, matchAscii, pushUnknown, seg, u16be, u16le, u32be, u32le } from './util';
import type { SegmentRole } from './types';

const SOF_NAMES: Record<number, string> = {
  0xc0: 'baseline DCT',
  0xc1: 'extended sequential DCT',
  0xc2: 'progressive DCT',
  0xc3: 'lossless',
  0xc5: 'differential sequential',
  0xc6: 'differential progressive',
  0xc7: 'differential lossless',
  0xc9: 'arithmetic sequential',
  0xca: 'arithmetic progressive',
  0xcb: 'arithmetic lossless',
};

const CHUNK = 256 * 1024;

/** Offset of the next real marker at/after `from`, or -1 if none was reachable. */
async function nextMarker(r: Reader, from: number): Promise<number> {
  let pos = from;
  while (pos < r.size) {
    const chunk = await r.readUpTo(pos, CHUNK);
    if (chunk.length === 0) return -1;
    let i = 0;
    for (;;) {
      i = chunk.indexOf(0xff, i);
      if (i < 0) {
        pos += chunk.length;
        break;
      }
      if (i + 1 >= chunk.length) {
        if (pos + chunk.length >= r.size) return -1;
        pos += i; // re-read starting at the lone 0xFF
        break;
      }
      const m = chunk[i + 1] ?? 0;
      if (m === 0 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m === 0xff) {
        i += 1;
        continue;
      }
      return pos + i;
    }
  }
  return -1;
}

function exifDetail(d: Uint8Array): string {
  // 'Exif\0\0' + TIFF header
  const t = 6;
  const le = d[t] === 0x49;
  const rd16 = (o: number) => (le ? u16le(d, o) : u16be(d, o));
  const rd32 = (o: number) => (le ? u32le(d, o) : u32be(d, o));
  if (d.length < t + 8) return 'Exif';
  const ifd = rd32(t + 4);
  const n = ifd + t + 2 <= d.length ? rd16(ifd + t) : 0;
  return `Exif · ${le ? 'little' : 'big'}-endian · ${n} tags in IFD0`;
}

export async function parseJpeg(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const soi = await r.read(0, 3);
  if (soi.length < 3 || soi[0] !== 0xff || soi[1] !== 0xd8) return;
  out.push(seg('SOI', 'signature', 0, 2, 'start of image'));
  let pos = 2;
  let w = 0;
  let h = 0;
  let sofName = '';
  let comps = 0;
  let prec = 0;
  let scans = 0;
  const extras: string[] = [];
  let sawEoi = false;
  let steps = 0;

  while (pos + 2 <= size && steps++ < 100_000) {
    let m = await r.read(pos, 4);
    if (m.length < 2 && r.truncated) m = await r.readReserved(pos, 4); // budget spent: still read the closing markers
    if (m.length < 2 || m[0] !== 0xff) break;
    const code = m[1] ?? 0;
    if (code === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (code === 0xd9) {
      out.push(seg('EOI', 'trailer', pos, 2, 'end of image'));
      pos += 2;
      sawEoi = true;
      break;
    }
    if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7) || code === 0x00) {
      out.push(seg(code === 0xd8 ? 'SOI' : `RST/TEM 0x${code.toString(16)}`, 'unknown', pos, 2));
      pos += 2;
      continue;
    }
    if (m.length < 4) break;
    const len = u16be(m, 2);
    if (len < 2) break;
    let total = 2 + len;
    let clipped = false;
    if (pos + total > size) {
      total = size - pos;
      clipped = true;
    }
    let name = `0x${code.toString(16).toUpperCase()}`;
    let role: SegmentRole = 'unknown';
    let detail: string | undefined;

    if (code >= 0xe0 && code <= 0xef) {
      const n = code - 0xe0;
      name = `APP${n}`;
      role = 'metadata';
      const head = await r.read(pos + 4, Math.min(len - 2, n === 1 ? 65533 : 48));
      if (n === 0 && matchAscii(head, 0, 'JFIF')) {
        name = 'APP0 (JFIF)';
        role = 'header';
        detail = `JFIF ${head[5]}.${String(head[6] ?? 0).padStart(2, '0')} · density ${u16be(head, 8)}×${u16be(head, 10)} ${['aspect', 'dpi', 'dpcm'][head[7] ?? 0] ?? ''}`.trim();
      } else if (n === 0 && matchAscii(head, 0, 'JFXX')) {
        name = 'APP0 (JFXX)';
      } else if (n === 1 && matchAscii(head, 0, 'Exif')) {
        name = 'APP1 (Exif)';
        detail = exifDetail(head);
        extras.push('Exif');
      } else if (n === 1 && matchAscii(head, 0, 'http://ns.adobe.com/xap/1.0/')) {
        name = 'APP1 (XMP)';
        detail = `XMP packet · ${fmtBytes(len - 2)}`;
        extras.push('XMP');
      } else if (n === 2 && matchAscii(head, 0, 'ICC_PROFILE')) {
        name = 'APP2 (ICC)';
        role = 'palette';
        detail = `ICC profile chunk ${head[12]} of ${head[13]} · ${fmtBytes(len - 2)}`;
        extras.push('ICC');
      } else if (n === 2 && matchAscii(head, 0, 'MPF')) {
        name = 'APP2 (MPF)';
        detail = 'multi-picture format index';
      } else if (n === 13 && matchAscii(head, 0, 'Photoshop 3.0')) {
        name = 'APP13 (Photoshop)';
        detail = 'Photoshop image resources / IPTC';
      } else if (n === 14 && matchAscii(head, 0, 'Adobe')) {
        name = 'APP14 (Adobe)';
        role = 'header';
        detail = `Adobe colour transform ${head[11] ?? 0}`;
      } else {
        detail = cleanText(ascii(head, 0, 24), 24) || undefined;
      }
    } else if (code === 0xfe) {
      name = 'COM';
      role = 'metadata';
      const c = await r.read(pos + 4, Math.min(len - 2, 64));
      detail = `comment: ${cleanText(latin1(c), 48)}`;
    } else if (code === 0xdb) {
      name = 'DQT';
      role = 'header';
      const body = await r.read(pos + 4, Math.min(len - 2, 2048));
      let tables = 0;
      for (let o = 0; o < body.length; ) {
        const pq = (body[o] ?? 0) >> 4;
        tables++;
        o += 1 + (pq ? 128 : 64);
      }
      detail = `${tables} quantisation table${tables === 1 ? '' : 's'}`;
    } else if (code === 0xc4) {
      name = 'DHT';
      role = 'header';
      const body = await r.read(pos + 4, Math.min(len - 2, 2048));
      let tables = 0;
      for (let o = 0; o + 17 <= body.length; ) {
        let n = 0;
        for (let i = 1; i <= 16; i++) n += body[o + i] ?? 0;
        tables++;
        o += 17 + n;
      }
      detail = `${tables} Huffman table${tables === 1 ? '' : 's'}`;
    } else if (code === 0xdd) {
      name = 'DRI';
      role = 'header';
      const b = await r.read(pos + 4, 2);
      detail = `restart interval ${u16be(b, 0)} MCUs`;
    } else if (SOF_NAMES[code] !== undefined || (code >= 0xc0 && code <= 0xcf && code !== 0xc8 && code !== 0xcc)) {
      name = `SOF${code - 0xc0}`;
      role = 'header';
      const b = await r.read(pos + 4, 8);
      if (b.length >= 6) {
        prec = b[0] ?? 0;
        h = u16be(b, 1);
        w = u16be(b, 3);
        comps = b[5] ?? 0;
        sofName = SOF_NAMES[code] ?? 'DCT';
        detail = `${w}×${h} · ${prec}-bit · ${comps} component${comps === 1 ? '' : 's'} · ${sofName}`;
      }
    } else if (code === 0xda) {
      // Start of scan: header + entropy-coded data up to the next real marker.
      name = 'SOS';
      scans++;
      const dataStart = pos + total;
      let end = await nextMarker(r, dataStart);
      let note: string | undefined;
      if (end < 0) {
        // Ran out of budget (or malformed): trust a trailing EOI if there is one.
        const tail = await r.readReserved(size - 64, 64);
        let t = tail.length;
        while (t > 0 && tail[t - 1] === 0) t--;
        if (t >= 2 && tail[t - 2] === 0xff && tail[t - 1] === 0xd9) end = size - (tail.length - t) - 2;
        else end = size;
        if (r.truncated) {
          ctx.truncated = true;
          note = 'extent inferred from end of file (read budget reached)';
        }
      }
      const scanLen = Math.max(end, dataStart) - pos;
      out.push(
        seg('SOS', 'pixels', pos, scanLen, `${scans === 1 ? 'scan 1' : `scan ${scans}`} · ${fmtBytes(Math.max(0, end - dataStart))} entropy-coded${note ? ' · ' + note : ''}`),
      );
      pos = end;
      continue;
    }
    if (clipped) detail = `${detail ? detail + ' · ' : ''}cut off by end of file`;
    out.push(seg(name, role, pos, total, detail));
    pos += total;
    if (clipped) break;
  }

  if (pos < size) {
    pushUnknown(out, pos, size, sawEoi ? 'data after EOI' : 'unparsed data');
  } else if (!sawEoi && out.length) {
    ctx.truncated = ctx.truncated || false;
  }
  if (w) {
    const kind = sofName.includes('progressive') ? 'progressive' : sofName.includes('baseline') ? 'baseline' : sofName;
    ctx.summary = `JPEG ${w}×${h} · ${kind} · ${comps} component${comps === 1 ? '' : 's'}${extras.length ? ' · ' + extras.join(' · ') : ''}${scans > 1 ? ` · ${scans} scans` : ''}`;
  }
}
