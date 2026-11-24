import { describe, expect, it } from 'vitest';
import { FORMATS, type FormatId } from '../formats';
import { parseStructure } from './index';
import { structureViolations } from './invariants';
import { SAMPLES, buildXls, concat, fixture, rng, utf8 } from './testkit';
import { bytesSource } from './types';

/** Extra seed files per format so mutations start from several valid layouts. */
const EXTRA: Record<string, () => Uint8Array[]> = {
  png: () => [fixture('indexed.png')],
  jpg: () => [fixture('progressive.jpg'), fixture('sips.jpg')],
  webp: () => [fixture('lossless.webp'), fixture('alpha.webp'), fixture('anim.webp')],
  gif: () => [fixture('still.gif')],
  tiff: () => [fixture('sips.tiff'), fixture('raw.tiff')],
  bmp: () => [fixture('indexed.bmp')],
  wav: () => [fixture('tone-22k.wav')],
  mp4: () => [fixture('video-frag.mp4')],
  m4a: () => [fixture('tone.aac')],
  jxl: () => [fixture('jpeg-recompressed.jxl')],
  pdf: () => [fixture('gs-15.pdf'), fixture('gs-linear.pdf'), fixture('quartz.pdf')],
  json: () => [utf8('[{"a":1},{"b":[true,null,"x"]}]')],
  csv: () => [utf8('a,b\n"x\ny",2\n')],
  yaml: () => [utf8('---\na: 1\n---\n- x\n- y: 2\n')],
  xml: () => [utf8('<a x="1"><b/><![CDATA[x]]><!-- c --></a>')],
  html: () => [utf8('<p>one<p>two<ul><li>a<li>b</ul><script>if(a<b){}</script>')],
  rtf: () => [utf8('{\\rtf1{\\fonttbl{\\f0 A;}}\\pard x\\par {\\pict\\pngblip 00}\\bin3 abc}')],
  xls: () => [buildXls()],
  zip: () => [fixture('plain.zip')],
  ogg: () => [fixture('tone.opus')],
};

function seedsFor(id: string): Uint8Array[] {
  return [SAMPLES[id]!(), ...(EXTRA[id]?.() ?? [])];
}

function mutate(seed: Uint8Array, r: () => number): Uint8Array {
  // Keep the work small: large seeds are cut to a window around the header most of the time.
  let b = seed;
  if (b.length > 16384 && r() < 0.8) {
    const tail = r() < 0.3;
    b = tail ? b.subarray(b.length - 8192) : b.subarray(0, 8192 + Math.floor(r() * 8192));
  }
  b = Uint8Array.from(b);
  const ops = 1 + Math.floor(r() * 4);
  for (let k = 0; k < ops; k++) {
    const kind = Math.floor(r() * 7);
    const at = Math.floor(r() * Math.max(1, b.length));
    switch (kind) {
      case 0: // flip bytes
        for (let i = 0; i < 1 + Math.floor(r() * 12); i++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
        break;
      case 1: // truncate
        b = b.subarray(0, at);
        break;
      case 2: // extreme 32-bit words
        for (const v of [0, 0xffffffff, 0x7fffffff, 0x80000000, 1]) {
          if (r() < 0.4 && b.length >= 4) {
            const o = Math.floor(r() * (b.length - 3));
            b[o] = v >>> 24;
            b[o + 1] = v >>> 16;
            b[o + 2] = v >>> 8;
            b[o + 3] = v;
          }
        }
        break;
      case 3: { // duplicate a slice
        const len = Math.floor(r() * 64);
        b = concat(b.subarray(0, at), b.subarray(at, at + len), b.subarray(at));
        break;
      }
      case 4: // delete a slice
        b = concat(b.subarray(0, at), b.subarray(Math.min(b.length, at + Math.floor(r() * 64))));
        break;
      case 5: { // insert random bytes
        const ins = new Uint8Array(Math.floor(r() * 32)).map(() => Math.floor(r() * 256));
        b = concat(b.subarray(0, at), ins, b.subarray(at));
        break;
      }
      default: { // zero / 0xFF fill
        const end = Math.min(b.length, at + Math.floor(r() * 128));
        b.fill(r() < 0.5 ? 0 : 0xff, at, end);
      }
    }
  }
  return b;
}

const N = 2000;

describe('fuzz: 2,000 random + mutated buffers per parser never throw, hang or break invariants', () => {
  it.each(FORMATS.map((f) => f.id))('%s', async (id) => {
    const seeds = seedsFor(id);
    const r = rng([...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
    let slowest = 0;
    let slowestCase = -1;
    for (let i = 0; i < N; i++) {
      let buf: Uint8Array;
      const seed = seeds[Math.floor(r() * seeds.length)]!;
      const mode = i % 4;
      if (mode === 0) buf = new Uint8Array(Math.floor(r() * 4096)).map(() => Math.floor(r() * 256));
      else if (mode === 1) {
        const head = seed.subarray(0, 8 + Math.floor(r() * 56));
        buf = concat(head, new Uint8Array(Math.floor(r() * 2048)).map(() => Math.floor(r() * 256)));
      } else buf = mutate(seed, r);

      let st;
      let dt = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const t0 = performance.now();
        st = await parseStructure(bytesSource(buf), id as FormatId);
        dt = performance.now() - t0;
        if (dt < 50) break; // a GC pause can make one run slow; a real hang is slow every time
      }
      if (dt > slowest) {
        slowest = dt;
        slowestCase = i;
      }
      const bad = structureViolations(st!, buf.length);
      if (bad.length) throw new Error(`${id} case ${i} (${buf.length} B): ${bad.slice(0, 4).join('; ')}`);
      expect(dt, `${id} case ${i} took ${dt.toFixed(1)} ms`).toBeLessThan(50);
    }
    expect(slowestCase).toBeGreaterThanOrEqual(0);
    expect(slowest).toBeLessThan(50);
  }, 120_000);
});

describe('every parser understands its sample (no silent fallbacks)', () => {
  it.each(FORMATS.map((f) => f.id))('%s', async (id) => {
    const bytes = SAMPLES[id]!();
    const st = await parseStructure(bytesSource(bytes), id as FormatId);
    expect(structureViolations(st, bytes.length)).toEqual([]);
    expect(st.format).toBe(id);
    expect(st.segments.length).toBeGreaterThan(0);
    expect(st.segments.length === 1 && st.segments[0]!.role === 'unknown').toBe(false);
    expect(st.summary).not.toMatch(/not recognised|no readable|invalid at the first/i);
    expect(st.truncated).toBeUndefined();
    // Something was learned: more than a name, at least one real detail or count.
    const informative = st.segments.some((s) => s.detail || s.count || s.children);
    expect(informative).toBe(true);
  });
});
