/**
 * Audio/video facts shared by the mediabunny and FFmpeg engines. Pure data:
 * no library imports, so both engines' edges.ts can use it on the main thread.
 */
import { FORMATS, formatInfo, type Family, type FormatId } from '../../core/formats';

const ofFamily = (family: Family): FormatId[] => FORMATS.filter((f) => f.family === family).map((f) => f.id);

/** Video and audio formats of the catalog, in catalog order. */
export const VIDEO_FORMATS: readonly FormatId[] = ofFamily('video');
export const AUDIO_FORMATS: readonly FormatId[] = ofFamily('audio');

export const isVideo = (f: FormatId) => formatInfo(f).family === 'video';
export const isAudio = (f: FormatId) => formatInfo(f).family === 'audio';

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
/** Container names as shown in stage labels and messages. */
export const shortName = (f: string) => SHORT[f] ?? f.toUpperCase();

/** Previews are skipped above this input size: they cost an extra decode. */
export const PREVIEW_MAX_BYTES = 200 * 1024 ** 2;
export const WAVEFORM_MAX_SECONDS = 1800;

/** `count` evenly spaced thumbnail timestamps through the duration, starting at `firstTs`. */
export function thumbnailTimes(durationS: number, count = 8, firstTs = 0): number[] {
  const n = Math.max(1, Math.min(count, Math.floor(durationS * 4) || 1));
  return Array.from({ length: n }, (_, i) => firstTs + (durationS * (i + 0.5)) / n);
}
