/**
 * mediabunny engine: audio/video through the browser's own WebCodecs.
 *
 * Tracks the target container can hold are copied without re-encoding; the
 * rest is decoded and re-encoded with WebCodecs, plus small wasm encoders for
 * MP3 / AAC / FLAC where the browser has none. Whenever this browser cannot
 * decode the source or encode the target, the engine throws
 * EngineUnsupportedError before doing any work so the runner continues with
 * FFmpeg.
 *
 * Input is read in place through BlobSource (never copied whole into memory);
 * the output is collected in memory.
 */
import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  FlacOutputFormat,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  QUALITY_HIGH,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';
import { EngineUnsupportedError, type ConvertRequest, type ConvertResult, type Engine, type EngineContext } from '../../core/types';
import type { FormatId } from '../../core/formats';
import { PREVIEW_MAX_BYTES, WAVEFORM_MAX_SECONDS, shortName, thumbnailTimes } from '../shared/media';
import { thumbnailSize } from '../shared/thumbnail';
import {
  PREVIEW_BUDGET_MS,
  PeakAccumulator,
  TARGETS,
  channelCandidates,
  supportsPair,
  flacSampleFormat,
  sourceBitDepth,
  wantsCopy,
  wavCodecFor,
  type TargetPolicy,
} from './plan';

const unsupported = (why: string) => new EngineUnsupportedError(why);

function outputFormat(to: FormatId): OutputFormat {
  switch (to) {
    case 'mp4':
    case 'm4a':
      return new Mp4OutputFormat({ fastStart: 'in-memory' });
    case 'mov':
      return new MovOutputFormat({ fastStart: 'in-memory' });
    case 'mkv':
      return new MkvOutputFormat();
    case 'webm':
      return new WebMOutputFormat();
    case 'ogg':
      return new OggOutputFormat();
    case 'mp3':
      return new Mp3OutputFormat();
    case 'wav':
      return new WavOutputFormat();
    case 'flac':
      return new FlacOutputFormat();
    default:
      throw unsupported(`mediabunny cannot write ${to}`);
  }
}

/* ------------------------------------------------- wasm encoders, on demand */

const registered = new Set<string>();

/** Registers a wasm encoder for codecs browsers usually lack. Returns false when none exists. */
async function registerFallbackEncoder(codec: string): Promise<boolean> {
  if (registered.has(codec)) return true;
  switch (codec) {
    case 'mp3':
      (await import('@mediabunny/mp3-encoder')).registerMp3Encoder();
      break;
    case 'aac':
      (await import('@mediabunny/aac-encoder')).registerAacEncoder();
      break;
    case 'flac':
      (await import('@mediabunny/flac-encoder')).registerFlacEncoder();
      break;
    default:
      return false;
  }
  registered.add(codec);
  return true;
}

/* -------------------------------------------------------------- decisions */

interface VideoDecision {
  mode: 'copy' | 'encode';
  codec: VideoCodec;
}
interface AudioDecision {
  mode: 'copy' | 'encode';
  codec: AudioCodec;
  channels?: number;
  sampleRate?: number;
  /** Sample format for encoders that follow it (FLAC), so 24-bit sources stay 24-bit. */
  sampleFormat?: 's16' | 's32';
}

async function decideVideo(track: InputVideoTrack, policy: TargetPolicy, to: FormatId): Promise<VideoDecision> {
  const src = await track.getCodec();
  if (src && wantsCopy(src, policy.copyVideo)) return { mode: 'copy', codec: src };
  if (!src) throw unsupported('This browser does not recognise the video codec.');
  if (!(await track.canDecode())) throw unsupported(`This browser cannot decode ${src} video.`);
  const width = await track.getDisplayWidth();
  const height = await track.getDisplayHeight();
  for (const codec of policy.encodeVideo as readonly VideoCodec[]) {
    if (await canEncodeVideo(codec, { width, height, quality: QUALITY_HIGH })) return { mode: 'encode', codec };
  }
  throw unsupported(`This browser cannot encode ${policy.encodeVideo.join('/')} video for ${shortName(to)}.`);
}

async function decideAudio(track: InputAudioTrack, policy: TargetPolicy, to: FormatId): Promise<AudioDecision> {
  const src = await track.getCodec();
  if (src && wantsCopy(src, policy.copyAudio)) return { mode: 'copy', codec: src };
  if (!src) throw unsupported('This browser does not recognise the audio codec.');
  if (!(await track.canDecode())) throw unsupported(`This browser cannot decode ${src} audio.`);
  const channels = await track.getNumberOfChannels();
  const rate = await track.getSampleRate();
  // Lossless targets keep the source's bit depth; lossy sources have none to keep.
  const depth = sourceBitDepth(src, (await track.getDecoderConfig())?.description);
  const encoders = to === 'wav' ? [wavCodecFor(depth) as AudioCodec] : (policy.encodeAudio as readonly AudioCodec[]);
  for (const codec of encoders) {
    for (const numberOfChannels of channelCandidates(channels)) {
      for (const sampleRate of [...new Set([rate, 48000, 44100])]) {
        const opts = { numberOfChannels, sampleRate, quality: QUALITY_HIGH };
        let ok = await canEncodeAudio(codec, opts);
        if (!ok && (await registerFallbackEncoder(codec))) ok = await canEncodeAudio(codec, opts);
        if (ok) {
          return {
            mode: 'encode',
            codec,
            ...(numberOfChannels !== channels ? { channels: numberOfChannels } : {}),
            ...(sampleRate !== rate ? { sampleRate } : {}),
            ...(codec === 'flac' ? { sampleFormat: flacSampleFormat(depth) } : {}),
          };
        }
      }
    }
  }
  throw unsupported(`This browser cannot encode ${policy.encodeAudio.join('/')} audio for ${shortName(to)}.`);
}

/* ---------------------------------------------------------------- engine */

const engine: Engine = {
  async convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
    const { input: blob, from, to } = req;
    if (!supportsPair(from, to)) throw unsupported(`mediabunny does not convert ${shortName(from)} to ${shortName(to)}.`);
    if (blob.size === 0) throw new Error('This file is empty.');
    const policy = TARGETS[to]!;

    ctx.stage('read');
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    let conversion: Conversion | null = null;
    try {
      if (!(await input.canRead())) throw unsupported(`mediabunny could not find a ${shortName(from)} structure in this file.`);
      const vt = await input.getPrimaryVideoTrack();
      const at = await input.getPrimaryAudioTrack();
      if (policy.hasVideo && !vt) throw new Error(`This ${shortName(from)} file has no video stream to convert to ${shortName(to)}.`);
      if (!policy.hasVideo && !at) throw new Error(`This ${shortName(from)} file has no audio track, so there is nothing to extract as ${shortName(to)}.`);

      const durationS = await safeDuration(input);
      const firstTs = await input.getFirstTimestamp().catch(() => 0);
      await emitFacts(ctx, policy.hasVideo ? vt : null, at, durationS);
      if (blob.size <= PREVIEW_MAX_BYTES && durationS > 0) await emitPreview(ctx, blob, policy.hasVideo && !!vt, durationS, firstTs);

      const vdec = policy.hasVideo && vt ? await decideVideo(vt, policy, to) : null;
      const adec = at ? await decideAudio(at, policy, to) : null;
      ctx.log(
        `mediabunny: ${vdec ? `video ${vdec.mode} ${vdec.codec}` : 'no video'}; ${adec ? `audio ${adec.mode} ${adec.codec}${adec.channels ? ` ${adec.channels}ch` : ''}${adec.sampleRate ? ` ${adec.sampleRate}Hz` : ''}` : 'no audio'}`,
      );

      ctx.stage('transform');
      const build = async () => {
        const target = new BufferTarget();
        const output = new Output({ format: outputFormat(to), target });
        const c = await Conversion.init({
          input,
          output,
          tracks: 'primary',
          showWarnings: false,
          // MP4/MOV tracks often start slightly before zero (AAC priming, B-frame offsets) and MKV/WebM
          // cannot hold that. Shifting every track by the same amount keeps audio and video in sync and
          // lets the packets be copied instead of re-encoded.
          copy: { shiftTolerance: Infinity },
          video: vdec ? { codec: vdec.codec, ...(vdec.mode === 'encode' ? { quality: QUALITY_HIGH } : {}) } : { discard: true },
          audio: adec
            ? {
                codec: adec.codec,
                ...(adec.mode === 'encode' ? { quality: QUALITY_HIGH } : {}),
                ...(adec.channels ? { numberOfChannels: adec.channels } : {}),
                ...(adec.sampleRate ? { sampleRate: adec.sampleRate } : {}),
                ...(adec.sampleFormat ? { sampleFormat: adec.sampleFormat } : {}),
              }
            : { discard: true },
        });
        return { target, c };
      };
      const complete = (c: Conversion) => {
        const used = new Set(c.utilizedTracks);
        return c.isValid && !(vdec && vt && !used.has(vt)) && !(adec && at && !used.has(at));
      };
      let built = await build();
      conversion = built.c;
      if (!complete(conversion)) {
        // A track planned as a copy can still need a re-encode (timestamps, container rules). If the only
        // blocker is a missing encoder we know how to load, load it once and plan again.
        const missing = conversion.discardedTracks.filter((d) => d.reason === 'no_encodable_target_codec');
        let loaded = false;
        if (missing.some((d) => d.track.isAudioTrack()) && adec) loaded = (await registerFallbackEncoder(adec.codec)) || loaded;
        if (loaded) {
          await conversion.cancel().catch(() => {});
          built = await build();
          conversion = built.c;
        }
      }
      if (!complete(conversion)) {
        const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ') || 'no usable tracks';
        throw unsupported(`WebCodecs cannot build this ${shortName(to)} (${why}).`);
      }
      const target = built.target;

      let packaging = false;
      conversion.onProgress = (p) => {
        if (packaging) return;
        ctx.progress(p);
        if (p >= 1) {
          packaging = true;
          ctx.stage('package');
        }
      };
      try {
        await conversion.execute();
      } catch (err) {
        if (err instanceof RangeError) throw new Error('Not enough memory to convert this file in the browser. Try a smaller file.');
        if (err instanceof EngineUnsupportedError) throw err;
        throw unsupported(`WebCodecs conversion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!packaging) ctx.stage('package');
      const buffer = target.buffer;
      if (!buffer || buffer.byteLength === 0) throw unsupported('WebCodecs produced an empty file.');
      return { output: new Blob([buffer], { type: policy.mime }), ext: policy.ext, mime: policy.mime };
    } catch (err) {
      await conversion?.cancel().catch(() => {});
      throw err;
    } finally {
      input.dispose();
    }
  },
};

export default engine;

/* ---------------------------------------------------------------- helpers */

async function safeDuration(input: Input): Promise<number> {
  try {
    const d = await input.computeDuration();
    if (Number.isFinite(d) && d > 0) return d;
  } catch {
    /* fall through */
  }
  return (await input.getDurationFromMetadata().catch(() => null)) ?? 0;
}

async function emitFacts(ctx: EngineContext, vt: InputVideoTrack | null, at: InputAudioTrack | null, durationS: number) {
  if (!(durationS > 0)) return;
  if (vt) {
    let fps: number | undefined;
    try {
      const m = await vt.computeFrameRateMetrics();
      if (m.bestGuessFrameRate > 0) fps = Math.round(m.bestGuessFrameRate * 100) / 100;
    } catch {
      /* fps stays unknown */
    }
    const videoCodec = await vt.getCodec();
    const audioCodec = at ? await at.getCodec() : null;
    ctx.facts({
      kind: 'video',
      durationS,
      width: await vt.getDisplayWidth(),
      height: await vt.getDisplayHeight(),
      ...(fps ? { fps } : {}),
      ...(videoCodec ? { videoCodec } : {}),
      ...(audioCodec ? { audioCodec } : {}),
    });
  } else if (at) {
    const codec = await at.getCodec();
    ctx.facts({
      kind: 'audio',
      durationS,
      sampleRate: await at.getSampleRate(),
      channels: await at.getNumberOfChannels(),
      ...(codec ? { codec } : {}),
    });
  }
}

/**
 * Real thumbnails (video targets) or waveform peaks (audio targets), from a
 * second Input over the same Blob so a slow preview can be dropped without
 * disturbing the conversion. Failures and timeouts only skip the preview.
 */
async function emitPreview(ctx: EngineContext, blob: Blob, video: boolean, durationS: number, firstTs: number) {
  const pin = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const timer = setTimeout(() => pin.dispose(), PREVIEW_BUDGET_MS);
  try {
    if (video) {
      const vt = await pin.getPrimaryVideoTrack();
      if (!vt || !(await vt.canDecode())) return;
      const want = thumbnailSize(await vt.getDisplayWidth(), await vt.getDisplayHeight());
      const sink = new CanvasSink(vt, { width: want.width, height: want.height, fit: 'fill' });
      const frames: Uint8ClampedArray[] = [];
      const times: number[] = [];
      let width = 0;
      let height = 0;
      for await (const wrapped of sink.canvasesAtTimestamps(thumbnailTimes(durationS, 8, firstTs))) {
        if (!wrapped) continue;
        const c = wrapped.canvas;
        const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
        if (!g) continue;
        if (!width) {
          width = c.width;
          height = c.height;
        }
        if (c.width !== width || c.height !== height) continue;
        frames.push(new Uint8ClampedArray(g.getImageData(0, 0, width, height).data));
        times.push(wrapped.timestamp - firstTs);
      }
      if (frames.length) ctx.preview({ kind: 'frames', width, height, frames, times });
    } else if (durationS <= WAVEFORM_MAX_SECONDS) {
      const at = await pin.getPrimaryAudioTrack();
      if (!at || !(await at.canDecode())) return;
      const acc = new PeakAccumulator(durationS, firstTs);
      for await (const sample of new AudioSampleSink(at).samples()) {
        try {
          const plane = new Float32Array(sample.numberOfFrames);
          sample.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
          acc.add(sample.timestamp, sample.sampleRate, plane);
        } finally {
          sample.close();
        }
      }
      ctx.preview({ kind: 'waveform', peaks: acc.result() });
    }
  } catch (err) {
    ctx.log(`Preview skipped: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    pin.dispose();
  }
}
