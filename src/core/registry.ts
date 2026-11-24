import type { EdgeSpec } from './types';
import { expandEdges, planRoutes, type Hop, type Route } from './graph';
import type { FormatId } from './formats';

/** Every engine's edges.ts, discovered at build time. Directory name = engine id. */
const modules = import.meta.glob<{ edges: EdgeSpec[] }>('../engines/*/edges.ts', { eager: true });

export const ALL_EDGES: EdgeSpec[] = Object.entries(modules).flatMap(([path, mod]) => {
  const engine = path.split('/').at(-2)!;
  return mod.edges.map((e) => ({ ...e, engine }));
});

export const ALL_HOPS: Hop[] = expandEdges(ALL_EDGES);

const cache = new Map<FormatId, Map<FormatId, Route>>();

export function routesFrom(from: FormatId): Map<FormatId, Route> {
  let r = cache.get(from);
  if (!r) {
    r = planRoutes(ALL_HOPS, from);
    cache.set(from, r);
  }
  return r;
}

export function readableFormats(): Set<FormatId> {
  return new Set(ALL_HOPS.map((h) => h.from));
}
