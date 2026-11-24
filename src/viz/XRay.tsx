import { useEffect, useRef, useState } from 'react';
import type { VizState } from './model';
import { Scene, fmtBytes, type HitResult } from './scene';
import { ROLE_COLOR, ROLE_LABEL } from './palette';

/** React host for the canvas scene: sizing, the rAF loop, reduced motion, tooltips. */
export function XRay({ state, label }: { state: VizState | null; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Scene | null>(null);
  const [hit, setHit] = useState<HitResult | null>(null);

  useEffect(() => {
    const cv = canvas.current!;
    const el = wrap.current!;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const sc = new Scene(cv, mq.matches);
    scene.current = sc;
    const onMq = () => sc.setReducedMotion(mq.matches);
    mq.addEventListener('change', onMq);

    const size = () => {
      const w = el.clientWidth;
      const h = w < 640 ? 560 : 520;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      sc.resize(w, h, Math.min(2.5, devicePixelRatio || 1));
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      sc.frame(t - last);
      last = t;
      raf = requestAnimationFrame(loop);
    };
    // Draw only once the self-hosted fonts are ready so text metrics are stable.
    document.fonts.ready.then(() => {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    });
    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq.removeEventListener('change', onMq);
      document.removeEventListener('visibilitychange', onVis);
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setState(state);
  }, [state]);

  const onMove = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    setHit(scene.current?.hitTest(e.clientX - r.left, e.clientY - r.top) ?? null);
  };

  return (
    <div className="xray" ref={wrap} onPointerMove={onMove} onPointerLeave={() => setHit(null)}>
      <canvas ref={canvas} role="img" aria-label={label} />
      {hit && <Tooltip hit={hit} />}
    </div>
  );
}

function Tooltip({ hit }: { hit: HitResult }) {
  const seg = hit.segment;
  const offset = seg ? seg.offset : Math.round(hit.f0 * hit.fileSize);
  const length = seg ? seg.length : Math.round((hit.f1 - hit.f0) * hit.fileSize);
  const left = Math.max(8, hit.x - 140);
  const top = hit.side === 'input' ? hit.y + 40 : hit.y - 110;
  return (
    <div className="xray-tip" style={{ left, top }}>
      <div className="xray-tip-name">
        <i style={{ background: ROLE_COLOR[hit.role] }} />
        {hit.name}
        {seg?.count && seg.count > 1 ? <span> ×{seg.count.toLocaleString()}</span> : null}
      </div>
      <div className="xray-tip-row">{ROLE_LABEL[hit.role]}</div>
      <div className="xray-tip-row">
        offset 0x{offset.toString(16).toUpperCase().padStart(6, '0')} · {fmtBytes(length)} ·{' '}
        {((length / Math.max(1, hit.fileSize)) * 100).toFixed(length / hit.fileSize < 0.001 ? 3 : 1)}%
      </div>
      {seg?.detail && <div className="xray-tip-row detail">{seg.detail}</div>}
      {seg?.children?.length ? <div className="xray-tip-row">{seg.children.length} child segments</div> : null}
    </div>
  );
}
