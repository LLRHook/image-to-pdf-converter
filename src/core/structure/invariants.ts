import type { FileStructure, Segment } from './types';

const ROLES = new Set(['signature', 'header', 'metadata', 'index', 'palette', 'pixels', 'samples', 'text', 'style', 'media', 'records', 'container', 'padding', 'trailer', 'unknown']);

/**
 * Structural sanity rules every FileStructure must satisfy. Returns human-readable
 * violations (empty array = valid). Used by the tests and fuzzers.
 */
export function structureViolations(st: FileStructure, expectedSize?: number): string[] {
  const bad: string[] = [];
  if (expectedSize !== undefined && st.size !== expectedSize) bad.push(`size ${st.size} != ${expectedSize}`);
  if (typeof st.summary !== 'string' || st.summary.length === 0) bad.push('missing summary');
  if (st.segments.length > 2000) bad.push(`top level has ${st.segments.length} segments`);
  let nodes = 0;
  const walk = (list: Segment[], lo: number, hi: number, depth: number, path: string): void => {
    let cursor = lo;
    list.forEach((s, i) => {
      nodes++;
      const at = `${path}/${i}:${s.name}`;
      if (typeof s.name !== 'string' || s.name.length === 0) bad.push(`${at} empty name`);
      if (!ROLES.has(s.role)) bad.push(`${at} bad role ${s.role}`);
      if (!Number.isInteger(s.offset) || !Number.isInteger(s.length)) bad.push(`${at} non-integer range ${s.offset}+${s.length}`);
      if (s.offset < cursor) bad.push(`${at} overlaps/out of order: offset ${s.offset} < ${cursor}`);
      if (s.length <= 0) bad.push(`${at} non-positive length ${s.length}`);
      if (s.offset + s.length > hi) bad.push(`${at} ends at ${s.offset + s.length} > parent end ${hi}`);
      if (s.count !== undefined && !(s.count >= 2)) bad.push(`${at} count ${s.count}`);
      cursor = s.offset + s.length;
      if (s.children) {
        if (depth >= 4) bad.push(`${at} deeper than 4 child levels`);
        if (s.children.length === 0) bad.push(`${at} empty children array`);
        walk(s.children, s.offset, s.offset + s.length, depth + 1, at);
      }
    });
  };
  walk(st.segments, 0, st.size, 0, '');
  // Top level covers the whole file.
  let cover = 0;
  for (const s of st.segments) cover += s.length;
  if (st.size > 0 && cover !== st.size) bad.push(`top level covers ${cover} of ${st.size} bytes`);
  if (nodes > 20_000) bad.push(`${nodes} nodes`);
  return bad;
}

export function flatten(list: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of list) {
    out.push(s);
    if (s.children) out.push(...flatten(s.children));
  }
  return out;
}

export function findSegment(st: FileStructure, name: string): Segment | undefined {
  return flatten(st.segments).find((s) => s.name === name);
}

export function findAll(st: FileStructure, name: string): Segment[] {
  return flatten(st.segments).filter((s) => s.name === name);
}
