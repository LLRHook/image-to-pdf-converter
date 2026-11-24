/// <reference lib="webworker" />
/** Sniffs and parses a file's structure off the main thread so the animation never stutters. */
import { sniffFormat } from '../core/sniff';
import { parseStructure } from '../core/structure';
import { blobSource } from '../core/structure/types';
import type { FormatId } from '../core/formats';

declare const self: DedicatedWorkerGlobalScope;

export type InspectRequest = { blob: Blob; name: string; format?: FormatId };
export type InspectResponse =
  | { ok: true; format: FormatId | undefined; structure: Awaited<ReturnType<typeof parseStructure>> | null }
  | { ok: false; error: string };

self.onmessage = async (e: MessageEvent<InspectRequest>) => {
  try {
    const src = blobSource(e.data.blob);
    const format = e.data.format ?? (await sniffFormat(src, e.data.name));
    const structure = format ? await parseStructure(src, format) : null;
    self.postMessage({ ok: true, format, structure } satisfies InspectResponse);
  } catch (err) {
    self.postMessage({ ok: false, error: (err as Error).message } satisfies InspectResponse);
  }
};
