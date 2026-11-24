import type { Segment, SegmentRole } from './types';
import { type Ctx, fmtBytes, matchAscii, seg, u16le, u32le } from './util';

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const MAX_SECTORS = 262_144;

function roleFor(name: string): SegmentRole {
  switch (name) {
    case 'Workbook':
    case 'Book':
    case 'Mini stream':
      return 'records';
    case 'FAT':
    case 'DIFAT':
    case 'Directory':
    case 'MiniFAT':
      return 'index';
    case 'free sectors':
      return 'padding';
    case 'unallocated':
      return 'unknown';
    default:
      return name.includes('Information') || name.includes('CompObj') ? 'metadata' : 'records';
  }
}

/** OLE2 / Compound File Binary (legacy .xls): header, FAT, directory, streams as sector runs. */
export async function parseOle2(ctx: Ctx): Promise<void> {
  const { r, out } = ctx;
  const size = r.size;
  const h = await r.read(0, 512);
  if (h.length < 512 || !matchAscii(h, 0, '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')) return;
  const shift = u16le(h, 30);
  if (shift < 7 || shift > 16) return;
  const sectorSize = 1 << shift;
  const nSectors = Math.max(0, Math.floor((size - sectorSize) / sectorSize) + (((size - sectorSize) % sectorSize) > 0 ? 1 : 0));
  if (nSectors > MAX_SECTORS) {
    ctx.truncated = true;
    out.push(seg('header', 'header', 0, Math.min(sectorSize, size), 'file too large to map sector by sector'));
    return;
  }
  const cutoff = u32le(h, 56);
  const dirStart = u32le(h, 48);
  const miniFatStart = u32le(h, 60);
  const miniFatCount = u32le(h, 64);
  const difatStart = u32le(h, 68);
  const difatCount = u32le(h, 72);
  const fatCount = u32le(h, 44);
  const secOff = (s: number): number => (s + 1) * sectorSize;
  const owner: string[] = new Array(nSectors).fill('');

  // FAT sector list: 109 entries in the header, then the DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = u32le(h, 76 + i * 4);
    if (s < nSectors) fatSectors.push(s);
  }
  let d = difatStart;
  for (let k = 0; k < Math.min(difatCount, 1000) && d < nSectors; k++) {
    owner[d] = 'DIFAT';
    const buf = await r.read(secOff(d), sectorSize);
    if (buf.length < sectorSize) break;
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const s = u32le(buf, i * 4);
      if (s < nSectors) fatSectors.push(s);
    }
    d = u32le(buf, sectorSize - 4);
  }
  const fat = new Uint32Array(nSectors).fill(FREE);
  const per = sectorSize / 4;
  let fi = 0;
  for (const s of fatSectors.slice(0, Math.min(fatCount || 4096, 4096))) {
    owner[s] = 'FAT';
    const buf = await r.read(secOff(s), sectorSize);
    if (buf.length < sectorSize) break;
    for (let i = 0; i < per && fi * per + i < nSectors; i++) fat[fi * per + i] = u32le(buf, i * 4);
    fi++;
  }
  const chain = (start: number, name: string): number[] => {
    const list: number[] = [];
    let s = start;
    while (s < nSectors && list.length <= nSectors && owner[s] !== name) {
      if (owner[s] && owner[s] !== '') break;
      owner[s] = name;
      list.push(s);
      const nx = fat[s]!;
      if (nx === END || nx === FREE || nx === FATSECT || nx === DIFSECT) break;
      s = nx;
    }
    return list;
  };

  // Directory.
  const dirSectors = chain(dirStart, 'Directory');
  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (const s of dirSectors.slice(0, 64)) {
    const buf = await r.read(secOff(s), sectorSize);
    for (let o = 0; o + 128 <= buf.length; o += 128) {
      const nameLen = u16le(buf, o + 64);
      const type = buf[o + 66] ?? 0;
      if (type === 0 || nameLen < 2 || nameLen > 64) continue;
      let name = '';
      for (let k = 0; k < nameLen / 2 - 1; k++) {
        const ch = u16le(buf, o + k * 2);
        name += ch < 32 ? '' : String.fromCharCode(ch);
      }
      entries.push({ name: name || '(unnamed)', type, start: u32le(buf, o + 116), size: u32le(buf, o + 120) });
    }
  }
  if (miniFatCount > 0) chain(miniFatStart, 'MiniFAT');
  const smallStreams: string[] = [];
  for (const e of entries) {
    if (e.type === 5) {
      if (e.start < nSectors) chain(e.start, 'Mini stream');
    } else if (e.type === 2) {
      if (e.size >= cutoff) chain(e.start, e.name);
      else smallStreams.push(e.name);
    }
  }
  for (let s = 0; s < nSectors; s++) if (!owner[s]) owner[s] = fat[s] === FREE ? 'free sectors' : 'unallocated';

  out.push(seg('header', 'header', 0, Math.min(sectorSize, size), `OLE2 · ${sectorSize}-byte sectors · ${fatSectors.length} FAT sector${fatSectors.length === 1 ? '' : 's'} · mini-stream cutoff ${cutoff}`));
  let runStart = 0;
  const flush = (end: number): void => {
    if (end <= runStart) return;
    const name = owner[runStart]!;
    const from = secOff(runStart);
    const to = Math.min(size, secOff(end));
    let detail = `${end - runStart} sector${end - runStart === 1 ? '' : 's'}`;
    if (name === 'Workbook' || name === 'Book') detail += ' · BIFF workbook stream';
    if (name === 'Mini stream' && smallStreams.length) detail += ` · holds ${smallStreams.length} small stream${smallStreams.length === 1 ? '' : 's'}: ${smallStreams.slice(0, 4).map((x) => x.replace(/[\u0000-\u001f]/g, '')).join(', ')}`;
    out.push(seg(name, roleFor(name), from, to - from, detail));
  };
  for (let s = 1; s <= nSectors; s++) {
    if (s === nSectors || owner[s] !== owner[runStart]) {
      flush(s);
      runStart = s;
    }
  }
  // Annotate the workbook stream with its BIFF version.
  const wb = entries.find((e) => (e.name === 'Workbook' || e.name === 'Book') && e.type === 2);
  let biff = '';
  if (wb && wb.size >= cutoff && wb.start < nSectors) {
    const rec = await r.read(secOff(wb.start), 8);
    if (u16le(rec, 0) === 0x0809) {
      const ver = u16le(rec, 4);
      biff = ver === 0x0600 ? 'BIFF8' : ver === 0x0500 ? 'BIFF5' : `BIFF 0x${ver.toString(16)}`;
      for (const s of out as Segment[]) if (s.name === wb.name && s.detail) s.detail = s.detail.replace('BIFF workbook stream', `${biff} workbook stream`);
    }
  }
  const names = entries.filter((e) => e.type === 2).map((e) => e.name.replace(/[\u0000-\u001f]/g, ''));
  ctx.summary = `OLE2 compound file${biff ? ` · ${biff} workbook` : ''} · ${entries.filter((e) => e.type === 2).length} streams${names.length ? ': ' + names.slice(0, 4).join(', ') : ''} · ${fmtBytes(size)}`;
}
