/**
 * Audio/video engines (mediabunny + ffmpeg) in real browsers, through the real
 * planner, runner and Web Worker. Outputs are verified in Node with two
 * independent demuxers (FFmpeg's ffprobe and mediabunny).
 *
 * Each result line starts with "MEDIA|" so a run can be summarised:
 *   MEDIA|<browser>|<kind>|<pair>|<engine that produced the file>|<ms>|<note>
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { join } from 'node:path';
import { b64File, bytes, convert, openHarness, stageIds } from './helpers';
import { audioDigest, demuxInfo, ffprobeBytes, makeMedia } from '../../src/engines/ffmpeg/test-support/verify';
import { ffmpegStages } from '../../src/engines/ffmpeg/plan';
import { mediabunnyStages } from '../../src/engines/mediabunny/plan';
import type { FormatId } from '../../src/core/formats';

const FIX = join(import.meta.dirname, '../../src/engines/ffmpeg/fixtures');
const fx = (name: string) => b64File(join(FIX, name));

const VIDEO = ['mp4', 'webm', 'mov', 'mkv'] as const;
const AUDIO = ['mp3', 'wav', 'flac', 'ogg', 'm4a'] as const;
const SOURCE: Record<string, string> = {
  mp4: 'sample.mp4', webm: 'sample.webm', mov: 'sample.mov', mkv: 'sample.mkv',
  mp3: 'sample.mp3', wav: 'sample.wav', flac: 'sample.flac', ogg: 'sample.ogg', m4a: 'sample.m4a',
  gif: 'sample.gif',
};
const MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', gif: 'image/gif',
};

type Pair = readonly [from: FormatId, to: FormatId];
const pairs = (froms: readonly string[], tos: readonly string[]): Pair[] =>
  froms.flatMap((f) => tos.filter((t) => t !== f).map((t) => [f, t] as unknown as Pair));

const VIDEO_TO_VIDEO = pairs(VIDEO, VIDEO);
const VIDEO_TO_AUDIO = pairs(VIDEO, AUDIO);
const AUDIO_TO_AUDIO = pairs(AUDIO, AUDIO);
const GIF_PAIRS: Pair[] = [['gif', 'mp4'], ['gif', 'webm'], ...pairs(VIDEO, ['gif'])];
const ALL_PAIRS = [...VIDEO_TO_VIDEO, ...VIDEO_TO_AUDIO, ...AUDIO_TO_AUDIO, ...GIF_PAIRS];

/* ------------------------------------------------------------------ checks */

function magicOk(to: string, b: Uint8Array): boolean {
  const s = (a: number, n: number) => Buffer.from(b.subarray(a, a + n)).toString('latin1');
  switch (to) {
    case 'mp4':
    case 'mov':
    case 'm4a':
      return s(4, 4) === 'ftyp';
    case 'webm':
    case 'mkv':
      return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'ogg':
      return s(0, 4) === 'OggS';
    case 'flac':
      return s(0, 4) === 'fLaC';
    case 'wav':
      return s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE';
    case 'mp3':
      return s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);
    case 'gif':
      return /^GIF8[79]a$/.test(s(0, 6));
    default:
      return false;
  }
}

/** What ffmpeg always writes. */
const CODEC_STRICT: Record<string, { video: string; audio: string }> = {
  mp4: { video: 'h264', audio: 'aac' },
  mov: { video: 'h264', audio: 'aac' },
  mkv: { video: 'h264', audio: 'aac' },
  webm: { video: 'vp8', audio: 'opus' },
};
/** What WebCodecs may write: it copies any track the container can hold instead of re-encoding. */
const CODEC_LOOSE: Record<string, { video: string; audio: string }> = {
  mp4: { video: 'h264|hevc|vp9|av1', audio: 'aac|mp3' },
  mov: { video: 'h264|hevc|prores', audio: 'aac|mp3|pcm_.*' },
  mkv: { video: 'h264|hevc|vp8|vp9|av1', audio: 'aac|mp3|opus|vorbis|flac' },
  webm: { video: 'vp8|vp9|av1', audio: 'opus|vorbis' },
};
const AUDIO_CODEC: Record<string, string> = {
  mp3: 'mp3', flac: 'flac', ogg: 'opus|vorbis', m4a: 'aac', wav: 'pcm_s16le|pcm_s24le',
};

/** Output is a real file of the right container, streams, codec families and ~1 s length. */
async function expectValid(from: string, to: string, run: any, strict = false) {
  expect(run.ok, JSON.stringify(run.error ?? run.events?.filter((e: any) => e.type === 'error'))).toBe(true);
  const out = bytes(run.base64);
  expect(out.length).toBeGreaterThan(200);
  expect(magicOk(to, out), `${to} magic bytes`).toBe(true);
  expect(run.mime).toBe(MIME[to]);
  expect(run.name.endsWith(`.${run.ext}`)).toBe(true);
  expect(run.ext).toBe(to);

  const p = await ffprobeBytes(out, to, to === 'gif');
  expect(p.durationS ?? 0).toBeGreaterThan(0.7);
  expect(p.durationS ?? 0).toBeLessThan(1.5);
  const toVideo = (VIDEO as readonly string[]).includes(to) || to === 'gif';
  if (toVideo) {
    expect(p.video, `${to} video stream`).not.toBeNull();
    expect(p.video!.width).toBe(64);
    expect(p.video!.height).toBe(64);
    if (to === 'gif') {
      expect(p.video!.codec).toBe('gif');
      expect(p.frames).toBeGreaterThanOrEqual(8); // 1 s at <= 15 fps
      expect(p.frames).toBeLessThanOrEqual(15);
    } else {
      const want = (strict ? CODEC_STRICT : CODEC_LOOSE)[to]!;
      expect(p.video!.codec).toMatch(new RegExp(`^(${want.video})$`));
      // the source's soundtrack must survive video -> video; gif has none
      if (from !== 'gif') expect(p.audio?.codec, `${to} audio`).toMatch(new RegExp(`^(${want.audio})$`));
    }
  } else {
    expect(p.video, `${to} must have no video stream`).toBeNull();
    expect(p.audio?.codec).toMatch(new RegExp(`^(${AUDIO_CODEC[to]})$`));
  }
  if (to !== 'gif') {
    const d = await demuxInfo(out);
    expect(d.durationS).toBeGreaterThan(0.7);
    expect(d.durationS).toBeLessThan(1.5);
    if (toVideo) expect(d.video?.width).toBe(64);
    else expect(d.video).toBeNull();
  }
}

/** Playwright may hand typed arrays back as arrays or as index-keyed objects. */
const toNums = (x: any): number[] => (Array.isArray(x) ? x : ArrayBuffer.isView(x) ? Array.from(x as any) : Object.values(x ?? {})) as number[];

const engines = (run: any): string[] => run.events.filter((e: any) => e.type === 'hop-start').map((e: any) => e.engine);
const fallbacks = (run: any) => run.events.filter((e: any) => e.type === 'fallback');

function expectProgressSane(run: any) {
  let stage = '';
  let last = 0;
  for (const e of run.events) {
    if (e.type === 'stage') {
      stage = e.stage;
      last = 0;
    } else if (e.type === 'progress') {
      expect(e.value, `progress in ${stage}`).toBeGreaterThanOrEqual(0);
      expect(e.value).toBeLessThanOrEqual(1);
      expect(e.value).toBeGreaterThanOrEqual(last - 1e-9);
      last = e.value;
    }
  }
}

function note(info: TestInfo, kind: string, pair: string, engine: string, ms: number, extra = '') {
  const line = `MEDIA|${info.project.name}|${kind}|${pair}|${engine}|${ms}ms${extra ? `|${extra}` : ''}`;
  info.annotations.push({ type: 'media', description: line });
  console.log(line);
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const r = await fn();
  return [r, Date.now() - t];
}

/* ------------------------------------------------------------------- tests */

test.describe('routing', () => {
  test('planner offers every required pair, mediabunny first and ffmpeg for the rest', async ({ page }) => {
    await openHarness(page);
    const route = (from: string) => page.evaluate((f) => (window as any).harness.routes(f), from) as Promise<{ to: string; hops: string[] }[]>;
    const mp4 = await route('mp4');
    const hop = (rs: { to: string; hops: string[] }[], to: string) => rs.find((r) => r.to === to)?.hops.join(',');
    for (const t of ['webm', 'mov', 'mkv', 'mp3', 'wav', 'flac', 'ogg', 'm4a']) expect(hop(mp4, t), `mp4->${t}`).toBe(`mediabunny:mp4->${t}`);
    expect(hop(mp4, 'gif')).toBe('ffmpeg:mp4->gif');
    const gif = await route('gif');
    expect(hop(gif, 'mp4')).toBe('ffmpeg:gif->mp4');
    expect(hop(gif, 'webm')).toBe('ffmpeg:gif->webm');
    const mp3 = await route('mp3');
    for (const t of ['wav', 'flac', 'ogg', 'm4a']) expect(hop(mp3, t)).toBe(`mediabunny:mp3->${t}`);
  });
});

test.describe('default route (mediabunny, ffmpeg fallback) - every pair', () => {
  for (const [from, to] of ALL_PAIRS) {
    test(`${from} -> ${to}`, async ({ page }, info) => {
      await openHarness(page);
      const [run, ms] = await timed(() => convert(page, { from, to, base64: fx(SOURCE[from]!), name: `input.${from}` }));
      await expectValid(from, to, run);
      expectProgressSane(run);
      const used = engines(run).at(-1)!;
      const expected = from === 'gif' || to === 'gif' ? 'ffmpeg' : null;
      if (expected) expect(used).toBe(expected);
      const declared = (used === 'ffmpeg' ? ffmpegStages(from, to) : mediabunnyStages(from, to)).map((s) => s.id);
      expect(stageIds(run.events).slice(-declared.length)).toEqual(declared);
      note(info, 'default', `${from}->${to}`, used, ms, fallbacks(run).length ? `fallback: ${fallbacks(run)[0].reason}` : '');
    });
  }
});

test.describe('ffmpeg engine (wasm) - every pair, run directly', () => {
  for (const [from, to] of ALL_PAIRS) {
    test(`${from} -> ${to}`, async ({ page }, info) => {
      await openHarness(page);
      const [run, ms] = await timed(() => convert(page, { from, to, engine: 'ffmpeg', base64: fx(SOURCE[from]!), name: `input.${from}` }));
      await expectValid(from, to, run, true);
      expect(engines(run)).toEqual(['ffmpeg']);
      expect(fallbacks(run)).toEqual([]);
      expect(stageIds(run.events)).toEqual(ffmpegStages(from, to).map((s) => s.id));
      expectProgressSane(run);
      // the input Blob is read in place by WORKERFS, never copied into the wasm heap
      expect(run.events.some((e: any) => e.type === 'log' && /WORKERFS/.test(e.message))).toBe(true);
      // a real, measured percentage during the encode stage (the palette pass of a gif has none)
      const prog = run.events.filter((e: any) => e.type === 'progress');
      expect(prog.length).toBeGreaterThan(0);
      expect(prog.at(-1).value).toBe(1);
      // the wasm download is reported byte-accurately and completes
      const assets = run.events.filter((e: any) => e.type === 'asset');
      expect(assets.length).toBeGreaterThan(0);
      const last = assets.at(-1);
      expect(last.url).toMatch(/ffmpeg-core.*\.wasm/);
      if (last.total !== null) expect(last.loaded).toBe(last.total);
      // truthful facts from the probed input
      const facts = run.events.find((e: any) => e.type === 'facts')?.facts;
      expect(facts, 'facts').toBeTruthy();
      const wantsVideo = (VIDEO as readonly string[]).includes(to) || to === 'gif';
      expect(facts.kind).toBe(wantsVideo ? 'video' : 'audio');
      expect(facts.durationS).toBeGreaterThan(0.8);
      expect(facts.durationS).toBeLessThan(1.3);
      if (wantsVideo) expect(facts).toMatchObject({ width: 64, height: 64 });
      else expect(facts.channels).toBeGreaterThanOrEqual(1);
      note(info, 'ffmpeg', `${from}->${to}`, 'ffmpeg', ms, `${(run.size / 1024).toFixed(0)}KB`);
    });
  }
});

test.describe('mediabunny engine (WebCodecs) - run directly, no fallback', () => {
  // Pairs that every browser with WebCodecs must handle without ffmpeg: copy or PCM/AAC/Opus paths.
  const MUST: Pair[] = [['mp4', 'mov'], ['mov', 'mp4'], ['mkv', 'mp4'], ['mp4', 'mkv'], ['mp4', 'wav'], ['mp4', 'm4a'], ['m4a', 'wav'], ['wav', 'm4a'], ['wav', 'mp3'], ['mp3', 'wav'], ['wav', 'flac']];
  for (const [from, to] of ALL_PAIRS.filter(([f, t]) => f !== 'gif' && t !== 'gif')) {
    const must = MUST.some(([f, t]) => f === from && t === to);
    test(`${from} -> ${to}${must ? ' (required)' : ''}`, async ({ page }, info) => {
      await openHarness(page);
      const [run, ms] = await timed(() => convert(page, { from, to, engine: 'mediabunny', base64: fx(SOURCE[from]!), name: `input.${from}` }));
      if (run.ok) {
        await expectValid(from, to, run);
        expect(stageIds(run.events)).toEqual(mediabunnyStages(from, to).map((s) => s.id));
        expectProgressSane(run);
        expect(run.events.some((e: any) => e.type === 'facts')).toBe(true);
        const how = run.events.filter((e: any) => e.type === 'log').map((e: any) => e.message).find((m: string) => m.startsWith('mediabunny:'));
        note(info, 'mediabunny', `${from}->${to}`, 'mediabunny', ms, how ?? '');
      } else {
        // not possible in this browser: must be a clear "unsupported" reason, never a crash
        expect(must, `${from}->${to} must work with WebCodecs alone: ${run.error}`).toBe(false);
        expect(run.error).toMatch(/browser|WebCodecs|recognise|decode|encode/i);
        note(info, 'mediabunny', `${from}->${to}`, 'UNSUPPORTED', ms, run.error);
      }
    });
  }
});

test.describe('mediabunny behaviour', () => {
  test('copies tracks the container can hold instead of re-encoding (mp4 -> mov, mkv -> mp4)', async ({ page }, info) => {
    await openHarness(page);
    for (const [from, to] of [['mp4', 'mov'], ['mkv', 'mp4']] as Pair[]) {
      const run = await convert(page, { from, to, engine: 'mediabunny', base64: fx(SOURCE[from]!), name: `input.${from}` });
      expect(run.ok, run.error).toBe(true);
      const logs = run.events.filter((e: any) => e.type === 'log').map((e: any) => e.message).join('\n');
      expect(logs).toMatch(/video copy avc/);
      expect(logs).toMatch(/audio copy aac/);
      note(info, 'remux', `${from}->${to}`, 'mediabunny', 0, logs.split('\n').find((l: string) => l.startsWith('mediabunny:')) ?? '');
    }
  });

  test('facts and previews are real: dimensions, codecs, thumbnails, waveform', async ({ page }) => {
    await openHarness(page);
    const v = await convert(page, { from: 'mp4', to: 'mkv', engine: 'mediabunny', base64: fx('sample.mp4'), name: 'a.mp4' });
    expect(v.ok, v.error).toBe(true);
    const vf = v.events.find((e: any) => e.type === 'facts').facts;
    expect(vf).toMatchObject({ kind: 'video', width: 64, height: 64, videoCodec: 'avc', audioCodec: 'aac' });
    expect(vf.durationS).toBeGreaterThan(0.9);
    expect(vf.durationS).toBeLessThan(1.2);
    expect(vf.fps).toBeCloseTo(10, 0);
    const frames = v.events.find((e: any) => e.type === 'preview')?.preview;
    expect(frames?.kind).toBe('frames');
    expect(frames.width).toBe(64);
    expect(frames.frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.frames.length).toBeLessThanOrEqual(8);
    const px = toNums(frames.frames[0]);
    expect(px.length).toBe(64 * 64 * 4);
    // testsrc2 is colourful: a frame of one flat value would mean a fake/blank preview
    expect(new Set(px).size).toBeGreaterThan(10);

    const a = await convert(page, { from: 'wav', to: 'flac', engine: 'mediabunny', base64: fx('sample.wav'), name: 'a.wav' });
    expect(a.ok, a.error).toBe(true);
    const af = a.events.find((e: any) => e.type === 'facts').facts;
    expect(af).toMatchObject({ kind: 'audio', sampleRate: 44100, channels: 1 });
    const wf = a.events.find((e: any) => e.type === 'preview')?.preview;
    expect(wf?.kind).toBe('waveform');
    const peaks = toNums(wf.peaks);
    expect(peaks.length).toBe(256);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
    // a constant 440 Hz sine has a flat envelope
    expect(peaks.filter((p) => p > 0.5).length).toBeGreaterThan(200);
  });

  test('non-WebCodecs sources hand over to ffmpeg with a visible fallback event', async ({ page }, info) => {
    await openHarness(page);
    for (const [file, from, to] of [['sample-mpeg4.mp4', 'mp4', 'webm'], ['sample-prores.mov', 'mov', 'mp4']] as const) {
      const [run, ms] = await timed(() => convert(page, { from, to, base64: fx(file), name: `input.${from}` }));
      await expectValid(from, to, run, true);
      expect(engines(run)).toEqual(['mediabunny', 'ffmpeg']);
      const fb = fallbacks(run);
      expect(fb).toHaveLength(1);
      expect(fb[0]).toMatchObject({ fromEngine: 'mediabunny', toEngine: 'ffmpeg' });
      expect(fb[0].reason.length).toBeGreaterThan(10);
      note(info, 'fallback', `${file}->${to}`, 'ffmpeg', ms, fb[0].reason);
    }
  });

  test('audio extraction from a codec WebCodecs cannot decode still stays on WebCodecs when the audio is fine', async ({ page }) => {
    await openHarness(page);
    const run = await convert(page, { from: 'mp4', to: 'mp3', base64: fx('sample-mpeg4.mp4'), name: 'a.mp4' });
    await expectValid('mp4', 'mp3', run);
    expect(engines(run)).toEqual(['mediabunny']);
  });

  test('flac and vorbis sources convert in every browser (native decode or ffmpeg)', async ({ page }, info) => {
    await openHarness(page);
    for (const [file, from, to] of [['sample.flac', 'flac', 'wav'], ['sample.flac', 'flac', 'mp3'], ['sample-vorbis.ogg', 'ogg', 'm4a'], ['sample-vorbis.ogg', 'ogg', 'wav']] as const) {
      const [run, ms] = await timed(() => convert(page, { from, to, base64: fx(file), name: `input.${from}` }));
      await expectValid(from, to, run);
      note(info, 'decode', `${file}->${to}`, engines(run).at(-1)!, ms, fallbacks(run)[0]?.reason ?? '');
    }
  });
});

test.describe('lossless audio targets are bit-exact and keep the source bit depth', () => {
  const CASES = [
    ['sample-24bit.flac', 'flac', 'wav', 24],
    ['sample-24bit.wav', 'wav', 'flac', 24],
    ['sample.flac', 'flac', 'wav', 16],
    ['sample.wav', 'wav', 'flac', 16],
  ] as const;
  for (const engine of ['default', 'ffmpeg', 'mediabunny'] as const) {
    for (const [file, from, to, bits] of CASES) {
      test(`${engine}: ${file} -> ${to} (${bits}-bit)`, async ({ page }, info) => {
        await openHarness(page);
        const run = await convert(page, { from, to, base64: fx(file), name: `a.${from}`, ...(engine === 'default' ? {} : { engine }) });
        if (!run.ok) {
          // WebCodecs-only run on a browser that cannot decode this source: a clear reason, not a crash
          expect(engine, run.error).toBe('mediabunny');
          expect(run.error).toMatch(/browser|WebCodecs|decode|encode/i);
          note(info, 'lossless', `${file}->${to}`, 'UNSUPPORTED', 0, run.error);
          return;
        }
        const out = bytes(run.base64);
        const p = await ffprobeBytes(out, to);
        expect(p.audio?.bits).toBe(bits);
        expect(await audioDigest(out, to)).toBe(await audioDigest(bytes(fx(file)), from));
        note(info, 'lossless', `${file}->${to}`, engines(run).at(-1)!, 0, `${bits}-bit bit-exact`);
      });
    }
  }
});

test.describe('longer clip: progress is measured, not invented', () => {
  test('640x360 6 s clip: ffmpeg and mediabunny report several rising, non-repeating percentages', async ({ page }, info) => {
    await openHarness(page);
    const clip = Buffer.from(
      await makeMedia(
        ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
         '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
        'clip.mp4',
      ),
    ).toString('base64');
    for (const [to, engine] of [['webm', 'ffmpeg'], ['mkv', 'ffmpeg'], ['gif', 'ffmpeg'], ['webm', 'mediabunny'], ['mkv', 'mediabunny']] as const) {
      const [run, ms] = await timed(() => convert(page, { from: 'mp4', to, engine, base64: clip, name: 'clip.mp4' }));
      expect(run.ok, run.error).toBe(true);
      const p = await ffprobeBytes(bytes(run.base64), to, to === 'gif');
      expect(p.durationS ?? 0).toBeGreaterThan(5.5);
      expect(p.durationS ?? 0).toBeLessThan(6.6);
      expect(p.video?.width).toBe(to === 'gif' ? 640 : 640);
      expectProgressSane(run);
      const vals = run.events.filter((e: any) => e.type === 'progress').map((e: any) => e.value);
      expect(vals.at(-1)).toBe(1);
      // A WebCodecs copy (mp4 -> mkv) finishes in a few ms, inside one progress throttle window.
      const copied = engine === 'mediabunny' && to === 'mkv';
      if (!copied) {
        expect(vals.length, `${engine} ${to} progress events`).toBeGreaterThanOrEqual(3);
        expect(vals.some((v: number) => v > 0 && v < 1), `${engine} ${to} has an intermediate percentage`).toBe(true);
        expect(new Set(vals).size, 'no duplicate posts').toBe(vals.length);
      }
      note(info, 'clip', `mp4->${to}`, engine, ms, `${vals.length} progress events, ${(run.size / 1024).toFixed(0)}KB`);
    }
  });
});

test.describe('safety and privacy', () => {
  test('bad input fails with a readable message, never a crash or hang', async ({ page }) => {
    await openHarness(page);
    const junk = Buffer.alloc(8192, 7).toString('base64');
    for (const [from, to] of [['mp4', 'webm'], ['mp3', 'wav'], ['mkv', 'gif']] as Pair[]) {
      const run = await convert(page, { from, to, base64: junk, name: `junk.${from}` });
      expect(run.ok).toBe(false);
      expect(run.error).toMatch(/\S{3,}/);
      expect(run.error.length).toBeLessThan(300);
      expect(run.error).not.toMatch(/undefined|\[object|RuntimeError|wasm/i);
    }
    const tiny = await convert(page, { from: 'mp4', to: 'webm', base64: Buffer.from([1, 2, 3]).toString('base64'), name: 'tiny.mp4' });
    expect(tiny.ok).toBe(false);
    expect(tiny.error).toMatch(/\S{3,}/);
  });

  test('extracting audio from a silent video says so', async ({ page }) => {
    await openHarness(page);
    const run = await convert(page, { from: 'mp4', to: 'mp3', base64: fx('sample-silent.mp4'), name: 'silent.mp4' });
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/no audio track/i);
  });

  test('truncated media still ends in success or a clear error', async ({ page }) => {
    await openHarness(page);
    const whole = bytes(fx('sample.mp4'));
    for (const cut of [0.5, 0.9]) {
      const run = await convert(page, { from: 'mp4', to: 'webm', base64: whole.subarray(0, Math.floor(whole.length * cut)).toString('base64'), name: 'cut.mp4' });
      if (!run.ok) expect(run.error.length).toBeGreaterThan(5);
    }
  });

  test('no network beyond the app origin and nothing persisted (IndexedDB, Cache, storage, OPFS)', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('http://localhost') && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u);
    });
    await openHarness(page);
    for (const [file, from, to, engine] of [
      ['sample.mp4', 'mp4', 'webm', 'ffmpeg'],
      ['sample.mp4', 'mp4', 'gif', 'ffmpeg'],
      ['sample.wav', 'wav', 'mp3', 'mediabunny'],
      ['sample.mp4', 'mp4', 'm4a', 'mediabunny'],
    ] as const) {
      const run = await convert(page, { from, to, engine, base64: fx(file), name: `a.${from}` });
      if (engine === 'ffmpeg') expect(run.ok, run.error).toBe(true);
    }
    const state = await page.evaluate(async () => {
      const dbs = (await (indexedDB as any).databases?.()) ?? [];
      const caches_ = typeof caches !== 'undefined' ? await caches.keys() : [];
      let opfs: string[] = [];
      try {
        const root = await navigator.storage.getDirectory();
        for await (const [name] of (root as any).entries()) opfs.push(name);
      } catch {
        opfs = [];
      }
      return { dbs: dbs.map((d: any) => d.name), caches: caches_, local: localStorage.length, session: sessionStorage.length, opfs };
    });
    expect(state).toEqual({ dbs: [], caches: [], local: 0, session: 0, opfs: [] });
    expect(external).toEqual([]);
  });

  test('gif output is capped at 640 px wide and 15 fps by default, and the options change that', async ({ page }) => {
    await openHarness(page);
    const big = Buffer.from(
      await makeMedia(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], 'big.mp4'),
    ).toString('base64');
    const run = await convert(page, { from: 'mp4', to: 'gif', engine: 'ffmpeg', base64: big, name: 'big.mp4' });
    expect(run.ok, run.error).toBe(true);
    const p = await ffprobeBytes(bytes(run.base64), 'gif', true);
    expect(p.video).toMatchObject({ width: 640, height: 360 });
    expect(p.frames).toBe(15);

    const small = await convert(page, { from: 'mp4', to: 'gif', engine: 'ffmpeg', base64: fx('sample.mp4'), name: 'small.mp4', options: { gifMaxWidth: 32, gifFps: 5 } });
    expect(small.ok, small.error).toBe(true);
    const q = await ffprobeBytes(bytes(small.base64), 'gif', true);
    expect(q.video).toMatchObject({ width: 32, height: 32 });
    expect(q.frames).toBe(5);
  });
});
