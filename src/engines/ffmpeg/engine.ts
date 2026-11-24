/**
 * FFmpeg (WebAssembly) engine, the fallback for audio/video and the only GIF engine.
 *
 * The @ffmpeg/core Emscripten module is loaded directly inside this worker
 * (no nested worker, no CDN): the wasm bytes come from ctx.fetchAsset so the
 * user sees a true download percentage. The input Blob is mounted with
 * WORKERFS, so it is read in place and never copied into the wasm heap.
 *
 * ffmpeg runs synchronously on this thread; the host's progress throttle is
 * leading-edge, so measured output-time / duration still reaches the page
 * while it works.
 */
import createFFmpegCore, { type FFmpegCore } from '@ffmpeg/core';
import wasmUrl from '@ffmpeg/core/wasm?url';
import { formatInfo, type FormatId } from '../../core/formats';
import {
  EngineUnsupportedError,
  type ConvertRequest,
  type ConvertResult,
  type Engine,
  type EngineContext,
} from '../../core/types';
import { PREVIEW_MAX_BYTES, WAVEFORM_MAX_SECONDS, isVideo, shortName, thumbnailTimes } from '../shared/media';
import { thumbnailSize } from '../shared/thumbnail';
import {
  FORMAT_WHITELIST,
  MAX_INPUT_BYTES,
  WORK_DIR,
  buildPlan,
  checkLimits,
  displaySize,
  explainFailure,
  parseProbe,
  progressFraction,
  supportsPair,
  waveformPeaks,
  type Options,
  type ProbeInfo,
} from './plan';

const IN_DIR = '/in';

/** Real output-time / duration progress. The host throttle posts on the leading edge, so this works while ffmpeg blocks the thread. */
function makeProgressSink(ctx: EngineContext): (fraction: number) => void {
  return (f) => ctx.progress(f);
}

function crashMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/memory|enlarge|alloc|out of bounds|unreachable/i.test(text)) {
    return 'FFmpeg ran out of memory in the browser. Try a smaller or shorter file.';
  }
  return `FFmpeg stopped unexpectedly: ${text.slice(0, 160)}`;
}

function safeRm(core: FFmpegCore, path: string) {
  try {
    core.FS.unlink(path);
  } catch {
    /* already gone */
  }
}

async function mountInput(core: FFmpegCore, input: Blob, from: FormatId, ctx: EngineContext): Promise<string> {
  const name = `input.${formatInfo(from).exts[0]}`;
  core.FS.mkdir(IN_DIR);
  const workerfs = core.FS.filesystems.WORKERFS;
  if (workerfs && typeof (globalThis as { FileReaderSync?: unknown }).FileReaderSync !== 'undefined') {
    core.FS.mount(workerfs, { blobs: [{ name, data: input }] }, IN_DIR);
    ctx.log('FFmpeg input mounted with WORKERFS (read in place, not copied)');
  } else {
    // Only reachable outside a worker (unit tests): no FileReaderSync, so copy.
    core.FS.writeFile(`${IN_DIR}/${name}`, new Uint8Array(await input.arrayBuffer()));
    ctx.log('FFmpeg input copied into MEMFS');
  }
  return `${IN_DIR}/${name}`;
}

const engine: Engine = {
  async convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
    const { input, from, to } = req;
    const options = req.options as Options;
    if (!supportsPair(from, to)) throw new EngineUnsupportedError(`FFmpeg does not convert ${shortName(from)} to ${shortName(to)}.`);
    if (input.size === 0) throw new Error('This file is empty.');
    if (input.size > MAX_INPUT_BYTES) {
      throw new Error(
        `This file is ${(input.size / 1024 ** 3).toFixed(1)} GB. FFmpeg in the browser handles files up to 1.5 GB; use a browser with hardware (WebCodecs) support or a smaller file.`,
      );
    }
    const emitProgress = makeProgressSink(ctx);

    ctx.stage('load');
    const wasm = await ctx.fetchAsset(wasmUrl);
    const core = await createFFmpegCore({ wasmBinary: wasm });

    const stderrTail: string[] = [];
    let stdoutLines: string[] | null = null;
    core.setLogger(({ type, message }) => {
      if (type === 'stdout') {
        stdoutLines?.push(message);
        return;
      }
      stderrTail.push(message);
      if (stderrTail.length > 40) stderrTail.shift();
      ctx.log(message);
    });

    let mounted = false;
    const scratch: string[] = [];
    try {
      core.FS.mkdir(WORK_DIR);

      /* ------------------------------------------------------------ read */
      ctx.stage('read');
      const inPath = await mountInput(core, input, from, ctx);
      mounted = true;

      stdoutLines = [];
      try {
        // ffprobe never sets the exit code in this core (it stays -1), so success = parsable JSON.
        core.ffprobe(
          '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
          '-format_whitelist', FORMAT_WHITELIST, '-protocol_whitelist', 'file', inPath,
        );
      } catch (err) {
        throw new Error(crashMessage(err));
      } finally {
        core.reset();
      }
      const probeText = stdoutLines.join('\n');
      stdoutLines = null;
      let probe: ProbeInfo;
      try {
        probe = parseProbe(probeText);
        if (!probe.video && !probe.audio) throw new Error('no streams');
      } catch {
        throw new Error(`This file could not be read as ${shortName(from)}: ${explainFailure(stderrTail, to)}`);
      }
      checkLimits(from, to, probe, options);
      ctx.log(`FFmpeg input: ${probe.formatName}, video ${probe.video?.codec ?? '-'}, audio ${probe.audio?.codec ?? '-'}`);

      const wantsVideo = to === 'gif' || isVideo(to);
      emitFacts(ctx, probe, wantsVideo);

      if (input.size <= PREVIEW_MAX_BYTES) {
        try {
          if (wantsVideo && probe.video && probe.durationS) await previewFrames(core, ctx, inPath, probe, scratch);
          else if (!wantsVideo && probe.audio && probe.durationS && probe.durationS <= WAVEFORM_MAX_SECONDS) previewWaveform(core, ctx, inPath, scratch);
        } catch (err) {
          ctx.log(`Preview skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      /* ------------------------------------------------------- transcode */
      const plan = buildPlan(from, to, inPath, probe, options);
      scratch.push(plan.output, ...plan.scratch);
      ctx.log(`FFmpeg plan: ${plan.summary}`);

      for (const pass of plan.passes) {
        ctx.stage(pass.stage);
        core.setProgress(({ time }) => {
          if (!pass.measured) return;
          const f = progressFraction(time, probe.durationS);
          if (f !== null) emitProgress(f);
        });
        stderrTail.length = 0;
        let ret: number;
        try {
          ret = core.exec(...pass.args);
        } catch (err) {
          throw new Error(crashMessage(err));
        } finally {
          core.reset();
          core.setProgress(() => {});
        }
        if (ret !== 0) throw new Error(explainFailure(stderrTail, to));
        if (pass.measured && probe.durationS) emitProgress(1);
      }

      /* ---------------------------------------------------------- package */
      ctx.stage('package');
      let out: Uint8Array;
      try {
        out = core.FS.readFile(plan.output);
      } catch {
        throw new Error(`FFmpeg did not produce a ${shortName(to)} file.`);
      }
      if (out.byteLength === 0) throw new Error(`FFmpeg produced an empty ${shortName(to)} file.`);
      return { output: out, ext: plan.ext, mime: plan.mime };
    } finally {
      for (const p of scratch) safeRm(core, p);
      if (mounted) {
        try {
          core.FS.unmount(IN_DIR);
        } catch {
          safeRm(core, `${IN_DIR}/${formatInfo(from).exts[0]}`);
        }
      }
    }
  },
};

export default engine;

/* ----------------------------------------------------------------- helpers */

function emitFacts(ctx: EngineContext, probe: ProbeInfo, wantsVideo: boolean) {
  if (probe.durationS === null) return;
  if (wantsVideo && probe.video) {
    const { width, height } = displaySize(probe.video);
    ctx.facts({
      kind: 'video',
      durationS: probe.durationS,
      width,
      height,
      ...(probe.video.fps ? { fps: probe.video.fps } : {}),
      videoCodec: probe.video.codec,
      ...(probe.audio ? { audioCodec: probe.audio.codec } : {}),
    });
  } else if (probe.audio) {
    ctx.facts({
      kind: 'audio',
      durationS: probe.durationS,
      sampleRate: probe.audio.sampleRate,
      channels: probe.audio.channels,
      codec: probe.audio.codec,
    });
  }
}

const QUIET = ['-hide_banner', '-nostats', '-loglevel', 'error', '-format_whitelist', FORMAT_WHITELIST, '-protocol_whitelist', 'file'];

/** Up to 8 thumbnails (<= 96 px) at evenly spaced times, each from its own seek. */
async function previewFrames(core: FFmpegCore, ctx: EngineContext, inPath: string, probe: ProbeInfo, scratch: string[]) {
  const v = probe.video!;
  const size = displaySize(v);
  const { width, height } = thumbnailSize(size.width, size.height);
  const out = `${WORK_DIR}/thumb.rgba`;
  scratch.push(out);
  const frames: Uint8ClampedArray[] = [];
  const times: number[] = [];
  for (const t of thumbnailTimes(probe.durationS!)) {
    safeRm(core, out);
    const ret = core.exec(
      ...QUIET, '-ss', t.toFixed(3), '-i', inPath, '-an', '-sn', '-dn', '-frames:v', '1',
      '-vf', `scale=${width}:${height}:flags=area`, '-pix_fmt', 'rgba', '-f', 'rawvideo', out,
    );
    core.reset();
    if (ret !== 0) continue;
    let bytes: Uint8Array;
    try {
      bytes = core.FS.readFile(out);
    } catch {
      continue;
    }
    if (bytes.byteLength !== width * height * 4) continue;
    frames.push(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    times.push(t);
  }
  if (frames.length) ctx.preview({ kind: 'frames', width, height, frames, times });
}

/** ~256 peak values of the first audio stream, decoded to 8 kHz mono. */
function previewWaveform(core: FFmpegCore, ctx: EngineContext, inPath: string, scratch: string[]) {
  const out = `${WORK_DIR}/wave.raw`;
  scratch.push(out);
  const ret = core.exec(...QUIET, '-i', inPath, '-vn', '-sn', '-dn', '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', out);
  core.reset();
  if (ret !== 0) return;
  const bytes = core.FS.readFile(out);
  const even = bytes.byteLength - (bytes.byteLength % 2);
  if (even === 0) return;
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, even / 2);
  ctx.preview({ kind: 'waveform', peaks: waveformPeaks(pcm) });
}
