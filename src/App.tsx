import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FAMILIES, formatFromExtension, formatInfo, type Family, type FormatId } from './core/formats';
import { ALL_HOPS, readableFormats, routesFrom } from './core/registry';
import type { Hop, Route } from './core/graph';
import { runRoute, type RunHandle, type RunResult } from './core/runner';
import { engineName } from './core/engineNames';
import { initialState, reduce, withOutputStructure, type VizState } from './viz/model';
import { XRay } from './viz/XRay';
import { inspect } from './viz/inspect';
import { fmtBytes, fmtMs } from './viz/scene';
import type { FileStructure } from './core/structure/types';

const FAMILY_LABEL: Record<Family, string> = {
  image: 'Images',
  document: 'Documents',
  data: 'Data',
  audio: 'Audio',
  video: 'Video',
  archive: 'Archives',
};

const FIDELITY_LABEL = { lossless: 'lossless', lossy: 'lossy', semantic: 're-laid out', raster: 'rasterised' } as const;

const now = () => performance.now() + performance.timeOrigin;

const alternatives = (h: Hop) =>
  ALL_HOPS.filter((x) => x.from === h.from && x.to === h.to && x.engine !== h.engine).sort((a, b) => a.cost - b.cost);
const lookupHop = (engine: string, from: FormatId, to: FormatId) =>
  ALL_HOPS.find((x) => x.engine === engine && x.from === from && x.to === to);

interface Picked {
  file: File;
  format: FormatId | undefined;
  structure: FileStructure | null;
  inspecting: boolean;
}

export default function App() {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [target, setTarget] = useState<FormatId | null>(null);
  const [viz, setViz] = useState<VizState | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const run = useRef<RunHandle | null>(null);
  const downloadUrl = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const routes = useMemo(() => (picked?.format ? routesFrom(picked.format) : new Map<FormatId, Route>()), [picked?.format]);
  const readable = useMemo(() => readableFormats(), []);

  const releaseDownload = () => {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
  };

  const clear = useCallback(() => {
    run.current?.cancel();
    run.current = null;
    releaseDownload();
    setResult(null);
    setViz(null);
    setTarget(null);
    setPicked(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const choose = useCallback(async (file: File) => {
    run.current?.cancel();
    releaseDownload();
    setResult(null);
    setTarget(null);
    const guess = formatFromExtension(file.name);
    setPicked({ file, format: guess, structure: null, inspecting: true });
    try {
      const r = await inspect(file, file.name);
      setPicked((p) => (p?.file === file ? { file, format: r.format ?? guess, structure: r.structure, inspecting: false } : p));
    } catch {
      setPicked((p) => (p?.file === file ? { ...p, inspecting: false } : p));
    }
  }, []);

  // Idle visual: the inspected input with no route yet.
  useEffect(() => {
    if (!picked?.format || run.current) return;
    if (viz && viz.route.hops.length) return;
    const idle: Route = { from: picked.format, to: picked.format, hops: [], cost: 0, fidelity: 'lossless', notes: [] };
    setViz(
      initialState(
        { name: picked.file.name, format: picked.format, size: picked.file.size, structure: picked.structure },
        idle,
        now(),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  const start = useCallback(() => {
    if (!picked?.format || !target) return;
    const route = routes.get(target);
    if (!route) return;
    releaseDownload();
    setResult(null);
    let state = initialState(
      { name: picked.file.name, format: picked.format, size: picked.file.size, structure: picked.structure },
      route,
      now(),
    );
    setViz(state);
    const handle = runRoute(
      route,
      picked.file,
      picked.file.name,
      (ev) => {
        state = reduce(state, ev, lookupHop);
        setViz(state);
        if (ev.type === 'done') {
          const res = ev.result;
          setResult(res);
          run.current = null;
          // Parse the real output so the expected layout resolves into the true one.
          inspect(res.blob, res.name, res.bundle ? 'zip' : route.to)
            .then((r) => {
              if (r.structure) {
                state = withOutputStructure(state, r.structure);
                setViz(state);
              }
            })
            .catch(() => {});
        }
        if (ev.type === 'error' || ev.type === 'cancelled') run.current = null;
      },
      { alternatives },
    );
    run.current = handle;
    handle.done.catch(() => {});
  }, [picked, target, routes]);

  const download = () => {
    if (!result) return;
    releaseDownload();
    // A generic type makes every browser save the file instead of opening
    // displayable types (Firefox would open an image/webp blob in place).
    const url = URL.createObjectURL(new Blob([result.blob], { type: 'application/octet-stream' }));
    downloadUrl.current = url;
    const a = document.createElement('a');
    a.href = url;
    a.download = result.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Drag & drop anywhere, paste from clipboard.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) void choose(f);
    };
    const paste = (e: ClipboardEvent) => {
      const f = e.clipboardData?.files?.[0];
      if (f) void choose(f);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, [choose]);

  useEffect(() => () => releaseDownload(), []);

  const running = viz?.phase === 'running' && !!viz.route.hops.length;
  const grouped = useMemo(() => {
    const m = new Map<Family, Route[]>();
    for (const r of routes.values()) {
      const fam = formatInfo(r.to).family;
      if (fam === 'archive') continue;
      m.set(fam, [...(m.get(fam) ?? []), r]);
    }
    for (const list of m.values()) list.sort((a, b) => a.cost - b.cost);
    return FAMILIES.filter((f) => m.has(f)).map((f) => [f, m.get(f)!] as const);
  }, [routes]);

  const chosen = target ? routes.get(target) : undefined;
  const liveText = viz ? describeLive(viz) : '';

  return (
    <div className={`app${dragging ? ' dragging' : ''}`}>
      <div className="backdrop" aria-hidden="true">
        <i className="b1" />
        <i className="b2" />
        <i className="b3" />
        <i className="b4" />
        <i className="grain" />
      </div>
      <header className="top">
        <div className="mark">
          any<span>to</span>any
        </div>
        <div className="top-note glass">
          <span className="dot" /> runs on this device · nothing is uploaded
        </div>
      </header>

      {!picked && (
        <section className="hero">
          <h1>
            Drop a file.
            <br />
            <em>Watch it become another.</em>
          </h1>
          <p className="lede">
            Images, documents, spreadsheets, audio and video, converted inside your browser. You can watch the
            file come apart into its real pieces and get put back together as the format you picked.
          </p>
          <button className="drop glass" onClick={() => inputRef.current?.click()}>
            <span className="drop-title">Choose a file</span>
            <span className="drop-sub">or drop it anywhere · or paste</span>
          </button>
          <Formats readable={readable} />
          <Privacy />
        </section>
      )}

      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void choose(f);
        }}
      />

      {picked && (
        <section className="bench">
          <XRay state={viz} label={liveText || `Structure of ${picked.file.name}`} />
          <p className="sr-only" aria-live="polite">
            {liveText}
          </p>

          {!picked.format && !picked.inspecting && (
            <div className="notice">
              This file type isn&rsquo;t recognised. Try a file with a common extension, or rename it if the
              extension is wrong.
            </div>
          )}

          {picked.format && !running && !result && (
            <div className="picker glass">
              <div className="picker-head">
                <span>
                  Convert <b className="flow-text">{formatInfo(picked.format).label}</b> to
                </span>
                <button className="ghost" onClick={clear}>
                  Different file
                </button>
              </div>
              {grouped.length === 0 && !picked.inspecting && (
                <div className="notice">Nothing can convert {formatInfo(picked.format).label} files yet.</div>
              )}
              {grouped.map(([fam, list]) => (
                <div className="fam" key={fam}>
                  <div className="fam-label">{FAMILY_LABEL[fam]}</div>
                  <div className="chips">
                    {list.map((r) => (
                      <button
                        key={r.to}
                        className={`chip${target === r.to ? ' on' : ''}`}
                        onClick={() => setTarget(r.to)}
                        title={r.hops.map((h) => engineName(h.engine)).join(' → ')}
                      >
                        {formatInfo(r.to).label}
                        {r.fidelity !== 'lossless' && <small>{FIDELITY_LABEL[r.fidelity]}</small>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {chosen && (
                <div className="go">
                  <div className="route">
                    {chosen.hops.map((h, i) => (
                      <span key={i}>
                        {i > 0 && <i>→</i>}
                        {engineName(h.engine)} <small>{formatInfo(h.from).label}→{formatInfo(h.to).label}</small>
                      </span>
                    ))}
                    {chosen.notes.map((n) => (
                      <div className="route-note" key={n}>
                        {n}
                      </div>
                    ))}
                  </div>
                  <button className="primary" onClick={start}>
                    Convert to {formatInfo(chosen.to).label}
                  </button>
                </div>
              )}
            </div>
          )}

          {running && (
            <div className="controls glass">
              <Stages viz={viz!} />
              <button className="ghost" onClick={() => run.current?.cancel()}>
                Cancel
              </button>
            </div>
          )}

          {viz && !running && viz.route.hops.length > 0 && (
            <div className="controls glass">
              <Stages viz={viz} />
              <div className="actions">
                {result && (
                  <button className="primary" onClick={download}>
                    Download {result.name}
                    {result.bundle ? ` (${result.bundle.count} files)` : ''} · {fmtBytes(result.blob.size)}
                  </button>
                )}
                <button
                  className="ghost"
                  onClick={() => {
                    releaseDownload();
                    setResult(null);
                    setTarget(null);
                    setViz(null);
                    setPicked((p) => (p ? { ...p } : p));
                  }}
                >
                  Another format
                </button>
                <button className="ghost" onClick={clear}>
                  New file
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <footer className="foot">
        <span>
          Free software (GPL-3.0). Engines: ImageMagick, MuPDF, resvg, pandoc, Typst, SheetJS, Mediabunny, FFmpeg.
        </span>
        <a href="https://github.com/LLRHook/image-to-pdf-converter" rel="noreferrer noopener">
          Source
        </a>
      </footer>
    </div>
  );
}

function describeLive(v: VizState): string {
  if (!v.route.hops.length) return '';
  if (v.phase === 'done') return `Done in ${fmtMs((v.endedAt ?? 0) - v.startedAt)}.`;
  if (v.phase === 'error') return `Failed: ${v.error}`;
  if (v.phase === 'cancelled') return 'Cancelled.';
  const hop = v.hops[v.activeHop];
  const st = hop?.stages.find((s) => s.status === 'active');
  if (!st) return 'Starting…';
  return `${st.label}${st.progress !== null ? `, ${Math.floor(st.progress * 100)}%` : ''}`;
}

function Stages({ viz }: { viz: VizState }) {
  const t = now();
  return (
    <ol className="stages">
      {viz.hops.map((h, i) =>
        h.stages.map((s, j) => (
          <li key={`${i}-${j}`} className={s.status}>
            <span className="st-dot" />
            <span className="st-label">
              {viz.hops.length > 1 && j === 0 ? `${engineName(h.engine)} · ` : ''}
              {s.label}
            </span>
            <span className="st-time">
              {s.status === 'active' && s.progress !== null
                ? `${Math.floor(s.progress * 100)}%`
                : s.startedAt !== undefined
                  ? fmtMs((s.endedAt ?? t) - s.startedAt)
                  : ''}
            </span>
          </li>
        )),
      )}
    </ol>
  );
}

function Formats({ readable }: { readable: Set<FormatId> }) {
  const byFam = new Map<Family, string[]>();
  for (const id of readable) {
    const f = formatInfo(id);
    if (f.family === 'archive') continue;
    byFam.set(f.family, [...(byFam.get(f.family) ?? []), f.label]);
  }
  if (!byFam.size) return null;
  return (
    <div className="formats">
      {FAMILIES.filter((f) => byFam.has(f)).map((f) => (
        <div key={f}>
          <div className="fam-label">{FAMILY_LABEL[f]}</div>
          <div className="formats-list">{byFam.get(f)!.join(' · ')}</div>
        </div>
      ))}
    </div>
  );
}

function Privacy() {
  return (
    <div className="privacy">
      <div className="privacy-title">What happens to your file</div>
      <ul>
        <li className="glass">
          <b>It stays on this device.</b> The conversion engines are WebAssembly programs that run in your
          browser. There is no server to upload to.
        </li>
        <li className="glass">
          <b>The network is locked.</b> Each engine runs in a sandboxed worker that can only load this site&rsquo;s
          own engine files. The page&rsquo;s security policy blocks every other connection.
        </li>
        <li className="glass">
          <b>Nothing is kept.</b> Each conversion gets a fresh worker that is shut down when it finishes. Files are
          never written to storage. Close the tab and they&rsquo;re gone.
        </li>
      </ul>
    </div>
  );
}
