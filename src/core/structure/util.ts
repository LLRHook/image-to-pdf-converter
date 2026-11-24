import type { FormatId } from '../formats';
import type { ByteSource, FileStructure, Segment, SegmentRole } from './types';

/** Hard limits shared by every parser. */
export const LIMITS = {
  /** Default cap on bytes fetched from the source per parse. */
  budget: 8 * 1024 * 1024,
  /** Cap on source.read() calls per parse (bounds work on hostile many-chunk files). */
  reads: 20_000,
  /** Cap on segments in any single list. */
  list: 2000,
  /** Levels of children below a top-level segment (top-level = level 0). */
  depth: 4,
  /** Cap on segments in the whole tree. */
  nodes: 20_000,
} as const;

export const EMPTY = new Uint8Array(0);

const ROLES: ReadonlySet<string> = new Set<SegmentRole>([
  'signature',
  'header',
  'metadata',
  'index',
  'palette',
  'pixels',
  'samples',
  'text',
  'style',
  'media',
  'records',
  'container',
  'padding',
  'trailer',
  'unknown',
]);

// ---------------------------------------------------------------- reading

/**
 * Budgeted random-access reader. Never throws on bad offsets: out-of-range or
 * over-budget reads return an empty (or short) array; callers check lengths.
 */
export class Reader {
  readonly size: number;
  bytesRead = 0;
  reads = 0;
  truncated = false;
  private winStart = 0;
  private win: Uint8Array = EMPTY;

  constructor(
    private readonly src: ByteSource,
    readonly budget: number = LIMITS.budget,
  ) {
    const s = Number(src.size);
    this.size = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  }

  get remainingBudget(): number {
    return Math.max(0, this.budget - this.bytesRead);
  }

  get exhausted(): boolean {
    return this.truncated;
  }

  /** Read exactly `length` bytes (clamped to EOF). Empty array if out of range or over budget. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!(offset >= 0) || !(length > 0) || offset >= this.size) return EMPTY;
    offset = Math.floor(offset);
    length = Math.min(Math.floor(length), this.size - offset);
    if (length <= 0) return EMPTY;
    const w = this.win;
    if (offset >= this.winStart && offset + length <= this.winStart + w.length) {
      return w.subarray(offset - this.winStart, offset - this.winStart + length);
    }
    // Sequential continuation after the window gets a big read-ahead; jumps get a small one.
    const winEnd = this.winStart + w.length;
    const sequential = w.length > 0 && offset >= this.winStart && offset <= winEnd + 256;
    let fetch = length <= 4096 ? Math.max(length, sequential ? 16384 : 512) : length;
    fetch = Math.min(fetch, this.size - offset);
    if (this.reads >= LIMITS.reads || this.bytesRead + fetch > this.budget) {
      fetch = length;
      if (this.reads >= LIMITS.reads || this.bytesRead + fetch > this.budget) {
        this.truncated = true;
        return EMPTY;
      }
    }
    this.reads++;
    this.bytesRead += fetch;
    let data: Uint8Array;
    try {
      data = await this.src.read(offset, fetch);
    } catch {
      this.truncated = true;
      return EMPTY;
    }
    if (!(data instanceof Uint8Array)) return EMPTY;
    if (data.length > fetch) data = data.subarray(0, fetch);
    if (fetch <= 16384 && data.length > 0) {
      this.win = data;
      this.winStart = offset;
    }
    return data.length > length ? data.subarray(0, length) : data;
  }

  private reserved = 0;

  /** Tiny tail/trailer reads that must still work after the main budget is spent (≤ 256 KB total). */
  async readReserved(offset: number, length: number): Promise<Uint8Array> {
    if (!(offset >= 0) || !(length > 0) || offset >= this.size) return EMPTY;
    length = Math.min(Math.floor(length), this.size - Math.floor(offset), 65536);
    if (this.reserved + length > 262144) return EMPTY;
    this.reserved += length;
    try {
      const d = await this.src.read(Math.floor(offset), length);
      return d instanceof Uint8Array ? d.subarray(0, length) : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  /** Like read(), but returns whatever the remaining budget allows, flagging truncation when clipped. */
  async readUpTo(offset: number, length: number): Promise<Uint8Array> {
    if (!(offset >= 0) || !(length > 0) || offset >= this.size) return EMPTY;
    length = Math.min(Math.floor(length), this.size - Math.floor(offset));
    const allowed = Math.min(length, this.remainingBudget);
    if (allowed < length) this.truncated = true;
    if (allowed <= 0) return EMPTY;
    return this.read(offset, allowed);
  }
}

export interface Ctx {
  r: Reader;
  format: FormatId;
  /** Top-level segments, pushed by the parser as it goes (kept if the parser later throws). */
  out: Segment[];
  summary?: string;
  /** Parser-level truncation (segment caps, intentional sampling cut-offs). */
  truncated: boolean;
}

// ---------------------------------------------------------------- byte helpers

export const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
export const u16le = (b: Uint8Array, o: number): number => ((b[o + 1] ?? 0) << 8) | (b[o] ?? 0);
export const u24be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o + 2] ?? 0);
export const u24le = (b: Uint8Array, o: number): number => ((b[o + 2] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o] ?? 0);
export const u32be = (b: Uint8Array, o: number): number =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
export const u32le = (b: Uint8Array, o: number): number =>
  (((b[o + 3] ?? 0) << 24) | ((b[o + 2] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o] ?? 0)) >>> 0;
export const i32be = (b: Uint8Array, o: number): number => u32be(b, o) | 0;
export const i32le = (b: Uint8Array, o: number): number => u32le(b, o) | 0;
/** 64-bit values as doubles; anything above 2^53 collapses to Infinity so callers reject it. */
export const u64be = (b: Uint8Array, o: number): number => {
  const hi = u32be(b, o);
  return hi >= 0x200000 ? Infinity : hi * 4294967296 + u32be(b, o + 4);
};
export const u64le = (b: Uint8Array, o: number): number => {
  const hi = u32le(b, o + 4);
  return hi >= 0x200000 ? Infinity : hi * 4294967296 + u32le(b, o);
};

export function ascii(b: Uint8Array, o: number, n: number): string {
  let s = '';
  const end = Math.min(b.length, o + n);
  for (let i = Math.max(0, o); i < end; i++) {
    const c = b[i] ?? 0;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
  }
  return s;
}

/** Four-character code at offset ('moov', 'IDAT'); non-printables become '.'. */
export const fourcc = (b: Uint8Array, o: number): string => ascii(b, o, 4);

export function matchAscii(b: Uint8Array, o: number, s: string): boolean {
  if (o < 0 || o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
export function utf8(b: Uint8Array): string {
  return utf8Decoder.decode(b);
}
export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

/** First index of `needle` (ASCII) at or after `from`, or -1. */
export function indexOfAscii(hay: Uint8Array, needle: string, from = 0, to = hay.length): number {
  const n = needle.length;
  if (n === 0) return Math.min(from, to);
  const first = needle.charCodeAt(0);
  const last = Math.min(to, hay.length) - n;
  let i = Math.max(0, from);
  while (i <= last) {
    i = hay.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    let ok = true;
    for (let k = 1; k < n; k++) {
      if (hay[i + k] !== needle.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
    i++;
  }
  return -1;
}

export function cleanText(s: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------------------------------------------------------------- formatting

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${n < 10240 ? (n / 1024).toFixed(1) : Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${n < 10485760 ? (n / 1048576).toFixed(1) : Math.round(n / 1048576)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  if (sec < 10) return `${sec.toFixed(2)} s`;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function fmtRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '?';
  return hz >= 1000 ? `${+(hz / 1000).toFixed(3)} kHz` : `${hz} Hz`;
}

export function fmtChannels(n: number): string {
  if (n === 1) return 'mono';
  if (n === 2) return 'stereo';
  return `${n} ch`;
}

export const fmtDims = (w: number, h: number): string => `${w}×${h}`;

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------- segments

export function seg(
  name: string,
  role: SegmentRole,
  offset: number,
  length: number,
  detail?: string,
  extra?: Partial<Pick<Segment, 'count' | 'children'>>,
): Segment {
  const s: Segment = { name, role, offset, length };
  if (detail) s.detail = detail;
  if (extra?.count !== undefined && extra.count > 1) s.count = extra.count;
  if (extra?.children && extra.children.length) s.children = extra.children;
  return s;
}

/**
 * Append, merging into the previous segment when it has the same name and role
 * and is byte-contiguous. Merged segments lose their children.
 */
export function pushMerged(list: Segment[], s: Segment): Segment {
  const last = list[list.length - 1];
  if (last && last.name === s.name && last.role === s.role && last.offset + last.length === s.offset) {
    last.length += s.length;
    last.count = (last.count ?? 1) + (s.count ?? 1);
    delete last.children;
    return last;
  }
  list.push(s);
  return s;
}

/** Push an 'unknown' segment covering [from, to). */
export function pushUnknown(list: Segment[], from: number, to: number, name = 'unparsed data', detail?: string): void {
  if (to > from) pushMerged(list, seg(name, 'unknown', from, to - from, detail));
}

/** Everything from `from` to EOF as 'unknown' (parser gave up or trailing bytes). */
export function restUnknown(ctx: Ctx, from: number, name = 'unparsed data', detail?: string): void {
  pushUnknown(ctx.out, from, ctx.r.size, name, detail);
}

// ---------------------------------------------------------------- finalize

function cleanName(s: unknown, max = 120): string {
  const t = typeof s === 'string' ? s : String(s ?? '');
  // eslint-disable-next-line no-control-regex
  const c = t.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return (c.length > max ? c.slice(0, max - 1) + '…' : c) || '?';
}

interface CleanState {
  nodes: number;
  capped: boolean;
}

function cleanList(list: readonly Segment[], lo: number, hi: number, depth: number, st: CleanState): Segment[] {
  let sorted = list;
  let ordered = true;
  for (let i = 1; i < list.length; i++) {
    if ((list[i]?.offset ?? 0) < (list[i - 1]?.offset ?? 0)) {
      ordered = false;
      break;
    }
  }
  if (!ordered) sorted = [...list].sort((a, b) => a.offset - b.offset || b.length - a.length);

  const out: Segment[] = [];
  let cursor = lo;
  for (const s of sorted) {
    if (!s) continue;
    let off = Math.floor(s.offset);
    let len = Math.floor(s.length);
    if (!Number.isFinite(off) || !Number.isFinite(len)) continue;
    if (off < cursor) {
      len -= cursor - off;
      off = cursor;
    }
    if (off + len > hi) len = hi - off;
    if (len <= 0) continue;
    if (st.nodes >= LIMITS.nodes || out.length >= LIMITS.list) {
      st.capped = true;
      // Lump everything that remains into one segment so the byte range is still accounted for.
      const at = sorted.indexOf(s);
      let lastEnd = off + len;
      for (let i = at; i < sorted.length; i++) {
        const x = sorted[i]!;
        const e = Math.min(hi, Math.floor(x.offset + x.length));
        if (Number.isFinite(e) && e > lastEnd) lastEnd = e;
      }
      const remaining = sorted.length - at;
      out.push({
        name: `… ${remaining.toLocaleString('en-US')} more`,
        role: 'unknown',
        offset: off,
        length: lastEnd - off,
        count: remaining,
      });
      return out;
    }
    st.nodes++;
    const role: SegmentRole = ROLES.has(s.role) ? s.role : 'unknown';
    const n: Segment = { name: cleanName(s.name), role, offset: off, length: len };
    if (s.detail) n.detail = cleanName(s.detail, 200);
    if (s.count !== undefined && s.count > 1) n.count = Math.floor(s.count);
    if (s.children && s.children.length) {
      if (depth < LIMITS.depth) {
        const kids = cleanList(s.children, off, off + len, depth + 1, st);
        if (kids.length) n.children = kids;
      }
    }
    out.push(n);
    cursor = off + len;
  }
  return out;
}

function fillGap(list: Segment[], from: number, to: number): void {
  // A few stray bytes between known structures are alignment, not unknown data.
  if (to - from < 4) pushMerged(list, seg('padding', 'padding', from, to - from));
  else pushUnknown(list, from, to);
}

/** Turn a parser's raw output into a validated FileStructure. */
export function finalize(ctx: Ctx, summaryFallback: string): FileStructure {
  const size = ctx.r.size;
  const st: CleanState = { nodes: 0, capped: false };
  const cleaned = cleanList(ctx.out, 0, size, 0, st);

  // Fill top-level gaps so the file is fully accounted for.
  const filled: Segment[] = [];
  let cursor = 0;
  for (const s of cleaned) {
    if (s.offset > cursor) {
      fillGap(filled, cursor, s.offset);
    }
    filled.push(s);
    cursor = s.offset + s.length;
  }
  if (cursor < size) fillGap(filled, cursor, size);

  // Re-cap after gap filling.
  let segments = filled;
  let capped = st.capped;
  if (segments.length > LIMITS.list) {
    const keep = segments.slice(0, LIMITS.list - 1);
    const tail = segments.slice(LIMITS.list - 1);
    const first = tail[0]!;
    const last = tail[tail.length - 1]!;
    keep.push({
      name: `… ${tail.length.toLocaleString('en-US')} more`,
      role: 'unknown',
      offset: first.offset,
      length: last.offset + last.length - first.offset,
      count: tail.length,
    });
    segments = keep;
    capped = true;
  }

  const result: FileStructure = {
    format: ctx.format,
    size,
    segments,
    summary: ctx.summary ? cleanName(ctx.summary, 240) : summaryFallback,
  };
  if (ctx.truncated || ctx.r.truncated || capped) result.truncated = true;
  return result;
}

export function newCtx(src: ByteSource, format: FormatId, budget?: number): Ctx {
  return { r: new Reader(src, budget), format, out: [], truncated: false };
}
