/**
 * Independent output checks for tests (Node only, never bundled into the app).
 *   - ffprobeBytes: FFmpeg's own demuxers, in a separate wasm instance
 *   - demuxInfo: mediabunny's demuxers (a different implementation)
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { parseProbe, type ProbeInfo } from '../plan';

const require = createRequire(import.meta.url);

type Core = {
  FS: { writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array; unlink(p: string): void };
  exec(...a: string[]): number;
  ffprobe(...a: string[]): number;
  setLogger(f: (m: { type: string; message: string }) => void): void;
  reset(): void;
};
let corePromise: Promise<Core> | null = null;
let lines: string[] = [];

function core(): Promise<Core> {
  corePromise ??= (async () => {
    const g = globalThis as { self?: unknown; location?: unknown };
    g.self ??= globalThis;
    g.location ??= { href: 'file:///verify/' };
    const create = (await import('@ffmpeg/core')).default;
    const wasmBinary = readFileSync(require.resolve('@ffmpeg/core/wasm'));
    const c = (await create({ wasmBinary })) as unknown as Core;
    c.setLogger((m) => {
      if (m.type === 'stdout') lines.push(m.message);
    });
    return c;
  })();
  return corePromise;
}

export interface FfprobeResult extends ProbeInfo {
  raw: { streams: { codec_type?: string; codec_name?: string; nb_read_frames?: string }[]; format: { format_name?: string } };
  /** Decoded frame count of the first video stream (only with countFrames). */
  frames: number | null;
}

export async function ffprobeBytes(bytes: Uint8Array, ext: string, countFrames = false): Promise<FfprobeResult> {
  const c = await core();
  const path = `/verify-input.${ext}`;
  c.FS.writeFile(path, bytes);
  lines = [];
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
  if (countFrames) args.push('-count_frames');
  c.ffprobe(...args, path); // exit code is always -1 in this core; success = JSON on stdout
  c.reset();
  c.FS.unlink(path);
  const text = lines.join('\n');
  let raw: FfprobeResult['raw'];
  try {
    raw = JSON.parse(text) as FfprobeResult['raw'];
  } catch {
    throw new Error(`ffprobe could not read a .${ext} file of ${bytes.length} bytes`);
  }
  const info = parseProbe(text);
  const v = raw.streams.find((s) => s.codec_type === 'video');
  return { ...info, raw, frames: countFrames && v?.nb_read_frames ? Number(v.nb_read_frames) : null };
}

export interface DemuxInfo {
  format: string;
  mime: string;
  durationS: number;
  video: { codec: string | null; width: number; height: number } | null;
  audio: { codec: string | null; sampleRate: number; channels: number } | null;
}

export async function demuxInfo(bytes: Uint8Array): Promise<DemuxInfo> {
  const input = new Input({ source: new BlobSource(new Blob([bytes as Uint8Array<ArrayBuffer>])), formats: ALL_FORMATS });
  try {
    const format = (await input.getFormat()).name;
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    return {
      format,
      mime: await input.getMimeType(),
      durationS: await input.computeDuration(),
      video: v ? { codec: await v.getCodec(), width: await v.getDisplayWidth(), height: await v.getDisplayHeight() } : null,
      audio: a ? { codec: await a.getCodec(), sampleRate: await a.getSampleRate(), channels: await a.getNumberOfChannels() } : null,
    };
  } finally {
    input.dispose();
  }
}

/** Make a media file with FFmpeg's lavfi sources, e.g. makeMedia(['-f','lavfi','-i','testsrc2=size=1280x720:rate=25:duration=1','-c:v','libx264'], 'big.mp4'). */
export async function makeMedia(args: string[], outName: string): Promise<Uint8Array> {
  const c = await core();
  const ret = c.exec('-hide_banner', '-loglevel', 'error', ...args, outName);
  c.reset();
  if (ret !== 0) throw new Error(`makeMedia failed for ${outName}`);
  const out = c.FS.readFile(outName);
  c.FS.unlink(outName);
  return out;
}

/**
 * MD5 of the decoded audio (32-bit PCM), so two files can be compared sample for sample:
 * equal digests mean a bit-exact lossless conversion.
 */
export async function audioDigest(bytes: Uint8Array, ext: string): Promise<string> {
  const c = await core();
  const input = `/digest-input.${ext}`;
  c.FS.writeFile(input, bytes);
  const ret = c.exec('-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:a:0', '-c:a', 'pcm_s32le', '-f', 'md5', '/digest.md5');
  c.reset();
  c.FS.unlink(input);
  if (ret !== 0) throw new Error(`could not decode a .${ext} file for hashing`);
  const out = new TextDecoder().decode(c.FS.readFile('/digest.md5')).trim();
  c.FS.unlink('/digest.md5');
  return out;
}
