import { describe, expect, it } from 'vitest';
import { expandEdges } from '../../core/graph';
import { edges } from './edges';
import {
  PeakAccumulator,
  TARGETS,
  channelCandidates,
  mediabunnyStages,
  supportsPair,
  thumbnailSize,
  thumbnailTimes,
  wantsCopy,
} from './plan';

const hops = expandEdges(edges.map((e) => ({ ...e, engine: 'mediabunny' })));
const has = (f: string, t: string) => hops.some((h) => h.from === f && h.to === t);

describe('edges', () => {
  it('video <-> video, video -> audio and audio <-> audio, nothing else', () => {
    const video = ['mp4', 'webm', 'mov', 'mkv'];
    const audio = ['mp3', 'wav', 'flac', 'ogg', 'm4a'];
    for (const f of video) for (const t of [...video, ...audio]) expect(has(f, t) === (f !== t), `${f}->${t}`).toBe(true);
    for (const f of audio) {
      for (const t of audio) expect(has(f, t) === (f !== t), `${f}->${t}`).toBe(true);
      for (const t of video) expect(has(f, t), `${f}->${t}`).toBe(false);
    }
    expect(has('gif', 'mp4')).toBe(false);
    expect(has('mp4', 'gif')).toBe(false);
  });
  it('is cheaper than ffmpeg (cost 9) and marks lossless targets', () => {
    expect(hops.every((h) => h.cost < 9)).toBe(true);
    expect(hops.find((h) => h.from === 'mp3' && h.to === 'wav')!.fidelity).toBe('lossless');
    expect(hops.find((h) => h.from === 'mp3' && h.to === 'flac')!.fidelity).toBe('lossless');
    expect(hops.find((h) => h.from === 'wav' && h.to === 'mp3')!.fidelity).toBe('lossy');
  });
  it('declares read -> transform -> package with specific labels', () => {
    for (const h of hops) {
      expect(h.stages.map((s) => s.id)).toEqual(['read', 'transform', 'package']);
      expect(h.stages[0]!.label).toMatch(/^Demux /);
      expect(h.stages[2]!.label).toMatch(/^Mux /);
    }
    expect(mediabunnyStages('mkv', 'webm')[2]!.label).toBe('Mux WebM');
    expect(mediabunnyStages('mp4', 'webm')[1]!.label).toBe('Remux or re-encode tracks');
    expect(mediabunnyStages('mp4', 'mp3')[1]!.label).toBe('Extract audio (copy or re-encode)');
  });
});

describe('codec policy', () => {
  it('copies what the container holds, encodes everything else to a common codec', () => {
    expect(wantsCopy('avc', TARGETS.mp4!.copyVideo)).toBe(true);
    expect(wantsCopy('vp8', TARGETS.mp4!.copyVideo)).toBe(false);
    expect(wantsCopy('vp8', TARGETS.webm!.copyVideo)).toBe(true);
    expect(wantsCopy('avc', TARGETS.webm!.copyVideo)).toBe(false);
    expect(wantsCopy('aac', TARGETS.webm!.copyAudio)).toBe(false);
    expect(wantsCopy(null, TARGETS.mkv!.copyAudio)).toBe(false);
    expect(TARGETS.mp4!.encodeVideo).toEqual(['avc']);
    expect(TARGETS.webm!.encodeVideo[0]).toBe('vp8'); // 4x faster than VP9 in Firefox (2.9 s vs 11.9 s for 6 s of 640x360) and matches the ffmpeg engine
    expect(TARGETS.ogg!.encodeAudio).toEqual(['opus']);
    expect(TARGETS.m4a!.encodeAudio).toEqual(['aac']);
  });
  it('wav only copies little-endian PCM; every audio-only target has no video', () => {
    expect(wantsCopy('pcm-s16', TARGETS.wav!.copyAudio)).toBe(true);
    expect(wantsCopy('pcm-s16be', TARGETS.wav!.copyAudio)).toBe(false);
    expect(wantsCopy('pcm-s16be', TARGETS.mov!.copyAudio)).toBe(true);
    for (const t of ['mp3', 'wav', 'flac', 'ogg', 'm4a']) expect(TARGETS[t]!.hasVideo).toBe(false);
    for (const t of ['mp4', 'webm', 'mov', 'mkv']) expect(TARGETS[t]!.hasVideo).toBe(true);
  });
  it('every target has a consistent extension and mime', () => {
    for (const [id, p] of Object.entries(TARGETS)) {
      expect(p.ext).toBe(id);
      expect(p.mime).toMatch(/^(audio|video)\//);
    }
    expect(supportsPair('mp4', 'mp4')).toBe(false);
  });
  it('channelCandidates falls back to stereo then mono, never up-mixes', () => {
    expect(channelCandidates(6)).toEqual([6, 2, 1]);
    expect(channelCandidates(2)).toEqual([2, 1]);
    expect(channelCandidates(1)).toEqual([1]);
  });
});

describe('preview helpers', () => {
  it('thumbnail times are evenly spaced from the first timestamp', () => {
    expect(thumbnailTimes(0, 8)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
    expect(thumbnailTimes(10, 2, 4)).toEqual([10.25, 10.75, 11.25, 11.75]);
    expect(thumbnailTimes(0, 0.1)).toHaveLength(1);
    expect(thumbnailSize(1920, 1080)).toEqual({ width: 96, height: 54 });
    expect(thumbnailSize(64, 64)).toEqual({ width: 64, height: 64 });
  });
  it('PeakAccumulator bins by time, ignores other buckets, scales loudest to 1', () => {
    const acc = new PeakAccumulator(2, 0, 4); // 4 buckets over 2 s
    acc.add(0, 4, new Float32Array([0.1, -0.2])); // t=0..0.5 -> bucket 0
    acc.add(1.5, 4, new Float32Array([0.5, 0.25])); // t=1.5.. -> bucket 3
    const r = acc.result();
    expect(Array.from(r).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.4, 0, 0, 1]);
  });
});

describe('bit depth', () => {
  it('reads FLAC STREAMINFO bits per sample', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { flacBitDepth } = await import('./plan');
    const bytes = (n: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../ffmpeg/fixtures/${n}`, import.meta.url))));
    // build the WebCodecs description the way mediabunny does: "fLaC" + block header + STREAMINFO (starts at byte 8 of the file)
    const desc = (file: Uint8Array) => {
      const d = new Uint8Array(42);
      d.set([0x66, 0x4c, 0x61, 0x43, 128, 0, 0, 34], 0);
      d.set(file.subarray(8, 8 + 34), 8);
      return d;
    };
    expect(flacBitDepth(desc(bytes('sample.flac')))).toBe(16);
    expect(flacBitDepth(desc(bytes('sample-24bit.flac')))).toBe(24);
    expect(flacBitDepth(new Uint8Array(10))).toBeNull();
    expect(flacBitDepth(undefined)).toBeNull();
  });
  it('maps source depth to a sample format that keeps every bit', async () => {
    const { sourceBitDepth, wavCodecFor, flacSampleFormat } = await import('./plan');
    expect(sourceBitDepth('pcm-s24', undefined)).toBe(24);
    expect(sourceBitDepth('pcm-f32', undefined)).toBe(32);
    expect(sourceBitDepth('aac', undefined)).toBeNull();
    expect(wavCodecFor(null)).toBe('pcm-s16');
    expect(wavCodecFor(16)).toBe('pcm-s16');
    expect(wavCodecFor(24)).toBe('pcm-s24');
    expect(wavCodecFor(32)).toBe('pcm-s32');
    expect(flacSampleFormat(16)).toBe('s16');
    expect(flacSampleFormat(24)).toBe('s32');
    expect(flacSampleFormat(null)).toBe('s16');
  });
});
