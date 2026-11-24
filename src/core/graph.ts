import type { FormatId } from './formats';
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
 * Cheapest routes from one source format to every reachable target.
 * Fidelity is part of the cost so a lossless two-hop route can beat a lossy
 * one-hop route, and a route never passes through a bundling (ZIP) hop
 * except as its final step.
 */
export function planRoutes(hops: readonly Hop[], from: FormatId): Map<FormatId, Route> {
  const out = new Map<FormatId, Hop[]>();
  for (const h of hops) {
    const list = out.get(h.from);
    if (list) list.push(h);
    else out.set(h.from, [h]);
  }

  interface State {
    at: FormatId;
    path: Hop[];
    cost: number;
  }
  const weight = (h: Hop) => h.cost + FIDELITY_RANK[h.fidelity] * 4 + 0.5;
  const best = new Map<FormatId, State>();
  const queue: State[] = [{ at: from, path: [], cost: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift()!;
    if (cur.at !== from) {
      const prev = best.get(cur.at);
      if (prev && prev.cost <= cur.cost) continue;
      best.set(cur.at, cur);
    }
    if (cur.path.length >= MAX_HOPS) continue;
    const last = cur.path[cur.path.length - 1];
    if (last?.mayBundle) continue; // bundling hops are terminal
    for (const h of out.get(cur.at) ?? []) {
      if (h.to === from || cur.path.some((p) => p.from === h.to)) continue;
      const cost = cur.cost + weight(h);
      const known = best.get(h.to);
      if (known && known.cost <= cost) continue;
      queue.push({ at: h.to, path: [...cur.path, h], cost });
    }
  }

  const routes = new Map<FormatId, Route>();
  for (const [to, s] of best) {
    routes.set(to, {
      from,
      to,
      hops: s.path,
      cost: s.cost,
      fidelity: s.path.reduce<Fidelity>((acc, h) => worst(acc, h.fidelity), 'lossless'),
      notes: s.path.map((h) => h.note).filter((n): n is string => !!n),
    });
  }
  return routes;
}
