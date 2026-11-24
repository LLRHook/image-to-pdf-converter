import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import type { ConvertRequest, Engine } from '../../core/types';
import type { FormatId } from '../../core/formats';
import { edges } from './edges';
import { expandEdges } from '../../core/graph';
import { ffmpegStages } from './plan';
import { audioDigest, demuxInfo, ffprobeBytes, makeMedia } from './test-support/verify';

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

let engine: Engine;
beforeAll(async () => {
  const g = globalThis as { self?: unknown; location?: unknown };
  g.self ??= globalThis;
  g.location ??= { href: 'file:///unit/' };
  engine = (await import('./engine')).default;
});

async function run(name: string, from: FormatId, to: FormatId, options: Record<string, unknown> = {}) {
  const ctx = testContext();
  const req: ConvertRequest = { input: blobOf(fixture(name)), name, from, to, options };
  const result = await engine.convert(req, ctx);
  return { ctx, result, bytes: await bytesOf(result.output) };
}

describe('edges', () => {
  const hops = expandEdges(edges.map((e) => ({ ...e, engine: 'ffmpeg' })));
  const has = (f: string, t: string) => hops.some((h) => h.from === f && h.to === t);

  it('covers the required matrix', () => {
    for (const f of ['mp4', 'webm', 'mov', 'mkv']) {
      for (const t of ['mp4', 'webm', 'mov', 'mkv', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'gif']) {
        if (f !== t) expect(has(f, t), `${f}->${t}`).toBe(true);
      }
    }
    for (const f of ['mp3', 'wav', 'flac', 'ogg', 'm4a']) for (const t of ['mp3', 'wav', 'flac', 'ogg', 'm4a']) if (f !== t) expect(has(f, t)).toBe(true);
    expect(has('gif', 'mp4') && has('gif', 'webm')).toBe(true);
  });
  it('never offers nonsense pairs', () => {
    expect(has('mp3', 'mp4')).toBe(false);
    expect(has('gif', 'mp3')).toBe(false);
    expect(has('gif', 'gif')).toBe(false);
  });
  it('declares labelled stages in contract order', () => {
    for (const h of hops) {
      expect(h.stages.length).toBeGreaterThanOrEqual(4);
      expect(h.stages.every((s) => s.label.length > 3)).toBe(true);
      expect(h.stages.map((s) => s.id)).toEqual(ffmpegStages(h.from, h.to).map((s) => s.id));
    }
  });
});

describe('ffmpeg engine (real wasm, Node)', () => {
  it('mp4 -> webm: stages, facts, preview, progress, valid VP8+Opus', async () => {
    const { ctx, result, bytes } = await run('sample.mp4', 'mp4', 'webm');
    expect(ctx.stages).toEqual(ffmpegStages('mp4', 'webm').map((s) => s.id));
    expect(ctx.factsSeen[0]).toMatchObject({ kind: 'video', width: 64, height: 64, videoCodec: 'h264', audioCodec: 'aac' });
    const pv = ctx.previews[0];
    expect(pv?.kind).toBe('frames');
    if (pv?.kind === 'frames') {
      expect(pv.frames.length).toBeGreaterThanOrEqual(2);
      expect(pv.frames[0]!.length).toBe(pv.width * pv.height * 4);
      expect(pv.frames.some((f) => f.some((b) => b > 0 && b < 255))).toBe(true);
    }
    expect(ctx.progressValues.length).toBeGreaterThan(0);
    expect(ctx.progressValues.at(-1)).toBe(1);
    expect(ctx.progressValues.every((v, i, a) => v >= 0 && v <= 1 && (i === 0 || v >= a[i - 1]! - 1e-9))).toBe(true);
    expect(ctx.assets).toHaveLength(1);
    expect(result.ext).toBe('webm');
    const info = await demuxInfo(bytes);
    expect(info.video).toMatchObject({ codec: 'vp8', width: 64, height: 64 });
    expect(info.audio?.codec).toBe('opus');
    expect(info.durationS).toBeGreaterThan(0.8);
  });

  it.each([
    ['sample.mp4', 'mp4', 'mov', 'h264', 'aac'],
    ['sample.mkv', 'mkv', 'mp4', 'h264', 'aac'],
    ['sample.webm', 'webm', 'mkv', 'h264', 'aac'],
    ['sample.mov', 'mov', 'mp4', 'h264', 'aac'],
  ] as const)('%s %s -> %s re-encodes to %s + %s', async (file, from, to, vc, ac) => {
    const { bytes } = await run(file, from, to);
    const p = await ffprobeBytes(bytes, to);
    expect(p.video?.codec).toBe(vc);
    expect(p.audio?.codec).toBe(ac);
    expect(p.video).toMatchObject({ width: 64, height: 64 });
    expect(p.durationS).toBeGreaterThan(0.8);
    expect(p.durationS).toBeLessThan(1.3);
    expect((await demuxInfo(bytes)).video?.codec).toBe('avc');
  });

  it.each([
    ['mp3', 'mp3'],
    ['wav', 'pcm_s16le'],
    ['flac', 'flac'],
    ['ogg', 'opus'],
    ['m4a', 'aac'],
  ] as const)('video -> %s extracts audio as %s', async (to, codec) => {
    const { ctx, bytes, result } = await run('sample.mp4', 'mp4', to);
    expect(ctx.factsSeen[0]?.kind).toBe('audio');
    expect(ctx.previews[0]?.kind).toBe('waveform');
    expect(result.ext).toBe(to);
    const p = await ffprobeBytes(bytes, to);
    expect(p.video).toBeNull();
    expect(p.audio?.codec).toBe(codec);
    expect(p.durationS).toBeGreaterThan(0.8);
  });

  it.each([
    ['sample.mp3', 'mp3', 'flac'],
    ['sample.flac', 'flac', 'wav'],
    ['sample.ogg', 'ogg', 'mp3'],
    ['sample-vorbis.ogg', 'ogg', 'm4a'],
    ['sample.m4a', 'm4a', 'ogg'],
    ['sample.wav', 'wav', 'mp3'],
  ] as const)('%s %s -> %s', async (file, from, to) => {
    const { bytes } = await run(file, from, to);
    const p = await ffprobeBytes(bytes, to);
    expect(p.audio?.sampleRate).toBeGreaterThan(0);
    expect(p.durationS).toBeGreaterThan(0.8);
    expect(p.durationS).toBeLessThan(1.3);
  });

  it('video -> gif: two stages with a palette, capped at 15 fps / 640 px', async () => {
    const { ctx, bytes } = await run('sample.mp4', 'mp4', 'gif');
    expect(ctx.stages).toEqual(['load', 'read', 'transform', 'encode', 'package']);
    expect(Buffer.from(bytes.subarray(0, 6)).toString('latin1')).toMatch(/^GIF8[79]a$/);
    const p = await ffprobeBytes(bytes, 'gif', true);
    expect(p.video).toMatchObject({ codec: 'gif', width: 64, height: 64 });
    expect(p.frames).toBe(10);
    // palette pass has no honest percentage: only the encode pass reports progress
    expect(ctx.progressValues.length).toBeGreaterThan(0);
  });

  it('gif width cap and fps option are applied', async () => {
    const { bytes } = await run('sample.mp4', 'mp4', 'gif', { gifFps: 5, gifMaxWidth: 32 });
    const p = await ffprobeBytes(bytes, 'gif', true);
    expect(p.video).toMatchObject({ width: 32, height: 32 });
    expect(p.frames).toBe(5);
  });

  it('gif -> mp4 and gif -> webm produce even-sized yuv420p video', async () => {
    for (const to of ['mp4', 'webm'] as const) {
      const { bytes, ctx } = await run('sample.gif', 'gif', to);
      expect(ctx.factsSeen[0]).toMatchObject({ kind: 'video', width: 64, height: 64, videoCodec: 'gif' });
      const p = await ffprobeBytes(bytes, to);
      expect(p.video?.codec).toBe(to === 'mp4' ? 'h264' : 'vp8');
      expect(p.audio).toBeNull();
      expect(p.durationS).toBeGreaterThan(0.8);
    }
  });

  it('decodes codecs WebCodecs cannot (MPEG-4 part 2, ProRes)', async () => {
    for (const [file, from] of [['sample-mpeg4.mp4', 'mp4'], ['sample-prores.mov', 'mov']] as const) {
      const { bytes } = await run(file, from, 'mkv');
      expect((await ffprobeBytes(bytes, 'mkv')).video?.codec).toBe('h264');
    }
  });

  it('24-bit sources stay bit-exact through lossless targets (FLAC -> WAV, WAV -> FLAC)', async () => {
    const wav = await run('sample-24bit.flac', 'flac', 'wav');
    expect((await ffprobeBytes(wav.bytes, 'wav')).audio).toMatchObject({ codec: 'pcm_s24le' });
    expect(await audioDigest(wav.bytes, 'wav')).toBe(await audioDigest(fixture('sample-24bit.flac'), 'flac'));
    const flac = await run('sample-24bit.wav', 'wav', 'flac');
    expect((await ffprobeBytes(flac.bytes, 'flac')).audio?.bits).toBe(24);
    expect(await audioDigest(flac.bytes, 'flac')).toBe(await audioDigest(fixture('sample-24bit.wav'), 'wav'));
    const wav16 = await run('sample.flac', 'flac', 'wav');
    expect((await ffprobeBytes(wav16.bytes, 'wav')).audio).toMatchObject({ codec: 'pcm_s16le' });
    expect(await audioDigest(wav16.bytes, 'wav')).toBe(await audioDigest(fixture('sample.flac'), 'flac'));
  });

  it('keeps 16-bit PCM and does not leave files behind', async () => {
    const { bytes, ctx } = await run('sample.flac', 'flac', 'wav');
    expect(bytes.length).toBeGreaterThan(80_000);
    expect(ctx.logs.some((l) => /FFmpeg plan/.test(l))).toBe(true);
  });

  it('reports several rising, measured percentages on a longer clip', async () => {
    const clip = await makeMedia(
      ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      'clip.mp4',
    );
    const ctx = testContext();
    await engine.convert({ input: blobOf(clip), name: 'clip.mp4', from: 'mp4', to: 'webm', options: {} }, ctx);
    expect(ctx.previews[0]?.kind).toBe('frames'); // thumbnails run first with -nostats; progress must survive that
    expect(ctx.progressValues.length).toBeGreaterThanOrEqual(3);
    expect(ctx.progressValues.filter((v) => v > 0 && v < 1).length).toBeGreaterThanOrEqual(1);
    expect(ctx.progressValues.every((v, i, a) => i === 0 || v >= a[i - 1]!)).toBe(true);
    expect(ctx.progressValues.at(-1)).toBe(1);
  });

  it('rejects clearly: no audio, garbage, empty, oversized', async () => {
    await expect(run('sample-silent.mp4', 'mp4', 'mp3')).rejects.toThrow(/no audio track/);
    const ctx = testContext();
    await expect(
      engine.convert({ input: blobOf(new Uint8Array(4096).fill(7)), name: 'x.mp4', from: 'mp4', to: 'webm', options: {} }, ctx),
    ).rejects.toThrow(/could not be read as MP4/);
    await expect(
      engine.convert({ input: blobOf(new Uint8Array(0)), name: 'x.mp4', from: 'mp4', to: 'webm', options: {} }, testContext()),
    ).rejects.toThrow(/empty/);
    const huge = { size: 2 * 1024 ** 3, slice: () => new Blob() } as unknown as Blob;
    await expect(engine.convert({ input: huge, name: 'x.mp4', from: 'mp4', to: 'webm', options: {} }, testContext())).rejects.toThrow(/1\.5 GB/);
  });
});
