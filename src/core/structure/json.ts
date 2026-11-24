import type { Segment } from './types';
import { type Ctx, seg } from './util';
import { bomLength, decode, encodingOf, fmtN, groups, lineStarts, readText, tailBeyond } from './text';

const isWs = (c: number | undefined): boolean => c === 32 || c === 9 || c === 10 || c === 13;

interface Skipped {
  end: number;
  /** For containers: number of direct members. */
  count: number;
}

/** Byte classes the container scanner cares about: 1 quote, 2 opener, 3 closer, 4 comma. */
const CLASS = new Uint8Array(256);
CLASS[0x22] = 1;
CLASS[0x7b] = 2;
CLASS[0x5b] = 2;
CLASS[0x7d] = 3;
CLASS[0x5d] = 3;
CLASS[0x2c] = 4;

function skipString(b: Uint8Array, i: number): number {
  // b[i] === '"'
  let k = i + 1;
  const n = b.length;
  while (k < n) {
    const c = b[k];
    if (c === 0x5c) k += 2;
    else if (c === 0x22) return k + 1;
    else k++;
  }
  return -1;
}

/** Index just past the value starting at i (iterative: safe on absurdly nested input). */
function skipValue(b: Uint8Array, i: number): Skipped | undefined {
  const n = b.length;
  const c = b[i];
  if (c === 0x22) {
    const e = skipString(b, i);
    return e < 0 ? undefined : { end: e, count: 0 };
  }
  if (c === 0x7b || c === 0x5b) {
    const closers: number[] = [];
    let commas = 0;
    let k = i;
    while (k < n) {
      const d = b[k]!;
      const t = CLASS[d]!;
      if (t === 0) {
        k++;
        continue;
      }
      if (t === 1) {
        const e = skipString(b, k);
        if (e < 0) return undefined;
        k = e;
        continue;
      }
      if (t === 2) closers.push(d === 0x7b ? 0x7d : 0x5d);
      else if (t === 3) {
        if (closers.pop() !== d) return undefined;
        if (closers.length === 0) {
          let q = i + 1;
          while (q < k && isWs(b[q])) q++;
          return { end: k + 1, count: q === k ? 0 : commas + 1 };
        }
      } else if (closers.length === 1) commas++;
      k++;
    }
    return undefined;
  }
  // number / true / false / null
  let k = i;
  while (k < n) {
    const d = b[k]!;
    if (isWs(d) || d === 0x2c || d === 0x7d || d === 0x5d || d === 0x3a) break;
    k++;
  }
  return k > i ? { end: k, count: 0 } : undefined;
}

function describe(b: Uint8Array, start: number, sk: Skipped): string {
  const c = b[start];
  if (c === 0x7b) return `object · ${fmtN(sk.count)} key${sk.count === 1 ? '' : 's'}`;
  if (c === 0x5b) return `array · ${fmtN(sk.count)} item${sk.count === 1 ? '' : 's'}`;
  if (c === 0x22) return `string · ${fmtN(sk.end - start - 2)} B`;
  return decode(b, start, sk.end, 24);
}

interface Member {
  start: number; // member start (key start or element start)
  name: string;
  valueStart: number;
  value: Skipped;
}

/** Direct members of the container at `start` (b[start] is '{' or '['). */
function members(b: Uint8Array, start: number, end: number, limit: number): { list: Member[]; ok: boolean } {
  const isObj = b[start] === 0x7b;
  const list: Member[] = [];
  let i = start + 1;
  let idx = 0;
  while (i < end && list.length < limit) {
    while (i < end && (isWs(b[i]) || b[i] === 0x2c)) i++;
    if (i >= end || b[i] === 0x7d || b[i] === 0x5d) break;
    const mStart = i;
    let name = `[${idx}]`;
    if (isObj) {
      if (b[i] !== 0x22) return { list, ok: false };
      const ke = skipString(b, i);
      if (ke < 0) return { list, ok: false };
      name = decode(b, i + 1, ke - 1, 48) || '""';
      i = ke;
      while (i < end && isWs(b[i])) i++;
      if (b[i] !== 0x3a) return { list, ok: false };
      i++;
      while (i < end && isWs(b[i])) i++;
    }
    const v = skipValue(b, i);
    if (!v) return { list, ok: false };
    list.push({ start: mStart, name, valueStart: i, value: v });
    i = v.end;
    idx++;
  }
  return { list, ok: true };
}

function memberSegments(b: Uint8Array, list: Member[], from: number, to: number, depth: number): Segment[] {
  const out: Segment[] = [];
  const isObjMember = list.length > 0 && !/^\[\d+\]$/.test(list[0]!.name);
  const make = (i0: number, i1: number): Segment => {
    const first = list[i0]!;
    const s0 = i0 === 0 ? from : first.start;
    const e0 = i1 < list.length ? list[i1]!.start : to;
    const n = i1 - i0;
    const m = first;
    if (n === 1) {
      let children: Segment[] | undefined;
      const c = b[m.valueStart];
      if (depth < 3 && (c === 0x7b || c === 0x5b) && m.value.count > 0) {
        const inner = members(b, m.valueStart, m.value.end, 500);
        if (inner.list.length) children = memberSegments(b, inner.list, m.valueStart, m.value.end, depth + 1);
      }
      return seg(m.name, 'records', s0, e0 - s0, describe(b, m.valueStart, m.value), { children });
    }
    const last = list[i1 - 1]!;
    return seg(isObjMember ? `keys ${first.name} … ${last.name}` : `items ${i0}–${i1 - 1}`, 'records', s0, e0 - s0, `${fmtN(n)} ${isObjMember ? 'keys' : 'items'}`, { count: n });
  };
  for (const [g0, g1] of groups(list.length, 500)) out.push(make(g0, g1));
  return out;
}

export async function parseJson(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  if (b.length === 0) return;
  let i = bomLength(b) === 3 ? 3 : 0;
  while (i < b.length && isWs(b[i])) i++;
  const rootStart = i;
  const root = skipValue(b, i);
  const enc = encodingOf(b);
  const startsContainer = b[i] === 0x7b || b[i] === 0x5b;
  if (!startsContainer) {
    // A bare scalar, or invalid from the very first token.
    if (root) ctx.out.push(seg('value', 'records', 0, b.length, describe(b, i, root)));
    ctx.summary = root ? `JSON scalar · ${enc}` : 'JSON · invalid at the first value';
    tailBeyond(ctx, b.length);
    return;
  }
  if (!root) {
    // Unbalanced or damaged: keep every member that parsed, then flag the rest.
    const part = members(b, rootStart, b.length, 200_000);
    if (part.list.length) {
      const lastEnd = part.list[part.list.length - 1]!.value.end;
      ctx.out.push(...memberSegments(b, part.list, 0, lastEnd, 0));
      ctx.out.push(seg('invalid JSON', 'unknown', lastEnd, b.length - lastEnd, `parse error after byte ${lastEnd.toLocaleString('en-US')}`));
      ctx.summary = `JSON · damaged after byte ${lastEnd.toLocaleString('en-US')} · ${fmtN(part.list.length)} member${part.list.length === 1 ? '' : 's'} recovered`;
    } else {
      ctx.summary = 'JSON · invalid at the first value';
    }
    tailBeyond(ctx, b.length);
    return;
  }
  // Anything after the root that looks like another value means JSON Lines.
  let after = root.end;
  while (after < b.length && isWs(b[after])) after++;
  if (after < b.length && (b[after] === 0x7b || b[after] === 0x5b)) {
    const starts = lineStarts(b);
    const nonEmpty = starts;
    const per = groups(nonEmpty.length, 64);
    for (const [g0, g1] of per) {
      const from = nonEmpty[g0]!;
      const to = g1 < nonEmpty.length ? nonEmpty[g1]! : b.length;
      const n = g1 - g0;
      ctx.out.push(seg(n === 1 ? `record ${g0 + 1}` : `records ${g0 + 1}–${g1}`, 'records', from, to - from, `${fmtN(n)} JSON line${n === 1 ? '' : 's'}`, { count: n }));
    }
    tailBeyond(ctx, b.length);
    ctx.summary = `JSON Lines · ${fmtN(starts.length)} records · ${enc}`;
    return;
  }

  const inner = members(b, rootStart, root.end, 200_000);
  if (inner.ok || !inner.list.length) {
    ctx.out.push(...memberSegments(b, inner.list, 0, b.length, 0));
    if (!inner.list.length) ctx.out.push(seg(b[rootStart] === 0x7b ? 'empty object' : 'empty array', 'records', 0, b.length));
  } else {
    const lastEnd = inner.list[inner.list.length - 1]!.value.end;
    ctx.out.push(...memberSegments(b, inner.list, 0, lastEnd, 0));
    ctx.out.push(seg('invalid JSON', 'unknown', lastEnd, b.length - lastEnd, `parse error after byte ${lastEnd.toLocaleString('en-US')}`));
  }
  tailBeyond(ctx, b.length);
  const kind = b[rootStart] === 0x7b ? `object · ${fmtN(root.count)} key${root.count === 1 ? '' : 's'}` : `array · ${fmtN(root.count)} item${root.count === 1 ? '' : 's'}`;
  ctx.summary = `JSON ${kind} · ${enc}`;
}
