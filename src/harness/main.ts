/**
 * Dev-only browser harness (served by `vite` at /harness.html, never built).
 * Playwright drives real engines in real Workers through it:
 *
 *   await page.goto('/harness.html');
 *   const r = await page.evaluate(([b64]) => window.harness.convert({ from: 'png', to: 'webp', base64: b64 }), [b64]);
 *
 * convert() plans the cheapest route exactly like the app does (or runs one
 * engine directly with `engine`), returns the output as base64 plus every
 * runner event so tests can assert stages, progress, facts and fallbacks.
 */
import { routesFrom, ALL_HOPS } from '../core/registry';
import { runRoute, type RunEvent } from '../core/runner';
import type { FormatId } from '../core/formats';
import type { Route } from '../core/graph';

interface ConvertArgs {
  from: FormatId;
  to: FormatId;
  base64?: string;
  url?: string;
  name?: string;
  engine?: string;
  options?: Record<string, unknown>;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function convert(a: ConvertArgs) {
  const bytes = a.base64 ? fromB64(a.base64) : new Uint8Array(await (await fetch(a.url!)).arrayBuffer());
  let route: Route | undefined;
  if (a.engine) {
    const hop = ALL_HOPS.find((h) => h.engine === a.engine && h.from === a.from && h.to === a.to);
    if (!hop) throw new Error(`engine ${a.engine} has no edge ${a.from}->${a.to}`);
    route = { from: a.from, to: a.to, hops: [hop], cost: hop.cost, fidelity: hop.fidelity, notes: [] };
  } else {
    route = routesFrom(a.from).get(a.to);
    if (!route) throw new Error(`no route ${a.from}->${a.to}`);
  }
  const events: RunEvent[] = [];
  const alternatives = (h: (typeof route.hops)[number]) =>
    ALL_HOPS.filter((x) => x.from === h.from && x.to === h.to && x.engine !== h.engine).sort((p, q) => p.cost - q.cost);
  const handle = runRoute(route, new Blob([bytes]), a.name ?? `input.${a.from}`, (e) => events.push(e), {
    options: a.options,
    alternatives: a.engine ? undefined : alternatives,
  });
  try {
    const res = await handle.done;
    const out = new Uint8Array(await res.blob.arrayBuffer());
    return {
      ok: true as const,
      route: route.hops.map((h) => `${h.engine}:${h.from}->${h.to}`),
      name: res.name,
      ext: res.ext,
      mime: res.mime,
      bundle: res.bundle,
      size: out.byteLength,
      base64: toB64(out),
      events: events.map((e) => (e.type === 'done' ? { type: 'done' } : e)),
    };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message, events };
  }
}

function routes(from: FormatId) {
  return [...routesFrom(from).values()].map((r) => ({ to: r.to, hops: r.hops.map((h) => `${h.engine}:${h.from}->${h.to}`), fidelity: r.fidelity }));
}

declare global {
  interface Window {
    harness: { convert: typeof convert; routes: typeof routes; ready: true };
  }
}
window.harness = { convert, routes, ready: true };
document.getElementById('log')!.textContent = 'ready';
