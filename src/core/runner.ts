/**
 * Runs a Route on the main thread's behalf: one fresh Worker per hop, which
 * is terminated as soon as the hop finishes. Emits a single event stream the
 * loading screen renders from; every event is something that really happened.
 */
import { now } from './clock';
import { formatInfo, outputName, type FormatId } from './formats';
import type { Hop, Route } from './graph';
import { alternativesFor } from './registry';
import type { ConvertResult, Facts, FromWorker, Preview, StageId, ToWorker } from './types';

export type RunEvent =
  | { type: 'hop-start'; hop: number; engine: string; from: FormatId; to: FormatId; at: number }
  | { type: 'stage'; hop: number; stage: StageId; at: number }
  | { type: 'progress'; hop: number; value: number; at: number }
  | { type: 'asset'; hop: number; url: string; loaded: number; total: number | null; at: number }
  | { type: 'facts'; hop: number; facts: Facts }
  | { type: 'preview'; hop: number; preview: Preview }
  | { type: 'log'; hop: number; message: string }
  | { type: 'fallback'; hop: number; fromEngine: string; toEngine: string; reason: string; at: number }
  | { type: 'hop-done'; hop: number; size: number; at: number }
  | { type: 'done'; result: RunResult; at: number }
  | { type: 'error'; hop: number; message: string; at: number }
  | { type: 'cancelled'; at: number };

export interface RunResult {
  blob: Blob;
  name: string;
  /** The format actually produced: the route's target, or 'zip' when bundled. */
  format: FormatId;
  mime: string;
  ext: string;
  bundle?: { count: number; ext: string };
}

export interface RunHandle {
  done: Promise<RunResult>;
  cancel(): void;
}

export function runRoute(
  route: Route,
  input: Blob,
  name: string,
  onEvent: (e: RunEvent) => void,
  options: {
    options?: Record<string, unknown>;
    /** Retry an unsupported hop with the next engine for the same pair (default true). */
    fallback?: boolean;
  } = {},
): RunHandle {
  let current: Worker | null = null;
  let cancelled = false;
  let rejectRun: ((e: Error) => void) | null = null;

  const runHop = (index: number, hop: Hop, blob: Blob): Promise<ConvertResult & { output: Blob }> =>
    new Promise((resolve, reject) => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `engine:${hop.engine}` });
      current = w;
      onEvent({ type: 'hop-start', hop: index, engine: hop.engine, from: hop.from, to: hop.to, at: now() });
      const finish = () => {
        w.terminate();
        if (current === w) current = null;
      };
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'done') {
          finish();
          resolve(m.result);
        } else if (m.type === 'error') {
          finish();
          const err = new Error(m.message) as Error & { unsupported?: boolean };
          err.unsupported = m.code === 'unsupported';
          reject(err);
        } else onEvent({ ...m, hop: index });
      };
      w.onerror = (e) => {
        finish();
        reject(new Error(e.message || 'Worker crashed'));
      };
      const msg: ToWorker = {
        type: 'run',
        job: { engine: hop.engine, input: blob, name, from: hop.from, to: hop.to, options: options.options ?? {} },
      };
      w.postMessage(msg);
    });

  const done = (async (): Promise<RunResult> => {
    let blob = input;
    let last: (ConvertResult & { output: Blob }) | null = null;
    for (let i = 0; i < route.hops.length; i++) {
      const planned = route.hops[i]!;
      const candidates = [planned, ...(options.fallback === false ? [] : alternativesFor(planned))];
      for (let c = 0; c < candidates.length; c++) {
        const hop = candidates[c]!;
        try {
          last = await Promise.race([
            runHop(i, hop, blob),
            new Promise<never>((_, rej) => {
              rejectRun = rej;
            }),
          ]);
          break;
        } catch (err) {
          if (cancelled) throw err;
          const e = err as Error & { unsupported?: boolean };
          const next = candidates[c + 1];
          if (e.unsupported && next) {
            onEvent({ type: 'fallback', hop: i, fromEngine: hop.engine, toEngine: next.engine, reason: e.message, at: now() });
            continue;
          }
          onEvent({ type: 'error', hop: i, message: e.message, at: now() });
          throw e;
        }
      }
      blob = last!.output;
      onEvent({ type: 'hop-done', hop: i, size: blob.size, at: now() });
    }
    const ext = last?.ext ?? formatInfo(route.to).exts[0]!;
    const mime = last?.mime ?? formatInfo(route.to).mime;
    const result: RunResult = {
      blob: new Blob([blob], { type: mime }),
      name: outputName(name, ext),
      format: last?.bundle ? 'zip' : route.to,
      mime,
      ext,
      bundle: last?.bundle,
    };
    onEvent({ type: 'done', result, at: now() });
    return result;
  })();

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      current?.terminate();
      current = null;
      onEvent({ type: 'cancelled', at: now() });
      rejectRun?.(new Error('Cancelled'));
    },
  };
}
