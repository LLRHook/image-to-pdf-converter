/**
 * Generic walks over decoded data: facts (nodes, depth), safety checks (depth,
 * size, cycles, values JSON cannot hold) and the preview outline. All
 * iterative so hostile nesting cannot overflow the stack.
 */
import { fmtN } from '../../core/structure/text';
import { truncate } from '../pandoc/text';

export const LIMITS = {
  inputBytes: 64 * 1024 * 1024,
  depth: 256,
  nodes: 10_000_000,
  yamlAliasCount: 1000,
  yamlDocuments: 10_000,
} as const;

export type Json = unknown;

export const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface TreeStats {
  nodes: number;
  /** Levels of nodes: a bare scalar is 1, {a:1} is 2. */
  depth: number;
  /** Integers beyond +-2^53 (they lose precision in any JavaScript number). */
  unsafeInts: number;
}

/** Validate and measure. Throws a readable error for anything that cannot be converted safely. */
export function analyze(root: Json): TreeStats {
  let nodes = 0;
  let depth = 0;
  let unsafeInts = 0;
  const ancestors = new Set<object>();
  const exitTargets: object[] = [];
  const EXIT = Symbol('exit');
  // Values with a parallel level stack; EXIT sentinels pop `ancestors` when a container is finished.
  const stack: Array<Json | typeof EXIT> = [root];
  const levels: number[] = [1];
  while (stack.length) {
    const v = stack.pop();
    const level = levels.pop()!;
    if (v === EXIT) {
      ancestors.delete(exitTargets.pop()!);
      continue;
    }
    nodes++;
    if (nodes > LIMITS.nodes) throw new Error(`The data has more than ${fmtN(LIMITS.nodes)} values, which is too large to convert in the browser.`);
    if (level > depth) depth = level;
    if (depth > LIMITS.depth) throw new Error(`The data is nested more than ${LIMITS.depth} levels deep, which is not supported.`);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new Error(`The data contains ${Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity'}, which JSON, YAML and XML tools cannot exchange as a number.`);
      }
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) unsafeInts++;
    } else if (typeof v === 'bigint') {
      unsafeInts++;
    } else if (typeof v === 'object' && v !== null) {
      if (ancestors.has(v)) throw new Error('The data refers back to itself (a circular YAML alias), which cannot be written out.');
      ancestors.add(v);
      exitTargets.push(v);
      stack.push(EXIT);
      levels.push(level);
      const children = Array.isArray(v) ? v : Object.values(v);
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
        levels.push(level + 1);
      }
    }
  }
  return { nodes, depth, unsafeInts };
}
/* ----------------------------------------------------------------- outline */

function describe(key: string | null, v: Json): string {
  const prefix = key === null ? '' : `${key}`;
  if (Array.isArray(v)) return `${prefix}${prefix ? ' ' : ''}[${fmtN(v.length)} ${v.length === 1 ? 'item' : 'items'}]`;
  if (isObj(v)) {
    const n = Object.keys(v).length;
    return `${prefix}${prefix ? ' ' : ''}{${fmtN(n)} ${n === 1 ? 'key' : 'keys'}}`;
  }
  const text = v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v);
  return prefix ? `${prefix}: ${text}` : text;
}

export interface OutlineItem {
  level: number;
  text: string;
}

/** First ~40 entries, three levels deep: top-level keys / root children, then their children. */
export function outline(root: Json, max = 40): OutlineItem[] {
  const out: OutlineItem[] = [];
  const entries = (v: Json): Array<[string | null, Json]> =>
    Array.isArray(v) ? v.map((x, i) => [`[${i}]`, x]) : isObj(v) ? Object.entries(v) : [];
  const visit = (key: string | null, v: Json, level: number, breadth: number) => {
    if (out.length >= max) return;
    out.push({ level, text: truncate(describe(key, v), 80) });
    if (level >= 2) return;
    const kids = entries(v);
    for (let i = 0; i < kids.length && i < breadth; i++) visit(kids[i]![0], kids[i]![1], level + 1, 4);
  };
  if (Array.isArray(root) || isObj(root)) {
    const top = entries(root);
    for (let i = 0; i < top.length && i < 12; i++) visit(top[i]![0], top[i]![1], 0, 4);
    if (top.length > 12 && out.length < max) out.push({ level: 0, text: `… ${fmtN(top.length - 12)} more` });
  } else {
    visit(null, root, 0, 0);
  }
  return out.slice(0, max);
}
