/// <reference lib="webworker" />
/**
 * Engine host. One worker runs exactly one hop and is then terminated by the
 * runner, so decoded file data never outlives its job.
 */
import { EngineUnsupportedError, type Engine, type EngineContext, type FromWorker, type StageId, type ToWorker } from './types';
import { fetchAsset } from './assets';
import { now } from './clock';

declare const self: DedicatedWorkerGlobalScope;

const engines = import.meta.glob<{ default: Engine }>('../engines/*/engine.ts');

/**
 * Network jail. A worker script served without its own CSP header is not
 * covered by the page's CSP, so before any engine code loads we wrap every
 * network API a worker has and refuse anything that is not same-origin (or a
 * local blob:/data: URL). Engines only ever need their own wasm and fonts.
 */
function lockdownNetwork() {
  const isLocal = (input: string | URL) => {
    const u = new URL(String(input), self.location.href);
    return u.origin === self.location.origin || u.protocol === 'blob:' || u.protocol === 'data:';
  };
  const block = (what: string, url: string | URL) => {
    throw new Error(`Blocked network access (${what}): ${new URL(String(url), self.location.href).origin}`);
  };
  const realFetch = self.fetch.bind(self);
  self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input;
    if (!isLocal(url)) return Promise.reject(new Error(`Blocked network access (fetch): ${String(url)}`));
    return realFetch(input, { ...init, credentials: 'omit' });
  };
  const RealXHR = (self as unknown as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (RealXHR) {
    const open = RealXHR.prototype.open;
    RealXHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      if (!isLocal(url)) block('xhr', url);
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof open;
  }
  for (const name of ['WebSocket', 'EventSource', 'WebTransport'] as const) {
    if (name in self) Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
  }
  const realImportScripts = self.importScripts?.bind(self);
  if (realImportScripts) {
    self.importScripts = (...urls: (string | URL)[]) => {
      for (const u of urls) if (!isLocal(u)) block('importScripts', u);
      realImportScripts(...urls.map(String));
    };
  }
}
lockdownNetwork();

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
function makeContext(): EngineContext {
  // Leading-edge throttle (<= ~30 messages/s). A pure timer throttle never
  // fires while synchronous wasm (FFmpeg, pandoc) blocks this thread, so a
  // value is posted immediately whenever 33 ms have passed since the last
  // post; the trailing timer only catches the final value of a burst.
  const INTERVAL = 33;
  let lastProgress = 0;
  let lastPostAt = 0;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending !== null) {
      lastPostAt = performance.now();
      post({ type: 'progress', value: pending, at: now() });
    }
    pending = null;
  };
  return {
    stage(id: StageId) {
      flush();
      lastProgress = 0;
      post({ type: 'stage', stage: id, at: now() });
    },
    progress(fraction: number) {
      if (!Number.isFinite(fraction)) return;
      // Monotone within a stage: decoders sometimes report a re-scan.
      const v = Math.min(1, Math.max(lastProgress, fraction));
      if (v === lastProgress && pending === null && v !== 0) return;
      lastProgress = v;
      pending = v;
      if (v >= 1 || performance.now() - lastPostAt >= INTERVAL) flush();
      else timer ??= setTimeout(flush, INTERVAL);
    },
    facts: (facts) => post({ type: 'facts', facts }),
    preview: (preview) => post({ type: 'preview', preview }),
    log: (message) => post({ type: 'log', message }),
    fetchAsset: (url) =>
      fetchAsset(url, (loaded, total) => post({ type: 'asset', url, loaded, total, at: now() })),
  };
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  if (e.data?.type !== 'run') return;
  const { job } = e.data;
  try {
    const load = engines[`../engines/${job.engine}/engine.ts`];
    if (!load) throw new Error(`No engine "${job.engine}"`);
    const engine = (await load()).default;
    const result = await engine.convert(
      { input: job.input, name: job.name, from: job.from, to: job.to, options: job.options },
      makeContext(),
    );
    // Copy into a Blob: engine output can be a view into wasm memory, which
    // cannot be transferred, and a Blob is cheap to hand back to the page.
    const output = result.output instanceof Blob ? result.output : new Blob([result.output as Uint8Array<ArrayBuffer>]);
    post({ type: 'done', result: { ...result, output }, at: now() });
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof EngineUnsupportedError || (err as Error)?.name === 'EngineUnsupportedError' ? 'unsupported' : undefined,
      at: now(),
    });
  }
};
