/**
 * Pure planning for the mediabunny (WebCodecs) engine: supported pairs,
 * stage labels and the codec policy for each target container.
 * No library imports, so edges.ts can use it on the main thread.
 */
import { formatInfo, type FormatId } from '../../core/formats';
import type { StageSpec } from '../../core/types';
import { AUDIO_FORMATS, VIDEO_FORMATS, isAudio, isVideo, shortName } from '../shared/media';

export const READS: readonly FormatId[] = [...VIDEO_FORMATS, ...AUDIO_FORMATS];
export const WRITES: readonly FormatId[] = [...VIDEO_FORMATS, ...AUDIO_FORMATS];

export function supportsPair(from: FormatId, to: FormatId): boolean {
  if (from === to) return false;
  if (isVideo(from)) return isVideo(to) || isAudio(to);
  if (isAudio(from)) return isAudio(to);
  return false;
}

export function mediabunnyStages(from: FormatId, to: FormatId): StageSpec[] {
  return [
    { id: 'read', label: `Demux ${shortName(from)}` },
    {
      id: 'transform',
      label: isVideo(from) && isAudio(to) ? 'Extract audio (copy or re-encode)' : 'Remux or re-encode tracks',
    },
    { id: 'package', label: `Mux ${shortName(to)}` },
  ];
}

/* ------------------------------------------------------------ codec policy */

export type VideoCodecName = 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8' | 'prores';
export type AudioCodecName = 'aac' | 'opus' | 'mp3' | 'vorbis' | 'flac' | string;

export interface TargetPolicy {
  ext: string;
  mime: string;
  /** Source codecs that are copied into this container untouched. */
  copyVideo: readonly string[];
  copyAudio: readonly string[];
  /** Codecs to encode to, best first. */
  encodeVideo: readonly VideoCodecName[];
  encodeAudio: readonly AudioCodecName[];
  hasVideo: boolean;
}

/** Little-endian PCM is what WAV holds; QuickTime also takes big-endian. */
const PCM_LE = ['pcm-s16', 'pcm-s24', 'pcm-s32', 'pcm-f32', 'pcm-f64', 'pcm-u8'];
const PCM_ALL = [...PCM_LE, 'pcm-s16be', 'pcm-s24be', 'pcm-s32be', 'pcm-f32be', 'pcm-f64be'];

type Policy = Omit<TargetPolicy, 'ext' | 'mime'>;
/** Extension and MIME type come from the format catalog. */
const target = (id: FormatId, p: Policy): TargetPolicy => ({ ext: formatInfo(id).exts[0]!, mime: formatInfo(id).mime, ...p });

/**
 * WebM prefers VP8 over VP9 when encoding: measured on 6 s of 640x360, Firefox needs 2.9 s for VP8 but
 * 11.9 s for VP9 (Chromium 0.6 s vs 0.8 s, WebKit 0.7 s vs 0.7 s), and the ffmpeg engine writes VP8 too.
 * Tracks that are already VP9/AV1 are still copied.
 */

export const TARGETS: Record<string, TargetPolicy> = {
  mp4: target('mp4', { hasVideo: true, copyVideo: ['avc', 'hevc', 'vp9', 'av1'], copyAudio: ['aac', 'mp3'], encodeVideo: ['avc'], encodeAudio: ['aac'] }),
  mov: target('mov', { hasVideo: true, copyVideo: ['avc', 'hevc', 'prores'], copyAudio: ['aac', 'mp3', ...PCM_ALL], encodeVideo: ['avc'], encodeAudio: ['aac'] }),
  mkv: target('mkv', { hasVideo: true, copyVideo: ['avc', 'hevc', 'vp8', 'vp9', 'av1'], copyAudio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'], encodeVideo: ['avc', 'vp9', 'vp8'], encodeAudio: ['aac', 'opus'] }),
  webm: target('webm', { hasVideo: true, copyVideo: ['vp8', 'vp9', 'av1'], copyAudio: ['opus', 'vorbis'], encodeVideo: ['vp8', 'vp9'], encodeAudio: ['opus'] }),
  mp3: target('mp3', { hasVideo: false, copyVideo: [], copyAudio: ['mp3'], encodeVideo: [], encodeAudio: ['mp3'] }),
  wav: target('wav', { hasVideo: false, copyVideo: [], copyAudio: PCM_LE, encodeVideo: [], encodeAudio: ['pcm-s16'] }),
  flac: target('flac', { hasVideo: false, copyVideo: [], copyAudio: ['flac'], encodeVideo: [], encodeAudio: ['flac'] }),
  ogg: target('ogg', { hasVideo: false, copyVideo: [], copyAudio: ['opus', 'vorbis'], encodeVideo: [], encodeAudio: ['opus'] }),
  m4a: target('m4a', { hasVideo: false, copyVideo: [], copyAudio: ['aac'], encodeVideo: [], encodeAudio: ['aac'] }),
};

/** Copy when the container takes the source codec as is, otherwise encode (codec chosen by the caller). */
export function wantsCopy(sourceCodec: string | null, allowed: readonly string[]): boolean {
  return sourceCodec !== null && allowed.includes(sourceCodec);
}

/** Channel counts to try, best first: the source's, then stereo, then mono. */
export function channelCandidates(channels: number): number[] {
  return [...new Set([channels, 2, 1])].filter((c) => c >= 1 && c <= channels);
}

/* -------------------------------------------------------------- bit depth */

/** Bits per sample of a FLAC track, from the STREAMINFO block in its decoder description. */
export function flacBitDepth(description: ArrayBufferLike | ArrayBufferView | undefined | null): number | null {
  if (!description) return null;
  const b = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  // "fLaC" + 4-byte block header + 34-byte STREAMINFO; bits-per-sample-1 straddles bytes 12 and 13 of the body.
  if (b.length < 8 + 14 || b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) return null;
  const depth = (((b[8 + 12]! & 1) << 4) | (b[8 + 13]! >> 4)) + 1;
  return depth >= 4 && depth <= 32 ? depth : null;
}

/** Sample depth of a source track when it is knowable without decoding; null for lossy codecs. */
export function sourceBitDepth(codec: string | null, description?: ArrayBufferLike | ArrayBufferView | null): number | null {
  if (!codec) return null;
  if (codec === 'flac') return flacBitDepth(description);
  const m = /^pcm-([sfu])(\d+)/.exec(codec);
  if (!m) return null;
  return Number(m[2]);
}

/** WAV sample format that keeps every bit of a source of this depth (16 when unknown or lossy). */
export function wavCodecFor(depth: number | null): 'pcm-s16' | 'pcm-s24' | 'pcm-s32' {
  if (depth === null || depth <= 16) return 'pcm-s16';
  return depth <= 24 ? 'pcm-s24' : 'pcm-s32';
}

/** Sample format handed to the FLAC encoder so it writes the source's depth. */
export function flacSampleFormat(depth: number | null): 's16' | 's32' {
  return depth !== null && depth > 16 ? 's32' : 's16';
}

/* ------------------------------------------------------------- limits */

/** Preview work is dropped, not waited for, after this long. */
export const PREVIEW_BUDGET_MS = 4000;

/** Accumulates per-bucket peaks while samples stream in, then normalises so the loudest bucket is 1. */
export class PeakAccumulator {
  readonly peaks: Float32Array;
  constructor(
    private readonly durationS: number,
    private readonly firstTs: number,
    buckets = 256,
  ) {
    this.peaks = new Float32Array(buckets);
  }

  add(startTs: number, sampleRate: number, samples: Float32Array) {
    const n = this.peaks.length;
    const span = this.durationS || 1;
    for (let i = 0; i < samples.length; i++) {
      const t = (startTs - this.firstTs + i / sampleRate) / span;
      const b = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
      const v = Math.abs(samples[i]!);
      if (v > this.peaks[b]!) this.peaks[b] = v;
    }
  }

  result(): Float32Array {
    let max = 0;
    for (const v of this.peaks) if (v > max) max = v;
    const out = new Float32Array(this.peaks.length);
    if (max > 0) for (let i = 0; i < out.length; i++) out[i] = Math.min(1, this.peaks[i]! / max);
    return out;
  }
}
