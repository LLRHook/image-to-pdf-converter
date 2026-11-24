import type { FormatId } from './formats';

/**
 * Engine contract.
 *
 * An engine lives in `src/engines/<id>/` and provides two modules:
 *   - `edges.ts`  exports `edges: EdgeSpec[]`. Pure data, imported on the main
 *                 thread by the planner. Must not import the engine library.
 *   - `engine.ts` exports `default` as an `Engine`. Imported lazily inside a
 *                 fresh Web Worker for one conversion hop, then the worker is
 *                 terminated so no file data survives the job.
 *
 * The engine id is the directory name.
 */

/** The real steps a conversion goes through. Engines report them as they happen. */
export type StageId = 'load' | 'read' | 'decode' | 'transform' | 'encode' | 'package';

export interface StageSpec {
  id: StageId;
  /** Short, specific, user-facing: "Decode HEVC tiles", "Load ImageMagick". */
  label: string;
}

/**
 * How faithful the result is.
 *  lossless  - same content, nothing discarded (PNG -> WebP lossless, CSV -> XLSX)
 *  lossy     - perceptual compression or sample reduction (PNG -> JPEG, WAV -> MP3)
 *  semantic  - structure is kept, layout/styling is re-created (DOCX -> Markdown)
 *  raster    - vector or text content becomes pixels (PDF -> PNG, SVG -> PNG)
 */
export type Fidelity = 'lossless' | 'lossy' | 'semantic' | 'raster';

export interface EdgeSpec {
  /** Filled in by the registry from the directory name. Leave unset in edges.ts. */
  engine?: string;
  from: readonly FormatId[];
  to: readonly FormatId[];
  /** Relative cost; the planner minimises the sum along a route. ~1 cheap, ~10 heavy wasm. */
  cost: number;
  fidelity: Fidelity | ((from: FormatId, to: FormatId) => Fidelity);
  /**
   * The exact stages `convert` will report for this pair, in order. The
   * loading screen lays out the pipeline from this before the job starts, so
   * it must match what the engine really does.
   */
  stages: (from: FormatId, to: FormatId) => StageSpec[];
  /** Optional caveat shown next to the target, e.g. "Layout is re-typeset". */
  note?: (from: FormatId, to: FormatId) => string | undefined;
  /** Return true to exclude a specific pair from the from x to cross product. */
  exclude?: (from: FormatId, to: FormatId) => boolean;
  /**
   * True if the output may be a ZIP of several files (one PNG per PDF page).
   * The planner only places such edges on the last hop of a route.
   */
  mayBundle?: boolean;
}

export interface ConvertRequest {
  /** The input. Read with `await input.arrayBuffer()` or stream/slice for large media. */
  input: Blob;
  name: string;
  from: FormatId;
  to: FormatId;
  options: Readonly<Record<string, unknown>>;
}

export interface ConvertResult {
  output: Blob | Uint8Array;
  /** Extension of the produced file: the target's canonical ext, or 'zip' when bundled. */
  ext: string;
  mime: string;
  /** Present when `output` is a ZIP of several files. */
  bundle?: { count: number; ext: string };
}

/** What the decoded, in-between representation really looked like. Drives the visualiser. */
export type Facts =
  | { kind: 'raster'; width: number; height: number; frames?: number; channels?: number; depth?: number }
  | { kind: 'pages'; pages: number; width?: number; height?: number }
  | { kind: 'document'; blocks: number; headings?: number; images?: number; words?: number; tables?: number }
  | { kind: 'table'; sheets: number; rows: number; cols: number }
  | { kind: 'tree'; nodes: number; depth: number }
  | { kind: 'audio'; durationS: number; sampleRate: number; channels: number; codec?: string }
  | {
      kind: 'video';
      durationS: number;
      width: number;
      height: number;
      fps?: number;
      videoCodec?: string;
      audioCodec?: string;
    }
  | { kind: 'text'; chars: number; lines: number };

/** A small, real sample of the decoded content, so the visualiser shows actual data. */
export type Preview =
  | { kind: 'pixels'; width: number; height: number; rgba: Uint8ClampedArray } // <= 96x96
  | { kind: 'waveform'; peaks: Float32Array } // 0..1, ~256 buckets
  | { kind: 'outline'; items: { level: number; text: string }[] } // first ~40 blocks, text <= 80 chars
  | { kind: 'grid'; rows: string[][] } // first ~12 rows x 8 cols, cells <= 24 chars
  | { kind: 'frames'; width: number; height: number; frames: Uint8ClampedArray[]; times: number[] }; // <= 8 RGBA thumbs

export interface EngineContext {
  /** Enter a stage. Call once per declared stage, in declared order. */
  stage(id: StageId): void;
  /**
   * Measured progress within the current stage, 0..1. Only call with values
   * you actually measured (bytes, frames, pages). Never invent progress: if a
   * stage has no measurable progress, don't call this and the UI shows it as
   * running without a percentage.
   */
  progress(fraction: number): void;
  facts(facts: Facts): void;
  preview(preview: Preview): void;
  log(message: string): void;
  /**
   * Fetch a same-origin engine asset (wasm, data, fonts) with byte-accurate
   * download progress shown to the user. Use Vite `?url` imports for paths.
   */
  fetchAsset(url: string): Promise<Uint8Array>;
}

/** Cancelling terminates the worker, so engines need no abort handling. */
export interface Engine {
  convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult>;
}

/**
 * Throw this when the engine cannot handle this specific input in this
 * browser (e.g. WebCodecs has no Opus encoder). The runner then retries the
 * hop with the next engine that declares the same from->to edge, and the
 * loading screen shows the switch. Any other error fails the job.
 */
export class EngineUnsupportedError extends Error {
  override name = 'EngineUnsupportedError';
}

/* ---------------------------------------------------------------- protocol */

export interface HopJob {
  engine: string;
  input: Blob;
  name: string;
  from: FormatId;
  to: FormatId;
  options: Record<string, unknown>;
}

export type ToWorker = { type: 'run'; job: HopJob };

export type FromWorker =
  | { type: 'stage'; stage: StageId; at: number }
  | { type: 'progress'; value: number; at: number }
  | { type: 'asset'; url: string; loaded: number; total: number | null; at: number }
  | { type: 'facts'; facts: Facts }
  | { type: 'preview'; preview: Preview }
  | { type: 'log'; message: string }
  | { type: 'done'; result: ConvertResult & { output: Blob }; at: number }
  | { type: 'error'; message: string; code?: 'unsupported'; at: number };
