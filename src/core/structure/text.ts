import type { Segment } from './types';
import { type Ctx, EMPTY, cleanText, fmtBytes, seg, utf8 } from './util';

/** Read the whole file (up to the budget). Anything beyond is reported by tailBeyond(). */
export async function readText(ctx: Ctx): Promise<Uint8Array> {
  const { r } = ctx;
  if (r.size === 0) return EMPTY;
  const want = Math.min(r.size, r.budget);
  const b = await r.readUpTo(0, want);
  if (b.length < r.size) ctx.truncated = true;
  return b;
}

/** Add an 'unknown' segment for bytes the text parser did not read (file bigger than the read cap). */
export function tailBeyond(ctx: Ctx, readLen: number): void {
  if (readLen < ctx.r.size) ctx.out.push(seg('beyond read limit', 'unknown', readLen, ctx.r.size - readLen, `${fmtBytes(ctx.r.size - readLen)} not read (limit ${fmtBytes(ctx.r.budget)})`));
}

export function bomLength(b: Uint8Array): number {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 3;
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return 2;
  return 0;
}

export function encodingOf(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'UTF-8 (BOM)';
  if (b[0] === 0xff && b[1] === 0xfe) return 'UTF-16 LE';
  if (b[0] === 0xfe && b[1] === 0xff) return 'UTF-16 BE';
  let ascii = true;
  for (let i = 0; i < b.length && i < 1 << 20; i++) {
    if ((b[i] ?? 0) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return 'ASCII';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, Math.min(b.length, 1 << 20)));
    return 'UTF-8';
  } catch {
    return 'non-UTF-8 (8-bit)';
  }
}

/** Byte offsets where each line starts (\n, \r\n and lone \r all end a line). */
export function lineStarts(b: Uint8Array): number[] {
  const starts: number[] = [];
  if (b.length === 0) return starts;
  starts.push(0);
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 10) {
      if (i + 1 < b.length) starts.push(i + 1);
    } else if (c === 13) {
      if (b[i + 1] === 10) i++;
      if (i + 1 < b.length) starts.push(i + 1);
    }
  }
  return starts;
}

export function isBlankLine(b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = b[i];
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}

export function countWords(b: Uint8Array, from: number, to: number): number {
  let words = 0;
  let inWord = false;
  for (let i = from; i < to; i++) {
    const c = b[i] ?? 0;
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0xa0;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}

/** Bytes from..to as one clean line of at most `max` characters (reads at most 4 bytes per character). */
export function decode(b: Uint8Array, from: number, to: number, max = 60): string {
  return cleanText(utf8(b.subarray(from, Math.min(to, from + max * 4))), max);
}

/** Split `n` units into at most `max` contiguous groups: returns [firstIndex, lastIndexExclusive] pairs. */
export function groups(n: number, max: number): Array<[number, number]> {
  if (n <= 0) return [];
  const per = Math.ceil(n / max);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i += per) out.push([i, Math.min(n, i + per)]);
  return out;
}

export const fmtN = (n: number): string => n.toLocaleString('en-US');

/** Segments for `unitStarts` (byte offsets of consecutive units) grouped into ≤ max buckets. */
export function bucketSegments(
  unitStarts: number[],
  end: number,
  max: number,
  label: string,
  role: Segment['role'],
  detailFor: (i0: number, i1: number, from: number, to: number) => string | undefined,
  first = 0,
): Segment[] {
  const out: Segment[] = [];
  for (const [i0, i1] of groups(unitStarts.length, max)) {
    const from = unitStarts[i0]!;
    const to = i1 < unitStarts.length ? unitStarts[i1]! : end;
    const n = i1 - i0;
    const name = n === 1 ? `${label} ${first + i0 + 1}` : `${label}s ${first + i0 + 1}–${first + i1}`;
    out.push(seg(name, role, from, to - from, detailFor(i0, i1, from, to), { count: n }));
  }
  return out;
}

export interface Heading {
  level: number;
  start: number;
  name: string;
}

/**
 * Nest headings into a section tree: a section runs from its heading to the next heading of the same
 * or a shallower level. `describe` fills in the detail once the section's byte range is known.
 */
export function buildSections(
  heads: Heading[],
  end: number,
  role: Segment['role'],
  describe: (from: number, to: number, children: number) => string | undefined,
): Segment[] {
  const top: Segment[] = [];
  const stack: Array<{ level: number; seg: Segment; kids: Segment[] }> = [];
  const close = (to: number): void => {
    const e = stack.pop()!;
    e.seg.length = Math.max(0, to - e.seg.offset);
    e.seg.detail = describe(e.seg.offset, to, e.kids.length);
    if (e.kids.length) e.seg.children = e.kids;
  };
  for (const h of heads) {
    while (stack.length && stack[stack.length - 1]!.level >= h.level) close(h.start);
    const s = seg(h.name, role, h.start, 0);
    const kids: Segment[] = [];
    (stack.length ? stack[stack.length - 1]!.kids : top).push(s);
    stack.push({ level: h.level, seg: s, kids });
  }
  while (stack.length) close(end);
  return top;
}
