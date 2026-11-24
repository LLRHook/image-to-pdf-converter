import { formatInfo, type FormatId } from './formats';
import type { EdgeSpec, Fidelity, StageSpec } from './types';

/** One conversion step run by one engine in one worker. */
export interface Hop {
  engine: string;
  from: FormatId;
  to: FormatId;
  fidelity: Fidelity;
  stages: StageSpec[];
  note?: string;
  mayBundle: boolean;
  cost: number;
}

export interface Route {
  from: FormatId;
  to: FormatId;
  hops: Hop[];
  cost: number;
  /** Worst fidelity along the route. */
  fidelity: Fidelity;
  notes: string[];
}

const FIDELITY_RANK: Record<Fidelity, number> = { lossless: 0, lossy: 1, semantic: 2, raster: 3 };
const MAX_HOPS = 3;

function worst(a: Fidelity, b: Fidelity): Fidelity {
  return FIDELITY_RANK[a] >= FIDELITY_RANK[b] ? a : b;
}

/** Expand edge specs into concrete from->to hops. */
export function expandEdges(specs: readonly EdgeSpec[]): Hop[] {
  const hops: Hop[] = [];
  for (const spec of specs) {
    if (!spec.engine) throw new Error('EdgeSpec without engine id');
    for (const from of spec.from) {
      for (const to of spec.to) {
        if (from === to || spec.exclude?.(from, to)) continue;
        hops.push({
          engine: spec.engine,
          from,
          to,
          fidelity: typeof spec.fidelity === 'function' ? spec.fidelity(from, to) : spec.fidelity,
          stages: spec.stages(from, to),
          note: spec.note?.(from, to),
          mayBundle: spec.mayBundle ?? false,
          cost: spec.cost,
        });
      }
    }
  }
  return hops;
}

/**
 * Whether converting `from` into `to` makes sense at all, regardless of how
 * many engines it would take. Without this, chaining finds technically valid
 * but meaningless routes (a photo -> GIF -> MP4 -> WAV, or an image -> PDF ->
 * text extraction that can only return nothing).
 *
 * 'direct' means: allowed only when one engine does it in a single hop.
 */
export function transitionAllowed(from: FormatId, to: FormatId): boolean | 'direct' {
  const a = formatInfo(from).family;
  const b = formatInfo(to).family;
  if (a === b) return a !== 'archive';
  if (b === 'archive' || a === 'archive') return false;
  if (a === 'image' && b === 'document') return to === 'pdf'; // images become PDF pages
  if (a === 'document' && b === 'image') return true; // render pages to images
  if (a === 'video' && b === 'audio') return true; // extract the soundtrack
  if (a === 'video' && b === 'image') return to === 'gif'; // animated GIF
  if (a === 'image' && b === 'video') return from === 'gif'; // animated GIF to video
  if ((a === 'data' && b === 'document') || (a === 'document' && b === 'data')) return 'direct';
  return false;
}

/**
 * Cheapest sensible route from one source format to every reachable target.
 * Fidelity is part of the cost so a lossless two-hop route can beat a lossy
 * one-hop route. A route never passes through a bundling (ZIP) hop except as
 * its final step, and only passes through formats of the source's or the
 * target's family.
 */
export function planRoutes(hops: readonly Hop[], from: FormatId): Map<FormatId, Route> {
  const out = new Map<FormatId, Hop[]>();
  for (const h of hops) {
    const list = out.get(h.from);
    if (list) list.push(h);
    else out.set(h.from, [h]);
  }
  const targets = new Set(hops.map((h) => h.to));
  const routes = new Map<FormatId, Route>();
  for (const to of targets) {
    if (to === from) continue;
    const allowed = transitionAllowed(from, to);
    if (!allowed) continue;
    const families = new Set([formatInfo(from).family, formatInfo(to).family]);
    const path = cheapestPath(out, from, to, allowed === 'direct' ? 1 : MAX_HOPS, (f) => families.has(formatInfo(f).family));
    if (!path) continue;
    routes.set(to, {
      from,
      to,
      hops: path.hops,
      cost: path.cost,
      fidelity: path.hops.reduce<Fidelity>((acc, h) => worst(acc, h.fidelity), 'lossless'),
      notes: path.hops.map((h) => h.note).filter((n): n is string => !!n),
    });
  }
  return routes;
}

function cheapestPath(
  out: Map<FormatId, Hop[]>,
  from: FormatId,
  to: FormatId,
  maxHops: number,
  passable: (f: FormatId) => boolean,
): { hops: Hop[]; cost: number } | null {
  interface State {
    at: FormatId;
    path: Hop[];
    cost: number;
  }
  const weight = (h: Hop) => h.cost + FIDELITY_RANK[h.fidelity] * 4 + 0.5;
  const settled = new Set<string>();
  const queue: State[] = [{ at: from, path: [], cost: 0 }];
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift()!;
    if (cur.at === to) return { hops: cur.path, cost: cur.cost };
    // Settle per (format, hop count) so a cheaper but longer path cannot
    // block a shorter one that still fits under maxHops.
    const key = `${cur.at}#${cur.path.length}`;
    if (settled.has(key)) continue;
    settled.add(key);
    if (cur.path.length >= maxHops) continue;
    if (cur.path.at(-1)?.mayBundle) continue; // bundling hops are terminal
    for (const h of out.get(cur.at) ?? []) {
      if (h.to !== to && (!passable(h.to) || h.mayBundle)) continue;
      if (h.to === from || cur.path.some((p) => p.from === h.to)) continue;
      queue.push({ at: h.to, path: [...cur.path, h], cost: cur.cost + weight(h) });
    }
  }
  return null;
}
