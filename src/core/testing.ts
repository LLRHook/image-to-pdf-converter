/**
 * Test helpers for engines running under Vitest in Node.
 * `fetchAsset` resolves Vite `?url` import paths to files on disk.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { EngineContext, Facts, Preview, StageId } from './types';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export interface RecordedContext extends EngineContext {
  stages: StageId[];
  progress: (fraction: number) => void;
  progressValues: number[];
  factsSeen: Facts[];
  previews: Preview[];
  logs: string[];
  assets: string[];
}

export function urlToPath(url: string): string {
  let p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
  if (p.startsWith('/@fs/')) return p.slice('/@fs'.length);
  if (p.startsWith('file://')) return fileURLToPath(p);
  if (p.startsWith(ROOT)) return p;
  return resolve(ROOT, '.' + (p.startsWith('/') ? p : '/' + p));
}

export function testContext(): RecordedContext {
  const ctx: RecordedContext = {
    stages: [],
    progressValues: [],
    factsSeen: [],
    previews: [],
    logs: [],
    assets: [],
    stage(id) {
      ctx.stages.push(id);
    },
    progress(f) {
      ctx.progressValues.push(f);
    },
    facts(f) {
      ctx.factsSeen.push(f);
    },
    preview(p) {
      ctx.previews.push(p);
    },
    log(m) {
      ctx.logs.push(m);
    },
    async fetchAsset(url) {
      ctx.assets.push(url);
      return new Uint8Array(await readFile(urlToPath(url)));
    },
  };
  return ctx;
}

export function blobOf(bytes: Uint8Array | string, type = ''): Blob {
  return new Blob([typeof bytes === 'string' ? bytes : (bytes as Uint8Array<ArrayBuffer>)], { type });
}

export async function bytesOf(output: Blob | Uint8Array): Promise<Uint8Array> {
  return output instanceof Blob ? new Uint8Array(await output.arrayBuffer()) : output;
}
