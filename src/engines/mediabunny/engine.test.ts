/**
 * Node has no WebCodecs, which makes it a good place to prove two things:
 *  - copy paths (remux) work with the demuxers/muxers alone, and
 *  - everything that needs a codec the runtime lacks throws EngineUnsupportedError
 *    before doing any work, so the runner falls back to FFmpeg.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blobOf, runEngine, testContext } from '../../core/testing';
import { EngineUnsupportedError } from '../../core/types';
import type { FormatId } from '../../core/formats';
import engine from './engine';
import { mediabunnyStages } from './plan';
import { audioDigest, demuxInfo, ffprobeBytes } from '../ffmpeg/test-support/verify';

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../ffmpeg/fixtures/${name}`, import.meta.url))));

async function run(name: string, from: FormatId, to: FormatId) {
  return runEngine(engine, { input: fixture(name), name, from, to });
}

describe('remux without re-encoding', () => {
  it.each([
    ['sample.mp4', 'mp4', 'mov', 'h264', 'aac'],
    ['sample.mov', 'mov', 'mp4', 'h264', 'aac'],
    ['sample.mkv', 'mkv', 'mp4', 'h264', 'aac'],
    ['sample.mp4', 'mp4', 'mkv', 'h264', 'aac'],
    ['sample.webm', 'webm', 'mkv', 'vp8', 'opus'],
  ] as const)('%s %s -> %s keeps %s + %s untouched', async (file, from, to, vc, ac) => {
    const { ctx, bytes, result } = await run(file, from, to);
    expect(ctx.stages).toEqual(mediabunnyStages(from, to).map((s) => s.id));
    expect(ctx.logs.find((l) => l.startsWith('mediabunny:'))).toMatch(/video copy .*audio copy/);
    expect(result.ext).toBe(to);
    const p = await ffprobeBytes(bytes, to);
    expect(p.video?.codec).toBe(vc);
    expect(p.audio?.codec).toBe(ac);
    expect(p.video).toMatchObject({ width: 64, height: 64 });
    expect(p.durationS).toBeGreaterThan(0.8);
    expect(p.durationS).toBeLessThan(1.3);
    expect((await demuxInfo(bytes)).durationS).toBeGreaterThan(0.8);
  });

  it('extracts an AAC track into m4a and an Opus track into ogg without decoding', async () => {
    const a = await run('sample.mp4', 'mp4', 'm4a');
    expect((await ffprobeBytes(a.bytes, 'm4a')).audio?.codec).toBe('aac');
    expect(a.ctx.logs.find((l) => l.startsWith('mediabunny:'))).toMatch(/no video; audio copy aac/);
    const o = await run('sample.webm', 'webm', 'ogg');
    expect((await ffprobeBytes(o.bytes, 'ogg')).audio?.codec).toBe('opus');
  });

  it('reports truthful facts from the container and a real progress that ends at 1', async () => {
    const { ctx } = await run('sample.mp4', 'mp4', 'mov');
    expect(ctx.factsSeen[0]).toMatchObject({ kind: 'video', width: 64, height: 64, videoCodec: 'avc', audioCodec: 'aac' });
    const f = ctx.factsSeen[0] as { durationS: number; fps?: number };
    expect(f.durationS).toBeGreaterThan(0.9);
    expect(f.durationS).toBeLessThan(1.2);
    expect(f.fps).toBeCloseTo(10, 0);
    expect(ctx.progressValues.every((v, i, a) => v >= 0 && v <= 1 && (i === 0 || v >= a[i - 1]!))).toBe(true);
    expect(ctx.progressValues.at(-1)).toBe(1);
    expect(ctx.assets).toEqual([]); // no wasm download for remux
  });

  it('audio facts are emitted even when the engine then hands over', async () => {
    const ctx = testContext();
    const err = await engine.convert({ input: blobOf(fixture('sample.mp3')), name: 'a.mp3', from: 'mp3', to: 'wav', options: {} }, ctx).catch((e) => e);
    expect(ctx.factsSeen[0]).toMatchObject({ kind: 'audio', sampleRate: 44100, channels: 1, codec: 'mp3' });
    expect(err).toBeInstanceOf(EngineUnsupportedError); // Node cannot decode MP3: no WebCodecs
  });
});

describe('lossless targets keep every bit of the source', () => {
  it('24-bit WAV -> FLAC is bit-exact and stays 24-bit (wasm FLAC encoder)', async () => {
    const { bytes, ctx } = await run('sample-24bit.wav', 'wav', 'flac');
    expect(ctx.logs.find((l) => l.startsWith('mediabunny:'))).toMatch(/audio encode flac/);
    const p = await ffprobeBytes(bytes, 'flac');
    expect(p.audio?.bits).toBe(24);
    expect(await audioDigest(bytes, 'flac')).toBe(await audioDigest(fixture('sample-24bit.wav'), 'wav'));
  });
  it('16-bit WAV -> FLAC is bit-exact and stays 16-bit', async () => {
    const { bytes } = await run('sample.wav', 'wav', 'flac');
    expect((await ffprobeBytes(bytes, 'flac')).audio?.bits).toBe(16);
    expect(await audioDigest(bytes, 'flac')).toBe(await audioDigest(fixture('sample.wav'), 'wav'));
  });
});

describe('hands over to ffmpeg (EngineUnsupportedError) before any work', () => {
  it.each([
    ['sample.mp4', 'mp4', 'webm'], // needs avc decode + vp9 encode
    ['sample.webm', 'webm', 'mp4'],
    ['sample.mp3', 'mp3', 'ogg'], // needs an opus encoder
    ['sample-mpeg4.mp4', 'mp4', 'webm'], // mpeg4 part 2: no WebCodecs codec string at all
    ['sample-prores.mov', 'mov', 'mp4'],
  ] as const)('%s %s -> %s', async (file, from, to) => {
    const ctx = testContext();
    const err = await engine.convert({ input: blobOf(fixture(file)), name: file, from, to, options: {} }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(EngineUnsupportedError);
    expect(String(err.message).length).toBeGreaterThan(15);
    expect(ctx.stages).not.toContain('package');
  });

  it('does not accept pairs it does not own', async () => {
    const err = await engine.convert({ input: blobOf(fixture('sample.gif')), name: 'a.gif', from: 'gif', to: 'mp4', options: {} }, testContext()).catch((e) => e);
    expect(err).toBeInstanceOf(EngineUnsupportedError);
  });

  it('treats an unreadable container as unsupported so ffmpeg can look too', async () => {
    const err = await engine.convert({ input: blobOf(new Uint8Array(4096).fill(7)), name: 'x.mp4', from: 'mp4', to: 'mov', options: {} }, testContext()).catch((e) => e);
    expect(err).toBeInstanceOf(EngineUnsupportedError);
  });
});

describe('clear errors for problems no engine can fix', () => {
  it('empty input', async () => {
    await expect(engine.convert({ input: blobOf(new Uint8Array(0)), name: 'x.mp4', from: 'mp4', to: 'mov', options: {} }, testContext())).rejects.toThrow(/empty/);
  });
  it('no audio track to extract', async () => {
    await expect(run('sample-silent.mp4', 'mp4', 'm4a')).rejects.toThrow(/no audio track/);
  });
});
