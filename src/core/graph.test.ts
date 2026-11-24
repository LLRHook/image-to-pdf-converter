import { describe, expect, it } from 'vitest';
import { expandEdges, planRoutes } from './graph';
import type { EdgeSpec } from './types';

const st = () => [{ id: 'decode' as const, label: 'd' }, { id: 'encode' as const, label: 'e' }];

const specs: EdgeSpec[] = [
  { engine: 'raster', from: ['png', 'jpg', 'webp'], to: ['png', 'jpg', 'webp', 'pdf'], cost: 3, fidelity: (_f, t) => (t === 'jpg' ? 'lossy' : 'lossless'), stages: st },
  { engine: 'svg', from: ['svg'], to: ['png'], cost: 2, fidelity: 'raster', stages: st },
  { engine: 'pdf', from: ['pdf'], to: ['png', 'txt'], cost: 4, fidelity: 'raster', stages: st, mayBundle: true },
  { engine: 'cheapjpg', from: ['png'], to: ['jpg'], cost: 1, fidelity: 'lossy', stages: st },
];

describe('planRoutes', () => {
  const hops = expandEdges(specs);

  it('skips identity edges', () => {
    expect(hops.some((h) => h.from === h.to)).toBe(false);
  });

  it('chains through an intermediate format', () => {
    const r = planRoutes(hops, 'svg').get('jpg')!;
    expect(r.hops.map((h) => `${h.engine}:${h.from}->${h.to}`)).toEqual(['svg:svg->png', 'cheapjpg:png->jpg']);
    expect(r.fidelity).toBe('raster');
  });

  it('prefers the cheapest engine for a direct pair', () => {
    expect(planRoutes(hops, 'png').get('jpg')!.hops[0]!.engine).toBe('cheapjpg');
  });

  it('never continues after a bundling hop', () => {
    const routes = planRoutes(hops, 'pdf');
    expect(routes.get('png')).toBeDefined();
    expect(routes.get('jpg')).toBeUndefined(); // would need pdf->png(bundle)->jpg
  });

  it('refuses meaningless cross-family chains', () => {
    const chain: EdgeSpec[] = [
      { engine: 'img', from: ['heic'], to: ['gif', 'pdf', 'png'], cost: 1, fidelity: 'lossy', stages: st },
      { engine: 'vid', from: ['gif'], to: ['mp4'], cost: 1, fidelity: 'lossy', stages: st },
      { engine: 'aud', from: ['mp4'], to: ['wav'], cost: 1, fidelity: 'lossless', stages: st },
      { engine: 'txt', from: ['pdf'], to: ['txt', 'svg'], cost: 1, fidelity: 'semantic', stages: st },
      { engine: 'typ', from: ['docx'], to: ['pdf'], cost: 1, fidelity: 'semantic', stages: st },
      { engine: 'ras', from: ['pdf'], to: ['png'], cost: 1, fidelity: 'raster', stages: st },
    ];
    const h = expandEdges(chain);
    const fromHeic = planRoutes(h, 'heic');
    expect([...fromHeic.keys()].sort()).toEqual(['gif', 'pdf', 'png']);
    expect(planRoutes(h, 'gif').has('mp4')).toBe(true); // animated GIF -> video is sensible
    expect(planRoutes(h, 'gif').has('wav')).toBe(false);
    expect(planRoutes(h, 'docx').get('png')?.hops.map((x) => x.engine)).toEqual(['typ', 'ras']); // render pages
    expect(planRoutes(h, 'mp4').has('wav')).toBe(true); // extract soundtrack
  });

  it('weights fidelity so lossless routes beat lossy shortcuts', () => {
    const lossless: EdgeSpec[] = [
      { engine: 'a', from: ['wav'], to: ['flac'], cost: 2, fidelity: 'lossless', stages: st },
      { engine: 'b', from: ['flac'], to: ['ogg'], cost: 2, fidelity: 'lossless', stages: st },
      { engine: 'c', from: ['wav'], to: ['ogg'], cost: 2, fidelity: 'raster', stages: st },
    ];
    const r = planRoutes(expandEdges(lossless), 'wav').get('ogg')!;
    expect(r.hops.map((h) => h.engine)).toEqual(['a', 'b']);
  });
});
