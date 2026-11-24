import { describe, expect, it } from 'vitest';
import { initialState, reduce } from './model';
import type { Route } from '../core/graph';

const route: Route = {
  from: 'png',
  to: 'jpg',
  cost: 1,
  fidelity: 'lossy',
  notes: [],
  hops: [
    {
      engine: 'magick',
      from: 'png',
      to: 'jpg',
      fidelity: 'lossy',
      cost: 1,
      mayBundle: false,
      stages: [
        { id: 'load', label: 'Load' },
        { id: 'decode', label: 'Decode PNG' },
        { id: 'encode', label: 'Encode JPEG' },
      ],
    },
  ],
};

const input = { name: 'a.png', format: 'png' as const, size: 100, structure: null };
const none = () => undefined;

describe('viz model', () => {
  it('tracks stages only from real events and keeps unmeasured progress null', () => {
    let s = initialState(input, route, 0);
    s = reduce(s, { type: 'hop-start', hop: 0, engine: 'magick', from: 'png', to: 'jpg', at: 1 }, none);
    s = reduce(s, { type: 'stage', hop: 0, stage: 'load', at: 2 }, none);
    s = reduce(s, { type: 'stage', hop: 0, stage: 'decode', at: 5 }, none);
    const [load, decode, encode] = s.hops[0]!.stages;
    expect(load).toMatchObject({ status: 'done', startedAt: 2, endedAt: 5, progress: null });
    expect(decode).toMatchObject({ status: 'active', startedAt: 5, progress: null });
    expect(encode!.status).toBe('pending');
    s = reduce(s, { type: 'progress', hop: 0, value: 0.4, at: 6 }, none);
    expect(s.hops[0]!.stages[1]!.progress).toBe(0.4);
  });

  it('marks skipped declared stages done and surfaces undeclared ones', () => {
    let s = initialState(input, route, 0);
    s = reduce(s, { type: 'stage', hop: 0, stage: 'encode', at: 3 }, none);
    expect(s.hops[0]!.stages.map((x) => x.status)).toEqual(['done', 'done', 'active']);
    s = reduce(s, { type: 'stage', hop: 0, stage: 'package', at: 4 }, none);
    expect(s.hops[0]!.stages.at(-1)).toMatchObject({ id: 'package', status: 'active' });
  });

  it('swaps in the fallback engine stages', () => {
    let s = initialState(input, route, 0);
    s = reduce(s, { type: 'stage', hop: 0, stage: 'load', at: 1 }, none);
    s = reduce(
      s,
      { type: 'fallback', hop: 0, fromEngine: 'magick', toEngine: 'other', reason: 'no codec', at: 2 },
      () => ({ ...route.hops[0]!, engine: 'other', stages: [{ id: 'transform', label: 'Other' }] }),
    );
    expect(s.hops[0]!.engine).toBe('other');
    expect(s.hops[0]!.stages.map((x) => x.label)).toEqual(['Other']);
    expect(s.hops[0]!.fallbacks).toEqual([{ fromEngine: 'magick', reason: 'no codec' }]);
  });

  it('labels the output with the format really produced, ZIP for a bundle', () => {
    let s = initialState(input, route, 0);
    const blob = new Blob([new Uint8Array(10)]);
    s = reduce(s, { type: 'done', result: { blob, name: 'a.zip', format: 'zip', mime: 'application/zip', ext: 'zip', bundle: { count: 2, ext: 'jpg' } }, at: 5 }, none);
    expect(s.output).toMatchObject({ name: 'a.zip', format: 'zip', size: 10 });
  });

  it('does not mutate the previous state', () => {
    const a = initialState(input, route, 0);
    const b = reduce(a, { type: 'stage', hop: 0, stage: 'load', at: 1 }, none);
    expect(a.hops[0]!.stages[0]!.status).toBe('pending');
    expect(b.hops[0]!.stages[0]!.status).toBe('active');
  });
});
