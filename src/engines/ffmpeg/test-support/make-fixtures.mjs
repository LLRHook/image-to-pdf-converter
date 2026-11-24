/**
 * Regenerates the tiny media fixtures in ../fixtures with the FFmpeg wasm core
 * itself (no system ffmpeg needed):   node src/engines/ffmpeg/test-support/make-fixtures.mjs
 * Every file is 1 s long and 64x64 / mono 44.1 kHz, so they stay well under 200 KB.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const core_dir = join(here, '../../../../node_modules/@ffmpeg/core/dist/esm/');
const out_dir = join(here, '../fixtures');
mkdirSync(out_dir, { recursive: true });

globalThis.self ??= globalThis;
globalThis.location ??= { href: 'file:///fixtures/' };
const create = (await import(join(core_dir, 'ffmpeg-core.js'))).default;
const core = await create({ wasmBinary: readFileSync(join(core_dir, 'ffmpeg-core.wasm')) });
let log = [];
core.setLogger((m) => log.push(m.message));

const VIDEO = ['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=1'];
const AUDIO = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1'];
const H264 = ['-c:v', 'libx264', '-preset', 'veryslow', '-crf', '28', '-pix_fmt', 'yuv420p'];

// Optional filter: `node make-fixtures.mjs 24bit` regenerates only matching files.
const only = process.argv[2];

function make(name, ...args) {
  if (only && !name.includes(only)) return;
  log = [];
  const ret = core.exec('-hide_banner', '-loglevel', 'error', ...args, name);
  core.reset();
  if (ret !== 0) throw new Error(`${name} failed (${ret}): ${log.slice(-3).join(' | ')}`);
  const bytes = core.FS.readFile(name);
  writeFileSync(join(out_dir, name), bytes);
  core.FS.unlink(name);
  console.log(name.padEnd(22), String(bytes.length).padStart(7), 'bytes');
}

make('sample.mp4', ...VIDEO, ...AUDIO, ...H264, '-c:a', 'aac', '-b:a', '48k', '-shortest');
make('sample.mov', ...VIDEO, ...AUDIO, ...H264, '-c:a', 'aac', '-b:a', '48k', '-shortest');
make('sample.mkv', ...VIDEO, ...AUDIO, ...H264, '-c:a', 'aac', '-b:a', '48k', '-shortest');
make('sample.webm', ...VIDEO, ...AUDIO, '-c:v', 'libvpx', '-crf', '30', '-b:v', '200k', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '32k', '-shortest');
make('sample-silent.mp4', ...VIDEO, ...H264);
// Codecs WebCodecs cannot decode, so the browser engine must hand over to FFmpeg.
make('sample-mpeg4.mp4', ...VIDEO, ...AUDIO, '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-b:a', '48k', '-shortest');
make('sample-prores.mov', ...VIDEO, ...AUDIO, '-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le', '-shortest');
make('sample.mp3', ...AUDIO, '-c:a', 'libmp3lame', '-q:a', '5');
make('sample.wav', ...AUDIO, '-c:a', 'pcm_s16le');
make('sample.flac', ...AUDIO, '-c:a', 'flac');
make('sample.ogg', ...AUDIO, '-c:a', 'libopus', '-b:a', '32k');
make('sample-vorbis.ogg', ...AUDIO, '-c:a', 'libvorbis', '-q:a', '1');
make('sample.m4a', ...AUDIO, '-c:a', 'aac', '-b:a', '48k');
// 24-bit lossless sources: converting them must not drop to 16 bits.
make('sample-24bit.wav', ...AUDIO, '-af', 'volume=0.9', '-c:a', 'pcm_s24le');
make('sample-24bit.flac', ...AUDIO, '-af', 'volume=0.9', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-c:a', 'flac');

// Animated GIF through the same two-pass palette path the engine uses.
if (!only || 'sample.gif'.includes(only)) {
  log = [];
  core.exec('-hide_banner', '-loglevel', 'error', ...VIDEO, '-vf', 'palettegen', '-update', '1', 'pal.png'); core.reset();
  make('sample.gif', ...VIDEO, '-i', 'pal.png', '-lavfi', '[0:v][1:v]paletteuse', '-loop', '0');
}
