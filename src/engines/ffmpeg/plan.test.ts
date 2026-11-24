import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  checkLimits,
  displaySize,
  explainFailure,
  ffmpegStages,
  parseProbe,
  progressFraction,
  supportsPair,
  vp8Bitrate,
  waveformPeaks,
  type ProbeInfo,
} from './plan';
import { thumbnailTimes } from '../shared/media';
import { thumbnailSize } from '../shared/thumbnail';

const probe = (over: Partial<ProbeInfo> = {}): ProbeInfo => ({
  durationS: 10,
  formatName: 'mov,mp4',
  video: { codec: 'h264', width: 1280, height: 720, fps: 30, rotation: 0 },
  audio: { codec: 'aac', sampleRate: 48000, channels: 2, bits: null, sampleFormat: 'fltp' },
  ...over,
});

describe('supportsPair', () => {
  it('allows video/audio conversions, extraction, gif, and nothing else', () => {
    expect(supportsPair('mp4', 'webm')).toBe(true);
    expect(supportsPair('mkv', 'mp3')).toBe(true);
    expect(supportsPair('flac', 'ogg')).toBe(true);
    expect(supportsPair('mp4', 'gif')).toBe(true);
    expect(supportsPair('gif', 'webm')).toBe(true);
    expect(supportsPair('mp3', 'mp4')).toBe(false);
    expect(supportsPair('gif', 'wav')).toBe(false);
    expect(supportsPair('mp4', 'mp4')).toBe(false);
    expect(supportsPair('png', 'mp4')).toBe(false);
  });
});

describe('stages', () => {
  it('lists load, read, encode, package; gif adds a palette stage', () => {
    expect(ffmpegStages('mp4', 'webm').map((s) => s.id)).toEqual(['load', 'read', 'encode', 'package']);
    expect(ffmpegStages('mp4', 'gif').map((s) => s.id)).toEqual(['load', 'read', 'transform', 'encode', 'package']);
    expect(ffmpegStages('mp4', 'mp3').find((s) => s.id === 'encode')?.label).toBe('Extract audio as MP3 (LAME VBR)');
    expect(ffmpegStages('gif', 'mp4')[1]!.label).toBe('Probe GIF frames');
  });
});

describe('buildPlan', () => {
  it('mp4/mov/mkv use x264 crf 23 veryfast + aac; mp4 and mov are faststart', () => {
    for (const to of ['mp4', 'mov', 'mkv'] as const) {
      const a = buildPlan('webm', to, '/in/input.webm', probe()).passes[0]!.args;
      expect(a).toEqual(expect.arrayContaining(['libx264', '-preset', 'veryfast', '-crf', '23', 'aac']));
      expect(a.at(-1)).toBe(`/work/output.${to}`);
      expect(a.includes('+faststart')).toBe(to !== 'mkv');
    }
  });
  it('webm uses VP8 (VP9 traps in the wasm core) + Opus with a pixel-scaled bitrate cap', () => {
    const a = buildPlan('mp4', 'webm', '/in/input.mp4', probe()).passes[0]!.args;
    expect(a).toEqual(expect.arrayContaining(['libvpx', 'libopus']));
    expect(a).not.toContain('libvpx-vp9');
    expect(a[a.indexOf('-b:v') + 1]).toBe(String(vp8Bitrate(1280, 720, 30)));
  });
  it('audio targets drop video and map the first audio stream', () => {
    expect(buildPlan('mp4', 'mp3', '/in/x', probe()).passes[0]!.args).toEqual(expect.arrayContaining(['-vn', 'libmp3lame', '-q:a', '2']));
    expect(buildPlan('wav', 'flac', '/in/x', probe()).passes[0]!.args).toContain('flac');
    expect(buildPlan('wav', 'ogg', '/in/x', probe()).passes[0]!.args).toContain('libopus');
    expect(buildPlan('wav', 'm4a', '/in/x', probe()).passes[0]!.args).toContain('aac');
  });
  it('wav keeps 24-bit lossless sources at 24 bits and everything else at 16', () => {
    const a24 = probe({ audio: { codec: 'flac', sampleRate: 96000, channels: 2, bits: 24, sampleFormat: 's32' } });
    expect(buildPlan('flac', 'wav', '/in/x', a24).passes[0]!.args).toContain('pcm_s24le');
    expect(buildPlan('mp3', 'wav', '/in/x', probe()).passes[0]!.args).toContain('pcm_s16le');
  });
  it('gif is two passes capped at 15 fps and 640 px, never above the source fps', () => {
    const p = buildPlan('mp4', 'gif', '/in/x', probe({ video: { codec: 'h264', width: 1920, height: 1080, fps: 24, rotation: 0 } }));
    expect(p.passes.map((x) => x.stage)).toEqual(['transform', 'encode']);
    expect(p.passes[0]!.measured).toBe(false);
    expect(p.passes[1]!.measured).toBe(true);
    const joined = p.passes.map((x) => x.args.join(' ')).join('\n');
    expect(joined).toContain('fps=15,scale=min(640\\,iw):-2');
    expect(joined).toContain('palettegen');
    expect(joined).toContain('paletteuse');
    const slow = buildPlan('mp4', 'gif', '/in/x', probe({ video: { codec: 'h264', width: 64, height: 64, fps: 8, rotation: 0 } }));
    expect(slow.passes[0]!.args.join(' ')).toContain('fps=8,');
  });
  it('every pass turns stats on explicitly (an earlier -nostats would otherwise stick and silence progress)', () => {
    for (const [f, t] of [['mp4', 'webm'], ['mp4', 'gif'], ['wav', 'mp3']] as const) {
      for (const pass of buildPlan(f, t, '/in/x', probe()).passes) {
        expect(pass.args).toEqual(expect.arrayContaining(['-stats', '-stats_period', '0.25']));
        expect(pass.args).not.toContain('-nostats');
      }
    }
  });
  it('every plan restricts demuxers and protocols on untrusted input', () => {
    for (const [f, t] of [['mp4', 'webm'], ['wav', 'mp3'], ['mp4', 'gif']] as const) {
      for (const pass of buildPlan(f, t, '/in/x', probe()).passes) {
        expect(pass.args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-format_whitelist']));
      }
    }
  });
  it('gif input keeps its variable frame timing', () => {
    expect(buildPlan('gif', 'mp4', '/in/x', probe()).passes[0]!.args).toEqual(expect.arrayContaining(['-vsync', 'vfr']));
  });
});

describe('parseProbe', () => {
  const json = JSON.stringify({
    format: { duration: '2.50', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', width: 10, height: 10, disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2, sample_fmt: 'fltp' },
    ],
  });
  it('picks the real video stream, display rotation, fps and audio', () => {
    const p = parseProbe(json);
    expect(p.durationS).toBe(2.5);
    expect(p.video?.codec).toBe('h264');
    expect(p.video?.rotation).toBe(90);
    expect(displaySize(p.video!)).toEqual({ width: 1920, height: 1080 });
    expect(p.video?.fps).toBeCloseTo(29.97, 2);
    expect(p.audio).toMatchObject({ codec: 'aac', sampleRate: 44100, channels: 2 });
  });
  it('falls back to stream duration and tolerates missing pieces', () => {
    const p = parseProbe(JSON.stringify({ format: {}, streams: [{ codec_type: 'audio', codec_name: 'mp3', duration: '3.1', sample_rate: '8000', channels: 1 }] }));
    expect(p.durationS).toBeCloseTo(3.1);
    expect(p.video).toBeNull();
  });
  it('throws on non-JSON', () => {
    expect(() => parseProbe('nope')).toThrow();
  });
});

describe('limits', () => {
  it('rejects missing streams, huge frames, long gifs, huge wavs', () => {
    expect(() => checkLimits('mp4', 'mp3', 'mp4' === 'mp4' ? probe({ audio: null }) : probe())).toThrow(/no audio track/);
    expect(() => checkLimits('mp3', 'mp4', probe({ video: null }))).toThrow(/no video stream/);
    expect(() => checkLimits('mp4', 'webm', probe({ video: { codec: 'h264', width: 7680, height: 4320, fps: 30, rotation: 0 } }))).toThrow(/3840/);
    expect(() => checkLimits('mp4', 'gif', probe({ durationS: 900 }))).toThrow(/limited to 300 seconds/);
    expect(() => checkLimits('flac', 'wav', probe({ durationS: 36000, audio: { codec: 'flac', sampleRate: 96000, channels: 2, bits: 24, sampleFormat: 's32' } }))).toThrow(/Choose FLAC/);
    expect(() => checkLimits('mp4', 'webm', probe())).not.toThrow();
  });
});

describe('helpers', () => {
  it('progressFraction is real or null', () => {
    expect(progressFraction(2_500_000, 10)).toBe(0.25);
    expect(progressFraction(10_100_000, 10)).toBe(1);
    expect(progressFraction(1_537_228_672_809_130, 10)).toBeNull(); // unset timestamp on the first callback
    expect(progressFraction(Number.NaN, 10)).toBeNull();
    expect(progressFraction(1_000_000, null)).toBeNull();
    expect(progressFraction(-1, 10)).toBeNull();
  });
  it('thumbnails are evenly spaced and fit 96 px', () => {
    expect(thumbnailTimes(8, 8)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
    expect(thumbnailTimes(0.3, 8).length).toBe(1);
    expect(thumbnailSize(1920, 1080)).toEqual({ width: 96, height: 54 });
    expect(thumbnailSize(32, 32)).toEqual({ width: 32, height: 32 });
    expect(thumbnailSize(1080, 1920)).toEqual({ width: 54, height: 96 });
  });
  it('waveformPeaks buckets by position and normalises to 1', () => {
    const pcm = new Int16Array(1000);
    pcm[10] = 1000;
    pcm[990] = -2000;
    const peaks = waveformPeaks(pcm, 10);
    expect(peaks.length).toBe(10);
    expect(peaks[0]).toBe(0.5);
    expect(peaks[9]).toBe(1);
    expect(waveformPeaks(new Int16Array(0), 4)).toEqual(new Float32Array(4));
  });
  it('explainFailure maps ffmpeg stderr to a reason', () => {
    expect(explainFailure(['x: Invalid data found when processing input'], 'mp3')).toMatch(/damaged/);
    expect(explainFailure(['Decoder (codec av1) not found for input stream #0:0'], 'mp4')).toMatch(/av1/);
    expect(explainFailure([], 'mp4')).toBe('FFmpeg could not convert this file.');
  });
});
