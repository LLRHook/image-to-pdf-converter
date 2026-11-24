import type { FormatId } from '../core/formats';
import type { InspectRequest, InspectResponse } from './inspect.worker';

/** One short-lived worker per inspection; terminated as soon as it answers. */
export function inspect(blob: Blob, name: string, format?: FormatId): Promise<Extract<InspectResponse, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./inspect.worker.ts', import.meta.url), { type: 'module', name: 'inspect' });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('Inspecting the file took too long'));
    }, 15_000);
    w.onmessage = (e: MessageEvent<InspectResponse>) => {
      clearTimeout(timer);
      w.terminate();
      if (e.data.ok) resolve(e.data);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      w.terminate();
      reject(new Error(e.message || 'Inspector crashed'));
    };
    w.postMessage({ blob, name, format } satisfies InspectRequest);
  });
}
