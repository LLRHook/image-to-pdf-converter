/**
 * Pure planning for the FFmpeg engine: which pairs it supports, which stages
 * it reports, and the exact ffmpeg argument lists for each conversion.
 * No library imports, so edges.ts can use it on the main thread.
 */
import type { FormatId } from '../../core/formats';
import type { StageId, StageSpec } from '../../core/types';

export const VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'mkv'] as const;
export const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'ogg', 'm4a'] as const;

const isVideo = (f: string) => (VIDEO_FORMATS as readonly string[]).includes(f);
const isAudio = (f: string) => (AUDIO_FORMATS as readonly string[]).includes(f);

/** All formats this engine reads. */
export const READS: readonly FormatId[] = [...VIDEO_FORMATS, ...AUDIO_FORMATS, 'gif'];
/** All formats this engine writes. */
export const WRITES: readonly FormatId[] = [...VIDEO_FORMATS, ...AUDIO_FORMATS, 'gif'];

export function supportsPair(from: FormatId, to: FormatId): boolean {
  if (from === to) return false;
  if (from === 'gif') return to === 'mp4' || to === 'webm';
  if (to === 'gif') return isVideo(from);
  if (isVideo(from)) return isVideo(to) || isAudio(to);
  if (isAudio(from)) return isAudio(to);
  return false;
}

/* ------------------------------------------------------------------ limits */

export const MAX_INPUT_BYTES = 1.5 * 1024 ** 3;
/** Largest frame ffmpeg is asked to encode in wasm (3840x2160). */
export const MAX_PIXELS = 3840 * 2160;
/** Output files live in the 2 GiB wasm heap next to the encoder. */
export const MAX_PCM_OUTPUT_BYTES = 1.2 * 1024 ** 3;
export const GIF_MAX_SECONDS = 300;
export const GIF_DEFAULT_FPS = 15;
export const GIF_DEFAULT_WIDTH = 640;
/** Previews are skipped above this input size: they cost an extra decode. */
export const PREVIEW_MAX_BYTES = 200 * 1024 ** 2;
export const WAVEFORM_MAX_SECONDS = 1800;

/* ------------------------------------------------------------------ labels */

const SHORT: Record<string, string> = {
  mp4: 'MP4',
  webm: 'WebM',
  mov: 'MOV',
  mkv: 'MKV',
  mp3: 'MP3',
  wav: 'WAV',
  flac: 'FLAC',
  ogg: 'Ogg',
  m4a: 'M4A',
  gif: 'GIF',
};
export const shortName = (f: string) => SHORT[f] ?? f.toUpperCase();

/** What the encoder stage actually produces, as shown to the user. */
export function targetDescription(to: FormatId): string {
  switch (to) {
    case 'mp4':
    case 'mov':
    case 'mkv':
      return 'H.264 + AAC';
    case 'webm':
      return 'VP8 + Opus';
    case 'mp3':
      return 'MP3 (LAME VBR)';
    case 'ogg':
      return 'Opus in Ogg';
    case 'flac':
      return 'FLAC';
    case 'wav':
      return 'PCM audio';
    case 'm4a':
      return 'AAC';
    case 'gif':
      return 'GIF';
    default:
      return shortName(to);
  }
}

export function ffmpegStages(from: FormatId, to: FormatId): StageSpec[] {
  const stages: StageSpec[] = [
    { id: 'load', label: 'Load FFmpeg (WebAssembly)' },
    { id: 'read', label: from === 'gif' ? 'Probe GIF frames' : `Probe ${shortName(from)} streams` },
  ];
  if (to === 'gif') stages.push({ id: 'transform', label: 'Build 256-colour palette' });
  stages.push({
    id: 'encode',
    label: to === 'gif' ? 'Encode GIF with palette' : isAudio(to) && isVideo(from) ? `Extract audio as ${targetDescription(to)}` : `Encode ${targetDescription(to)}`,
  });
  stages.push({ id: 'package', label: `Write ${shortName(to)} file` });
  return stages;
}

/* ------------------------------------------------------------------- probe */

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  fps: number | null;
  /** Clockwise rotation (degrees) applied on display. */
  rotation: number;
}
export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  /** Bits per sample of the source, when it is a PCM-like or lossless codec. */
  bits: number | null;
  sampleFormat: string | null;
}
export interface ProbeInfo {
  durationS: number | null;
  formatName: string;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  bits_per_raw_sample?: string;
  bits_per_sample?: number;
  sample_fmt?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

function ratio(s: string | undefined): number | null {
  if (!s) return null;
  const [a, b] = s.split('/').map(Number);
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const v = a / b;
  return v > 0 && v < 1000 ? v : null;
}

/** Parse `ffprobe -print_format json -show_format -show_streams`. Throws if it is not JSON. */
export function parseProbe(json: string): ProbeInfo {
  const data = JSON.parse(json) as { format?: { duration?: string; format_name?: string }; streams?: RawStream[] };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.width && s.height);
  const a = streams.find((s) => s.codec_type === 'audio');
  let duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const cands = [v, a].map((s) => Number(s?.duration)).filter((d) => Number.isFinite(d) && d > 0);
    duration = cands.length ? Math.max(...cands) : NaN;
  }
  const rotRaw = v?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(v?.tags?.rotate ?? 0);
  const rotation = ((Math.round(-(Number.isFinite(rotRaw) ? rotRaw : 0)) % 360) + 360) % 360;
  return {
    durationS: Number.isFinite(duration) ? duration : null,
    formatName: data.format?.format_name ?? '',
    video: v
      ? {
          codec: v.codec_name ?? 'unknown',
          width: v.width!,
          height: v.height!,
          fps: ratio(v.avg_frame_rate) ?? ratio(v.r_frame_rate),
          rotation,
        }
      : null,
    audio: a
      ? {
          codec: a.codec_name ?? 'unknown',
          sampleRate: Number(a.sample_rate) || 0,
          channels: a.channels ?? 0,
          bits: Number(a.bits_per_raw_sample) || a.bits_per_sample || null,
          sampleFormat: a.sample_fmt ?? null,
        }
      : null,
  };
}

/** Frame size after the display rotation ffmpeg applies automatically. */
export function displaySize(v: VideoStreamInfo): { width: number; height: number } {
  return v.rotation === 90 || v.rotation === 270 ? { width: v.height, height: v.width } : { width: v.width, height: v.height };
}

/* ------------------------------------------------------------------ limits */

/** Throws a user-readable Error when the input or its probe is outside what this engine will attempt. */
export function checkLimits(from: FormatId, to: FormatId, probe: ProbeInfo, options: Options = {}): void {
  const wantsVideo = isVideo(to) || to === 'gif';
  if (wantsVideo && !probe.video) {
    throw new Error(`This ${shortName(from)} file has no video stream to convert to ${shortName(to)}.`);
  }
  if (isAudio(to) && !probe.audio) {
    throw new Error(`This ${shortName(from)} file has no audio track, so there is nothing to extract as ${shortName(to)}.`);
  }
  if (probe.video && wantsVideo) {
    const { width, height } = displaySize(probe.video);
    if (width * height > MAX_PIXELS) {
      throw new Error(
        `This video is ${width}×${height}. FFmpeg in the browser handles up to 3840×2160; try a smaller file or a browser with hardware encoding.`,
      );
    }
  }
  if (to === 'gif' && probe.durationS !== null && probe.durationS > (options.gifMaxSeconds ?? GIF_MAX_SECONDS)) {
    throw new Error(
      `GIF output is limited to ${Math.round(options.gifMaxSeconds ?? GIF_MAX_SECONDS)} seconds; this video is ${Math.round(probe.durationS)} s long. Trim it first.`,
    );
  }
  if (to === 'wav' && probe.audio && probe.durationS !== null) {
    const bytes = probe.durationS * probe.audio.sampleRate * probe.audio.channels * (wavCodec(probe.audio).bytes);
    if (bytes > MAX_PCM_OUTPUT_BYTES) {
      throw new Error(`The WAV file would be about ${(bytes / 1024 ** 3).toFixed(1)} GB, more than the browser can hold. Choose FLAC instead.`);
    }
  }
}

/* ------------------------------------------------------------------- plans */

export interface Options {
  gifFps?: number;
  gifMaxWidth?: number;
  gifMaxSeconds?: number;
}

export interface Pass {
  stage: StageId;
  args: string[];
  /** Output time advances while this pass runs, so `time / duration` is real progress. */
  measured: boolean;
}

export interface Plan {
  passes: Pass[];
  output: string;
  /** Intermediate files to delete as well. */
  scratch: string[];
  ext: string;
  mime: string;
  /** Human log line describing what will run. */
  summary: string;
}

export const WORK_DIR = '/work';

/** Demuxers ffmpeg may use on untrusted input: only our containers, never playlists or scripts. */
export const FORMAT_WHITELIST =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,mp3,wav,flac,aac,gif,mpegts,avi';

const INPUT_GUARD = ['-format_whitelist', FORMAT_WHITELIST, '-protocol_whitelist', 'file'];

function wavCodec(a: AudioStreamInfo): { codec: string; bytes: number } {
  if (a.sampleFormat && /^f(lt|ltp)$/.test(a.sampleFormat) && /^pcm_f32/.test(a.codec)) return { codec: 'pcm_f32le', bytes: 4 };
  if ((a.bits ?? 0) > 16 && /^(flac|pcm_|alac|wav)/.test(a.codec)) return { codec: 'pcm_s24le', bytes: 3 };
  return { codec: 'pcm_s16le', bytes: 2 };
}

/** Target video bitrate cap for VP8: ~0.07 bit per pixel per frame, clamped. */
export function vp8Bitrate(width: number, height: number, fps: number | null): number {
  const raw = width * height * Math.min(fps ?? 30, 60) * 0.07;
  return Math.round(Math.min(12_000_000, Math.max(250_000, raw)));
}

const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

export function buildPlan(from: FormatId, to: FormatId, input: string, probe: ProbeInfo, options: Options = {}): Plan {
  if (!supportsPair(from, to)) throw new Error(`FFmpeg engine does not convert ${from} to ${to}.`);
  const output = `${WORK_DIR}/output.${to === 'gif' ? 'gif' : to}`;
  // The core's progress callback is driven by ffmpeg's stats. Option globals survive between runs in
  // the same wasm instance, so -stats must be explicit: an earlier -nostats (previews) would stick.
  const base = ['-hide_banner', '-stats', '-stats_period', '0.25', '-loglevel', 'warning'];
  const head = [...base, ...INPUT_GUARD, '-i', input];
  const info = formatTargets[to] ?? { ext: to, mime: 'application/octet-stream' };

  if (to === 'gif') {
    const fps = Math.min(options.gifFps ?? GIF_DEFAULT_FPS, probe.video?.fps ?? GIF_DEFAULT_FPS, 60);
    const width = Math.max(16, Math.round(options.gifMaxWidth ?? GIF_DEFAULT_WIDTH));
    const fpsText = String(Math.round(fps * 100) / 100);
    const shape = `fps=${fpsText},scale=min(${width}\\,iw):-2:flags=lanczos`;
    const palette = `${WORK_DIR}/palette.png`;
    return {
      passes: [
        {
          stage: 'transform',
          // palettegen only emits at end of stream: no honest percentage.
          measured: false,
          args: [...head, '-an', '-sn', '-dn', '-vf', `${shape},palettegen=stats_mode=diff`, '-update', '1', palette],
        },
        {
          stage: 'encode',
          measured: true,
          args: [
            ...base,
            ...INPUT_GUARD,
            '-i',
            input,
            '-i',
            palette,
            '-an',
            '-sn',
            '-dn',
            '-lavfi',
            `${shape}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
            '-loop',
            '0',
            output,
          ],
        },
      ],
      output,
      scratch: [palette],
      ext: 'gif',
      mime: 'image/gif',
      summary: `GIF ${fpsText} fps, max ${width}px wide, two-pass palette`,
    };
  }

  const encode = (args: string[]): Plan => ({
    passes: [{ stage: 'encode', measured: true, args: [...head, ...args, output] }],
    output,
    scratch: [],
    ext: info.ext,
    mime: info.mime,
    summary: targetDescription(to),
  });

  switch (to) {
    case 'mp4':
    case 'mov':
    case 'mkv': {
      // gif input is variable frame rate with 10 ms ticks; keep its real timing.
      const sync = from === 'gif' ? ['-vsync', 'vfr'] : [];
      return encode([
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', ...sync,
        '-vf', EVEN, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k',
        ...(to === 'mkv' ? [] : ['-movflags', '+faststart']),
      ]);
    }
    case 'webm': {
      const v = probe.video;
      const size = v ? displaySize(v) : { width: 1280, height: 720 };
      const sync = from === 'gif' ? ['-vsync', 'vfr'] : [];
      // libvpx-vp9 traps ("memory access out of bounds") in the single-thread wasm core at every
      // size and setting tried, so WebM is VP8, which encodes at ~7x realtime for 640x360.
      return encode([
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', ...sync,
        '-vf', EVEN, '-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '5', '-crf', '10',
        '-b:v', String(vp8Bitrate(size.width, size.height, v?.fps ?? null)), '-pix_fmt', 'yuv420p',
        '-c:a', 'libopus', '-b:a', '128k',
      ]);
    }
    case 'mp3':
      return encode(['-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2']);
    case 'ogg':
      return encode(['-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'libopus', '-b:a', '128k']);
    case 'flac': {
      // The FLAC encoder defaults to 16-bit input: ask for 32-bit samples (24 valid bits) when the source has more.
      const deep = (probe.audio?.bits ?? 0) > 16 && /^(flac|pcm_|alac|wav)/.test(probe.audio?.codec ?? '');
      const depth = deep ? (probe.audio!.bits! > 24 ? [] : ['-bits_per_raw_sample', '24']) : [];
      return encode(['-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'flac', ...(deep ? ['-sample_fmt', 's32', ...depth] : [])]);
    }
    case 'wav':
      return encode(['-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', probe.audio ? wavCodec(probe.audio).codec : 'pcm_s16le']);
    case 'm4a':
      return encode(['-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']);
    default:
      throw new Error(`FFmpeg engine cannot write ${to}.`);
  }
}

const formatTargets: Record<string, { ext: string; mime: string }> = {
  mp4: { ext: 'mp4', mime: 'video/mp4' },
  webm: { ext: 'webm', mime: 'video/webm' },
  mov: { ext: 'mov', mime: 'video/quicktime' },
  mkv: { ext: 'mkv', mime: 'video/x-matroska' },
  mp3: { ext: 'mp3', mime: 'audio/mpeg' },
  wav: { ext: 'wav', mime: 'audio/wav' },
  flac: { ext: 'flac', mime: 'audio/flac' },
  ogg: { ext: 'ogg', mime: 'audio/ogg' },
  m4a: { ext: 'm4a', mime: 'audio/mp4' },
  gif: { ext: 'gif', mime: 'image/gif' },
};

/** Fraction of the conversion done, from ffmpeg's reported output time. Null when not measurable. */
export function progressFraction(timeUs: number, durationS: number | null): number | null {
  if (durationS === null || durationS <= 0 || !Number.isFinite(timeUs) || timeUs < 0) return null;
  const t = timeUs / 1e6;
  // The very first callback of a run can carry an unset timestamp (~1.5e12 us): not a measurement.
  if (t > durationS * 1.5 + 2) return null;
  return Math.min(1, t / durationS);
}

/** Make the thumbnail time list: `count` evenly spaced timestamps through the duration. */
export function thumbnailTimes(durationS: number, count: number): number[] {
  const n = Math.max(1, Math.min(count, Math.floor(durationS * 4) || 1));
  return Array.from({ length: n }, (_, i) => (durationS * (i + 0.5)) / n);
}

/** Fit a frame into a box with the longer side at `max`, even-or-odd, never zero. */
export function thumbnailSize(width: number, height: number, max = 96): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** Reduce signed 16-bit mono PCM to `buckets` peak values, 0..1, scaled so the loudest bucket is 1. */
export function waveformPeaks(pcm: Int16Array, buckets = 256): Float32Array {
  const out = new Float32Array(buckets);
  if (pcm.length === 0) return out;
  for (let i = 0; i < pcm.length; i++) {
    const b = Math.min(buckets - 1, Math.floor((i * buckets) / pcm.length));
    const v = Math.abs(pcm[i]!);
    if (v > out[b]!) out[b] = v;
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < buckets; i++) out[i] = out[i]! / max;
  return out;
}

/** Pick the most informative last lines of ffmpeg's stderr as a user-readable reason. */
export function explainFailure(stderr: readonly string[], to: FormatId): string {
  const text = stderr.join('\n');
  if (/Format not on whitelist|Invalid data found when processing input|moov atom not found|EBML header parsing failed/i.test(text)) {
    return 'This file is damaged or is not the format its extension says.';
  }
  const decoder = /Decoder \(codec ([^)]+)\) not found|Unsupported codec with id (\d+)/i.exec(text);
  if (decoder) return `FFmpeg cannot decode this file's ${decoder[1] ?? 'audio/video'} codec in the browser.`;
  if (/hardware accelerated AV1 decoding/i.test(text)) return 'FFmpeg cannot decode AV1 video in the browser.';
  if (/Stream map .* matches no streams/i.test(text)) return `This file has no streams that can be written as ${shortName(to)}.`;
  const last = [...stderr].reverse().find((l) => /error|invalid|cannot|could not|unable|not supported/i.test(l));
  return last ? `FFmpeg could not convert this file: ${last.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200)}` : 'FFmpeg could not convert this file.';
}
