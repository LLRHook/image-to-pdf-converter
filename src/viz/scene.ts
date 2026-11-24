/**
 * The loading screen: a canvas scene that shows a file's real byte layout
 * being handed to an engine, the decoded in-between representation, and the
 * output file being written, then morphs the output into its real parsed
 * layout.
 *
 * Accuracy rules (see model.ts): positions on the strips are true byte
 * proportions; fills and percentages only follow measured progress; stages
 * without measurements are drawn as indeterminate (shimmer + elapsed time),
 * never as a filling bar.
 *
 * Fluidity: one rAF loop, time-based exponential smoothing for every moving
 * value (frame-rate independent), cached background and glow sprites, no
 * allocations in the hot path beyond packets.
 */
import type { FileStructure, Segment, SegmentRole } from '../core/structure/types';
import { formatInfo } from '../core/formats';
import { engineName } from '../core/engineNames';
import type { VizState, HopView, StageView } from './model';
import { ghostFor } from './templates';
import { ACCENT, BG, FAINT, INK, LINE, MONO, MUTED, PANEL, ROLE_COLOR, ROLE_LABEL, SERIF, rgba } from './palette';

interface Block {
  name: string;
  role: SegmentRole;
  /** Byte range as fractions of the file. */
  f0: number;
  f1: number;
  /** Animated pixel position. */
  x: number;
  w: number;
  alpha: number;
  seg?: Segment;
  departed?: boolean;
  ghost?: boolean;
}

interface Packet {
  color: string;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  t0: number;
  dur: number;
  w0: number;
  label?: string;
}

interface Layout {
  pad: number;
  srcTitleY: number;
  srcCalloutY: number;
  srcY: number;
  stripH: number;
  chamber: { x: number; y: number; w: number; h: number };
  outY: number;
  outCalloutY: number;
  outTitleY: number;
  stripX: number;
  stripW: number;
  compact: boolean;
}

const MAX_PACKET_GROUPS = 120;
const now = () => performance.now() + performance.timeOrigin;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')} min`;
}

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

/** exp smoothing toward target; k = 1/seconds time constant. */
function approach(cur: number, target: number, dt: number, k: number): number {
  return cur + (target - cur) * (1 - Math.exp(-dt * k));
}

function blocksFrom(structure: FileStructure): Block[] {
  const size = Math.max(1, structure.size);
  const segs = [...structure.segments].sort((a, b) => a.offset - b.offset);
  const out: Block[] = [];
  let cursor = 0;
  for (const s of segs) {
    if (s.offset > cursor) {
      out.push({ name: 'unparsed', role: 'unknown', f0: cursor / size, f1: s.offset / size, x: 0, w: 0, alpha: 1 });
    }
    const start = Math.max(cursor, s.offset);
    const end = Math.min(size, s.offset + s.length);
    if (end > start) out.push({ name: s.name, role: s.role, f0: start / size, f1: end / size, x: 0, w: 0, alpha: 1, seg: s });
    cursor = Math.max(cursor, end);
  }
  if (cursor < size) {
    out.push({
      name: structure.truncated ? 'not inspected' : 'unparsed',
      role: 'unknown',
      f0: cursor / size,
      f1: 1,
      x: 0,
      w: 0,
      alpha: 1,
    });
  }
  return out;
}

/** Groups of adjacent blocks, each becoming one travelling packet. */
function packetGroups(blocks: Block[]): { f0: number; f1: number; role: SegmentRole }[] {
  const groups: { f0: number; f1: number; role: SegmentRole; big: number }[] = [];
  const target = 1 / MAX_PACKET_GROUPS;
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    const len = b.f1 - b.f0;
    if (last && last.f1 - last.f0 < target && len < target) {
      last.f1 = b.f1;
      if (len > last.big) {
        last.big = len;
        last.role = b.role;
      }
    } else if (len > target * 3) {
      // Split large segments so payload streams in visibly.
      const n = Math.min(24, Math.ceil(len / target / 2));
      for (let i = 0; i < n; i++) groups.push({ f0: b.f0 + (len * i) / n, f1: b.f0 + (len * (i + 1)) / n, role: b.role, big: len / n });
    } else {
      groups.push({ f0: b.f0, f1: b.f1, role: b.role, big: len });
    }
  }
  return groups;
}

export interface HitResult {
  side: 'input' | 'output';
  name: string;
  role: SegmentRole;
  segment?: Segment;
  x: number;
  y: number;
  fileSize: number;
  f0: number;
  f1: number;
}

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private L!: Layout;
  private bg: HTMLCanvasElement | null = null;
  private glows = new Map<string, HTMLCanvasElement>();
  private state: VizState | null = null;
  private src: Block[] = [];
  private srcStructure: FileStructure | null = null;
  private groups: { f0: number; f1: number; role: SegmentRole; departed: boolean }[] = [];
  private out: Block[] = [];
  private outStructure: FileStructure | null = null;
  private outGhostKey = '';
  private packets: Packet[] = [];
  private shownProgress = 0;
  private shownFill = 0;
  private lastStageKey = '';
  private intakeStart = 0;
  private lastOutPacket = 0;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewKey: unknown = null;
  private previewShownAt = 0;
  private framesCanvases: HTMLCanvasElement[] = [];
  private hopPacketSent = new Set<number>();
  private t = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private reduced: boolean,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  setReducedMotion(r: boolean) {
    this.reduced = r;
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const compact = w < 640;
    const pad = compact ? 16 : 28;
    const stripH = compact ? 22 : 28;
    const srcTitleY = compact ? 22 : 28;
    const srcCalloutY = srcTitleY + (compact ? 26 : 32);
    const srcY = srcCalloutY + (compact ? 14 : 16);
    const outTitleY = h - (compact ? 14 : 18);
    const outCalloutY = outTitleY - (compact ? 22 : 26);
    const outY = outCalloutY - (compact ? 14 : 16) - stripH;
    const chY = srcY + stripH + (compact ? 40 : 56);
    const chH = outY - (compact ? 40 : 56) - chY;
    this.L = {
      pad,
      srcTitleY,
      srcCalloutY,
      srcY,
      stripH,
      chamber: { x: pad, y: chY, w: w - pad * 2, h: Math.max(120, chH) },
      outY,
      outCalloutY,
      outTitleY,
      stripX: pad,
      stripW: w - pad * 2,
      compact,
    };
    this.bg = null;
    // Snap blocks to the new geometry.
    for (const b of [...this.src, ...this.out]) {
      b.x = this.L.stripX + b.f0 * this.L.stripW;
      b.w = (b.f1 - b.f0) * this.L.stripW;
    }
  }

  setState(s: VizState | null) {
    const prev = this.state;
    this.state = s;
    if (!s) {
      this.reset();
      return;
    }
    if (s.input.structure && s.input.structure !== this.srcStructure) {
      this.srcStructure = s.input.structure;
      this.src = blocksFrom(s.input.structure);
      for (const b of this.src) {
        b.x = this.L.stripX + b.f0 * this.L.stripW;
        b.w = this.reduced ? (b.f1 - b.f0) * this.L.stripW : 0;
        b.alpha = this.reduced ? 1 : 0;
      }
      this.groups = packetGroups(this.src).map((g) => ({ ...g, departed: false }));
    }
    if (prev && prev.startedAt !== s.startedAt) {
      // New run on the same input: un-read the source.
      this.groups.forEach((g) => (g.departed = false));
      for (const b of this.src) b.departed = false;
      this.packets = [];
      this.hopPacketSent.clear();
      this.out = [];
      this.outStructure = null;
      this.outGhostKey = '';
      this.shownFill = 0;
    }
    const finalHop = s.hops[s.hops.length - 1];
    const ghostKey = `${s.route.to}:${s.startedAt}`;
    if (this.outGhostKey !== ghostKey && s.hops.length) {
      this.outGhostKey = ghostKey;
      const parts = ghostFor(s.route.to, false);
      const total = parts.reduce((a, p) => a + p.weight, 0);
      let acc = 0;
      this.out = parts.map((p) => {
        const f0 = acc / total;
        acc += p.weight;
        const f1 = acc / total;
        return { name: p.name, role: p.role, f0, f1, x: this.L.stripX + f0 * this.L.stripW, w: (f1 - f0) * this.L.stripW, alpha: 0, ghost: true };
      });
      this.outStructure = null;
    }
    if (s.output?.structure && s.output.structure !== this.outStructure) {
      this.outStructure = s.output.structure;
      const real = blocksFrom(s.output.structure);
      // Start each real block where the ghost of the same role was, so the
      // expected layout visibly resolves into the true one.
      for (const b of real) {
        const ghost = this.out.find((o) => o.role === b.role) ?? this.out[this.out.length - 1];
        b.x = this.reduced ? this.L.stripX + b.f0 * this.L.stripW : ghost?.x ?? this.L.stripX;
        b.w = this.reduced ? (b.f1 - b.f0) * this.L.stripW : ghost?.w ?? 0;
        b.alpha = 1;
      }
      this.out = real;
    }
    const preview = s.hops.map((h) => h.preview).filter(Boolean).at(-1) ?? null;
    if (preview !== this.previewKey) {
      this.previewKey = preview;
      this.previewCanvas = null;
      this.framesCanvases = [];
      this.previewShownAt = performance.now();
      if (preview?.kind === 'pixels') this.previewCanvas = rgbaCanvas(preview.rgba, preview.width, preview.height);
      if (preview?.kind === 'frames')
        this.framesCanvases = preview.frames.map((f) => rgbaCanvas(f, preview.width, preview.height));
    }
    void finalHop;
  }

  private reset() {
    this.src = [];
    this.srcStructure = null;
    this.groups = [];
    this.out = [];
    this.outStructure = null;
    this.outGhostKey = '';
    this.packets = [];
    this.shownFill = 0;
    this.shownProgress = 0;
    this.previewCanvas = null;
    this.previewKey = null;
    this.framesCanvases = [];
    this.hopPacketSent.clear();
  }

  /* ------------------------------------------------------------ frame */

  frame(dtMs: number) {
    const dt = Math.min(0.1, dtMs / 1000);
    this.t += dt;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground();
    const s = this.state;
    this.updateBlocks(dt);
    this.drawSource();
    this.drawChamber(dt);
    this.drawOutput(dt);
    if (s) this.spawnAndDrawPackets(dt);
  }

  private drawBackground() {
    const c = this.ctx;
    if (!this.bg) {
      const bg = document.createElement('canvas');
      bg.width = this.canvas.width;
      bg.height = this.canvas.height;
      const b = bg.getContext('2d')!;
      b.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      b.fillStyle = BG;
      b.fillRect(0, 0, this.w, this.h);
      // Blueprint dot grid.
      b.fillStyle = 'rgba(236,231,221,0.055)';
      for (let y = 12; y < this.h; y += 16) for (let x = 12; x < this.w; x += 16) b.fillRect(x, y, 1, 1);
      // Chamber.
      const ch = this.L.chamber;
      b.fillStyle = PANEL;
      roundRect(b, ch.x, ch.y, ch.w, ch.h, 14);
      b.fill();
      b.strokeStyle = LINE;
      b.lineWidth = 1;
      roundRect(b, ch.x + 0.5, ch.y + 0.5, ch.w - 1, ch.h - 1, 14);
      b.stroke();
      // Intake / outlet notches.
      b.fillStyle = BG;
      b.fillRect(ch.x + ch.w / 2 - 40, ch.y - 1, 80, 3);
      b.fillRect(ch.x + ch.w / 2 - 40, ch.y + ch.h - 2, 80, 3);
      b.fillStyle = FAINT;
      b.fillRect(ch.x + ch.w / 2 - 40, ch.y, 1, 6);
      b.fillRect(ch.x + ch.w / 2 + 39, ch.y, 1, 6);
      b.fillRect(ch.x + ch.w / 2 - 40, ch.y + ch.h - 6, 1, 6);
      b.fillRect(ch.x + ch.w / 2 + 39, ch.y + ch.h - 6, 1, 6);
      this.bg = bg;
    }
    c.drawImage(this.bg, 0, 0, this.w, this.h);
  }

  private updateBlocks(dt: number) {
    const k = this.reduced ? 40 : 9;
    for (const b of this.src) {
      const tx = this.L.stripX + b.f0 * this.L.stripW;
      const tw = (b.f1 - b.f0) * this.L.stripW;
      b.x = approach(b.x, tx, dt, k);
      b.w = approach(b.w, tw, dt, k * 0.8);
      b.alpha = approach(b.alpha, 1, dt, 6);
    }
    for (const b of this.out) {
      const tx = this.L.stripX + b.f0 * this.L.stripW;
      const tw = (b.f1 - b.f0) * this.L.stripW;
      b.x = approach(b.x, tx, dt, k);
      b.w = approach(b.w, tw, dt, k);
      b.alpha = approach(b.alpha, 1, dt, 5);
    }
  }

  /* ------------------------------------------------------------ strips */

  private drawStrip(blocks: Block[], y: number, opts: { fill?: number; ghost?: boolean; dimDeparted?: boolean }) {
    const c = this.ctx;
    const { stripX, stripW, stripH } = this.L;
    c.fillStyle = '#16171b';
    c.fillRect(stripX, y, stripW, stripH);
    for (const b of blocks) {
      if (b.w <= 0.01) continue;
      const color = ROLE_COLOR[b.role];
      const w = Math.max(0.75, b.w);
      if (opts.ghost) {
        c.strokeStyle = rgba(color, 0.55 * b.alpha);
        c.setLineDash([3, 3]);
        c.strokeRect(b.x + 0.5, y + 0.5, Math.max(0, w - 1), stripH - 1);
        c.setLineDash([]);
        continue;
      }
      const dim = opts.dimDeparted && b.departed;
      c.fillStyle = rgba(color, (dim ? 0.22 : b.name === 'not inspected' ? 0.18 : 0.92) * b.alpha);
      c.fillRect(b.x, y, w, stripH);
      if (dim) {
        c.strokeStyle = rgba(color, 0.5 * b.alpha);
        c.strokeRect(b.x + 0.5, y + 0.5, Math.max(0, w - 1), stripH - 1);
      }
    }
    // Fill overlay for the output being written (measured only).
    if (opts.fill !== undefined && opts.ghost) {
      const fw = stripW * opts.fill;
      c.save();
      c.beginPath();
      c.rect(stripX, y, fw, stripH);
      c.clip();
      for (const b of blocks) {
        c.fillStyle = rgba(ROLE_COLOR[b.role], 0.85);
        c.fillRect(b.x, y, Math.max(0.75, b.w), stripH);
      }
      c.restore();
    }
    // Segment separators + inline labels where they fit.
    c.font = `500 ${this.L.compact ? 9 : 10}px ${MONO}`;
    c.textBaseline = 'middle';
    for (const b of blocks) {
      if (b.w > 3) {
        c.fillStyle = 'rgba(12,13,15,0.55)';
        c.fillRect(b.x + b.w - 0.5, y, 1, stripH);
      }
      const label = b.name;
      const tw = measure(c, label);
      if (b.w > tw + 12 && !(opts.dimDeparted && b.departed)) {
        c.fillStyle = opts.ghost ? rgba(ROLE_COLOR[b.role], 0.8) : 'rgba(12,13,15,0.82)';
        c.fillText(label, b.x + 6, y + stripH / 2 + 0.5);
      }
    }
  }

  /** Names for segments too thin to label inline, lifted above/below the strip with leader lines. */
  private drawCallouts(blocks: Block[], stripY: number, labelY: number, above: boolean) {
    const c = this.ctx;
    const { stripH } = this.L;
    c.font = `500 ${this.L.compact ? 9 : 10}px ${MONO}`;
    c.textBaseline = 'middle';
    // Pick the most structurally interesting thin segments. Labels in the left
    // half are packed left-to-right, labels in the right half right-to-left, so
    // clusters at either end of a file stay next to their segments.
    const max = this.L.compact ? 5 : 10;
    const picked = blocks
      .filter((b) => b.w > 0 && b.name !== 'unparsed' && measure(c, b.name) + 12 >= b.w)
      .sort((a, b) => calloutPriority(b.role) - calloutPriority(a.role) || a.f0 - b.f0)
      .slice(0, max)
      .sort((a, b) => a.f0 - b.f0);
    const left = this.L.stripX;
    const right = left + this.L.stripW;
    const mid = left + this.L.stripW / 2;
    const maxShift = this.L.stripW * 0.22;
    const placed: { b: Block; lx: number; tw: number }[] = [];
    let cursor = left;
    for (const b of picked.filter((x) => x.x + x.w / 2 < mid)) {
      const tw = measure(c, b.name);
      const cx = b.x + b.w / 2;
      const lx = Math.max(cx - tw / 2, cursor);
      if (lx + tw > right || Math.abs(lx + tw / 2 - cx) > maxShift) continue;
      placed.push({ b, lx, tw });
      cursor = lx + tw + 12;
    }
    let rcursor = right;
    for (const b of picked.filter((x) => x.x + x.w / 2 >= mid).reverse()) {
      const tw = measure(c, b.name);
      const cx = b.x + b.w / 2;
      const lx = Math.min(cx - tw / 2, rcursor - tw);
      if (lx < cursor || Math.abs(lx + tw / 2 - cx) > maxShift) continue;
      placed.push({ b, lx, tw });
      rcursor = lx - 12;
    }
    for (const { b, lx, tw } of placed) {
      const cx = b.x + b.w / 2;
      const color = ROLE_COLOR[b.role];
      c.strokeStyle = rgba(color, 0.45 * b.alpha);
      c.beginPath();
      const y0 = above ? stripY : stripY + stripH;
      const y1 = above ? labelY + 7 : labelY - 7;
      c.moveTo(cx + 0.5, y0);
      c.lineTo(cx + 0.5, (y0 + y1) / 2);
      c.lineTo(lx + tw / 2 + 0.5, y1);
      c.stroke();
      c.fillStyle = rgba(color, 0.95 * b.alpha);
      c.fillText(b.name, lx, labelY);
    }
  }

  private drawSource() {
    const s = this.state;
    const c = this.ctx;
    const L = this.L;
    if (!s) return;
    const info = formatInfo(s.input.format);
    c.textBaseline = 'alphabetic';
    c.fillStyle = MUTED;
    c.font = `500 ${L.compact ? 9 : 10}px ${MONO}`;
    c.fillText('INPUT', L.pad, L.srcTitleY - (L.compact ? 0 : 1));
    const labelW = measure(c, 'INPUT') + 12;
    c.fillStyle = INK;
    c.font = `${L.compact ? 17 : 21}px ${SERIF}`;
    const nameMax = L.stripW - labelW - 200;
    c.fillText(ellipsize(c, s.input.name, Math.max(80, nameMax)), L.pad + labelW, L.srcTitleY);
    c.font = `500 ${L.compact ? 9 : 10}px ${MONO}`;
    c.fillStyle = MUTED;
    const meta = `${info.label} · ${fmtBytes(s.input.size)}`;
    c.textAlign = 'right';
    c.fillText(meta, L.pad + L.stripW, L.srcTitleY);
    c.textAlign = 'left';

    if (!this.src.length) {
      // Structure still being parsed.
      c.fillStyle = '#16171b';
      c.fillRect(L.stripX, L.srcY, L.stripW, L.stripH);
      if (!this.reduced) {
        const x = L.stripX + ((this.t * 0.45) % 1) * L.stripW;
        const grad = c.createLinearGradient(x - 120, 0, x, 0);
        grad.addColorStop(0, 'rgba(236,231,221,0)');
        grad.addColorStop(1, 'rgba(236,231,221,0.08)');
        c.fillStyle = grad;
        c.fillRect(Math.max(L.stripX, x - 120), L.srcY, Math.min(120, x - L.stripX), L.stripH);
      }
      c.fillStyle = MUTED;
      c.font = `500 10px ${MONO}`;
      c.textBaseline = 'middle';
      c.fillText('reading structure…', L.stripX + 8, L.srcY + L.stripH / 2);
      return;
    }
    this.drawStrip(this.src, L.srcY, { dimDeparted: true });
    this.drawCallouts(this.src, L.srcY, L.srcCalloutY, true);
  }

  private drawOutput(dt: number) {
    const s = this.state;
    const c = this.ctx;
    const L = this.L;
    if (!s || !this.out.length) return;
    const final = s.hops[s.hops.length - 1];
    const writing = final ? final.stages.find((x) => x.status === 'active' && (x.id === 'encode' || x.id === 'package')) : undefined;
    const finalDone = final?.status === 'done';
    const measured = writing && writing.progress !== null ? writing.progress : null;
    const ghost = !this.outStructure;
    let targetFill = finalDone ? 1 : measured ?? (writing && writing.status === 'done' ? 1 : this.shownFill);
    if (!finalDone && !writing) targetFill = this.shownFill;
    this.shownFill = approach(this.shownFill, targetFill, dt, this.reduced ? 40 : 7);

    c.textBaseline = 'alphabetic';
    // Title row.
    c.fillStyle = MUTED;
    c.font = `500 ${L.compact ? 9 : 10}px ${MONO}`;
    c.fillText('OUTPUT', L.pad, L.outTitleY);
    const labelW = measure(c, 'OUTPUT') + 12;
    const info = formatInfo(s.route.to);
    c.fillStyle = s.output ? INK : MUTED;
    c.font = `${L.compact ? 17 : 21}px ${SERIF}`;
    const outName = s.output?.name ?? `${info.label} · being written`;
    c.fillText(ellipsize(c, outName, Math.max(80, L.stripW - labelW - 220)), L.pad + labelW, L.outTitleY);
    c.font = `500 ${L.compact ? 9 : 10}px ${MONO}`;
    c.textAlign = 'right';
    c.fillStyle = MUTED;
    if (s.output) {
      const ratio = s.output.size / Math.max(1, s.input.size);
      c.fillText(`${info.label} · ${fmtBytes(s.output.size)} · ×${ratio < 0.01 ? ratio.toExponential(1) : ratio.toFixed(2)}`, L.pad + L.stripW, L.outTitleY);
    } else if (ghost) {
      c.fillText('expected layout · real sizes after write', L.pad + L.stripW, L.outTitleY);
    }
    c.textAlign = 'left';

    this.drawStrip(this.out, L.outY, { ghost, fill: ghost ? this.shownFill : undefined });
    // Indeterminate writing: shimmer across the ghost, never a fill.
    if (ghost && writing && measured === null && !this.reduced) {
      const x = L.stripX + ((this.t * 0.6) % 1.3) * L.stripW;
      const grad = c.createLinearGradient(x - 160, 0, x, 0);
      grad.addColorStop(0, 'rgba(255,181,71,0)');
      grad.addColorStop(1, 'rgba(255,181,71,0.18)');
      c.fillStyle = grad;
      c.fillRect(Math.max(L.stripX, x - 160), L.outY, Math.max(0, Math.min(160, x - L.stripX, L.stripX + L.stripW - (x - 160))), L.stripH);
    }
    this.drawCallouts(this.out, L.outY, L.outCalloutY, false);
  }

  /* ------------------------------------------------------------ chamber */

  private drawChamber(dt: number) {
    const s = this.state;
    const c = this.ctx;
    const ch = this.L.chamber;
    const L = this.L;
    if (!s) return;
    const hop = s.hops[s.activeHop];
    if (!hop) {
      // File inspected, no target chosen yet: show what the parser found.
      const x0 = ch.x + 20;
      c.textBaseline = 'alphabetic';
      c.font = `${L.compact ? 24 : 32}px ${SERIF}`;
      c.fillStyle = INK;
      c.fillText(this.srcStructure ? 'Inspected' : 'Inspecting…', x0, ch.y + (L.compact ? 50 : 60));
      c.font = `500 ${L.compact ? 10 : 11}px ${MONO}`;
      c.fillStyle = MUTED;
      const summary = this.srcStructure?.summary ?? 'Reading the file’s own structure';
      c.fillText(ellipsize(c, summary, ch.w - 40), x0, ch.y + (L.compact ? 72 : 84));
      if (this.srcStructure) {
        c.fillText(
          `${this.srcStructure.segments.length.toLocaleString()} top-level segments${this.srcStructure.truncated ? ' · stopped at read budget' : ''} · choose an output format`,
          x0,
          ch.y + (L.compact ? 90 : 104),
        );
        this.drawLegend(x0, ch.y + ch.h - 26, L.compact ? ch.w - 40 : ch.w * 0.5 - 40);
        if (!L.compact) this.drawManifest(this.srcStructure, ch.x + ch.w * 0.5, ch.y + 22, ch.w * 0.5 - 20, ch.h - 44);
      }
      // Output strip placeholder keeps the layout stable before a target is chosen.
      c.strokeStyle = 'rgba(236,231,221,0.08)';
      c.setLineDash([4, 4]);
      c.strokeRect(L.stripX + 0.5, L.outY + 0.5, L.stripW - 1, L.stripH - 1);
      c.setLineDash([]);
      c.font = `500 10px ${MONO}`;
      c.fillStyle = FAINT;
      c.textBaseline = 'middle';
      c.fillText('output layout appears here', L.stripX + 10, L.outY + L.stripH / 2);
      c.textBaseline = 'alphabetic';
      return;
    }
    const active = hop.stages.find((x) => x.status === 'active');
    const t = now();
    const inner = { x: ch.x + 20, y: ch.y + 16, w: ch.w - 40, h: ch.h - 32 };

    // Header: hop chips.
    c.textBaseline = 'alphabetic';
    let x = inner.x;
    c.font = `500 ${L.compact ? 9 : 10}px ${MONO}`;
    s.hops.forEach((h, i) => {
      const label = `${s.hops.length > 1 ? `${i + 1} · ` : ''}${engineName(h.engine)}  ${formatInfo(h.from).label}→${formatInfo(h.to).label}`;
      const tw = measure(c, label);
      const isActive = i === s.activeHop && s.phase === 'running';
      c.fillStyle = h.status === 'done' ? rgba(ACCENT, 0.12) : isActive ? rgba(ACCENT, 0.2) : 'rgba(236,231,221,0.04)';
      roundRect(c, x, inner.y, tw + 20, 20, 10);
      c.fill();
      c.fillStyle = h.status === 'failed' ? ROLE_COLOR.media : isActive || h.status === 'done' ? ACCENT : MUTED;
      c.fillText(label, x + 10, inner.y + 14);
      x += tw + 28;
    });

    // Title + stage line.
    const titleY = inner.y + (L.compact ? 50 : 58);
    c.font = `${L.compact ? 24 : 32}px ${SERIF}`;
    c.fillStyle = INK;
    let title = engineName(hop.engine);
    let sub = '';
    if (s.phase === 'done') {
      title = 'Done';
      sub = `${fmtMs((s.endedAt ?? t) - s.startedAt)} on this device · nothing uploaded`;
    } else if (s.phase === 'error') {
      title = 'Conversion failed';
      sub = s.error ?? '';
    } else if (s.phase === 'cancelled') {
      title = 'Cancelled';
      sub = 'The worker was stopped and its memory released.';
    } else if (active) {
      sub = active.label;
    } else {
      sub = 'Starting worker…';
    }
    c.fillText(title, inner.x, titleY);
    c.font = `500 ${L.compact ? 10 : 11}px ${MONO}`;
    c.fillStyle = s.phase === 'error' ? ROLE_COLOR.media : MUTED;
    c.fillText(ellipsize(c, sub, inner.w * (L.compact ? 1 : 0.5)), inner.x, titleY + 22);

    // Fallback notice.
    if (hop.fallbacks.length && s.phase === 'running') {
      const fb = hop.fallbacks[hop.fallbacks.length - 1]!;
      c.fillStyle = rgba(ROLE_COLOR.palette, 0.9);
      c.fillText(ellipsize(c, `${engineName(fb.fromEngine)} can't do this here → switched to ${engineName(hop.engine)}`, inner.w * 0.5), inner.x, titleY + 40);
    }

    // Progress row (measured) or indeterminate meter.
    const barY = inner.y + inner.h - 26;
    const barW = L.compact ? inner.w : inner.w * 0.42;
    if (s.phase === 'running' && active) {
      const asset = hop.assets.find((a) => a.total === null || a.loaded < a.total);
      this.drawStageMeter(active, hop, asset ?? null, inner.x, barY, barW, dt, t);
    } else if (s.phase === 'done') {
      this.drawStageTimeline(s, inner.x, barY, barW);
    }

    // Representation panel on the right (or below on compact).
    const ir = L.compact
      ? { x: inner.x, y: titleY + 52, w: inner.w, h: barY - (titleY + 52) - 14 }
      : { x: inner.x + inner.w * 0.5, y: inner.y + 30, w: inner.w * 0.5, h: inner.h - 30 };
    if (ir.h > 40) this.drawRepresentation(s, hop, ir);
  }

  /** A hex-editor style table of the real top-level segments: offset, name, size, parsed detail. */
  private drawManifest(st: FileStructure, x: number, y: number, w: number, h: number) {
    const c = this.ctx;
    const rowH = 17;
    const rows = Math.max(1, Math.floor((h - 18) / rowH));
    const segs = st.segments;
    // Long files: show the head and the tail, which is where formats keep their structure.
    const list: (Segment | null)[] =
      segs.length <= rows ? segs : [...segs.slice(0, rows - 3), null, ...segs.slice(segs.length - 2)];
    c.font = `500 9px ${MONO}`;
    c.textBaseline = 'alphabetic';
    c.fillStyle = FAINT;
    c.fillText('OFFSET', x, y + 10);
    c.fillText('SEGMENT', x + 78, y + 10);
    c.textAlign = 'right';
    c.fillText('BYTES', x + w, y + 10);
    c.textAlign = 'left';
    list.forEach((s, i) => {
      const ry = y + 28 + i * rowH;
      if (!s) {
        c.fillStyle = FAINT;
        c.fillText(`⋯ ${(segs.length - rows + 1).toLocaleString()} more`, x + 78, ry);
        return;
      }
      c.fillStyle = MUTED;
      c.fillText(`0x${s.offset.toString(16).toUpperCase().padStart(6, '0')}`, x, ry);
      c.fillStyle = ROLE_COLOR[s.role];
      c.fillRect(x + 66, ry - 7, 6, 6);
      c.fillStyle = INK;
      const sizeText = s.length.toLocaleString();
      const sw = measure(c, sizeText);
      const name = `${s.name}${s.count && s.count > 1 ? ` ×${s.count}` : ''}`;
      const nameW = Math.min(measure(c, name), (w - 78 - sw) * 0.5);
      c.fillText(ellipsize(c, name, nameW + 1), x + 78, ry);
      if (s.detail) {
        c.fillStyle = MUTED;
        c.fillText(ellipsize(c, s.detail, w - 78 - nameW - sw - 24), x + 78 + nameW + 10, ry);
      }
      c.textAlign = 'right';
      c.fillStyle = MUTED;
      c.fillText(sizeText, x + w, ry);
      c.textAlign = 'left';
    });
  }

  /** Byte share per role in the input, as a legend. */
  private drawLegend(x: number, y: number, maxW: number) {
    const c = this.ctx;
    const share = new Map<SegmentRole, number>();
    for (const b of this.src) share.set(b.role, (share.get(b.role) ?? 0) + (b.f1 - b.f0));
    const items = [...share.entries()].sort((a, b) => b[1] - a[1]);
    c.font = `500 10px ${MONO}`;
    let cx = x;
    for (const [role, f] of items) {
      const pct = f * 100;
      const label = `${ROLE_LABEL[role]} ${pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%`;
      const tw = measure(c, label) + 22;
      if (cx + tw > x + maxW) break;
      c.fillStyle = ROLE_COLOR[role];
      c.fillRect(cx, y - 8, 8, 8);
      c.fillStyle = MUTED;
      c.fillText(label, cx + 13, y);
      cx += tw;
    }
  }

  private drawStageMeter(st: StageView, hop: HopView, asset: { loaded: number; total: number | null } | null, x: number, y: number, w: number, dt: number, t: number) {
    const c = this.ctx;
    const key = `${hop.engine}:${st.id}:${st.startedAt}`;
    if (key !== this.lastStageKey) {
      this.lastStageKey = key;
      this.shownProgress = 0;
    }
    c.font = `500 10px ${MONO}`;
    c.textBaseline = 'alphabetic';
    let measured: number | null = st.progress;
    let label: string;
    if (asset && st.id === 'load') {
      measured = asset.total ? asset.loaded / asset.total : null;
      label = asset.total
        ? `downloading engine · ${fmtBytes(asset.loaded)} / ${fmtBytes(asset.total)}`
        : `downloading engine · ${fmtBytes(asset.loaded)}`;
    } else {
      label = measured !== null ? `${Math.floor(this.shownProgress * 100)}% measured` : `running · ${fmtMs(t - (st.startedAt ?? t))}`;
    }
    c.fillStyle = 'rgba(236,231,221,0.07)';
    c.fillRect(x, y, w, 3);
    if (measured !== null) {
      this.shownProgress = approach(this.shownProgress, measured, dt, this.reduced ? 40 : 8);
      c.fillStyle = ACCENT;
      c.fillRect(x, y, w * this.shownProgress, 3);
    } else if (!this.reduced) {
      // Indeterminate: a travelling segment, clearly not a fill level.
      const p = (this.t * 0.7) % 1;
      const seg = w * 0.18;
      const sx = x - seg + p * (w + seg);
      c.fillStyle = rgba(ACCENT, 0.75);
      c.fillRect(Math.max(x, sx), y, Math.max(0, Math.min(seg, x + w - sx, sx + seg - x)), 3);
    }
    c.fillStyle = MUTED;
    c.fillText(label, x, y + 18);
  }

  private drawStageTimeline(s: VizState, x: number, y: number, w: number) {
    const c = this.ctx;
    const stages = s.hops.flatMap((h) => h.stages.filter((st) => st.startedAt !== undefined && st.endedAt !== undefined));
    const total = Math.max(1, (s.endedAt ?? 0) - s.startedAt);
    c.font = `500 10px ${MONO}`;
    c.textBaseline = 'alphabetic';
    let cx = x;
    const colors = [ACCENT, ROLE_COLOR.pixels, ROLE_COLOR.text, ROLE_COLOR.metadata, ROLE_COLOR.samples, ROLE_COLOR.index];
    stages.forEach((st, i) => {
      const sw = Math.max(2, (((st.endedAt ?? 0) - (st.startedAt ?? 0)) / total) * w);
      c.fillStyle = colors[i % colors.length]!;
      c.fillRect(cx, y, Math.min(sw, x + w - cx), 3);
      cx += sw;
    });
    c.fillStyle = MUTED;
    const slowest = [...stages].sort((a, b) => (b.endedAt! - b.startedAt!) - (a.endedAt! - a.startedAt!))[0];
    c.fillText(slowest ? `longest step: ${slowest.label} · ${fmtMs(slowest.endedAt! - slowest.startedAt!)}` : '', x, y + 18);
  }

  private drawRepresentation(s: VizState, hop: HopView, r: { x: number; y: number; w: number; h: number }) {
    const c = this.ctx;
    const facts = s.hops.map((h) => h.facts).filter(Boolean).at(-1) ?? null;
    const preview = s.hops.map((h) => h.preview).filter(Boolean).at(-1) ?? null;
    const labelY = r.y + r.h - 4;
    c.font = `500 10px ${MONO}`;
    c.textBaseline = 'alphabetic';
    const factLine = facts ? describeFacts(facts) : '';
    const reveal = this.reduced ? 1 : Math.min(1, (performance.now() - this.previewShownAt) / 650);
    const box = { x: r.x, y: r.y, w: r.w, h: r.h - 22 };

    if (preview?.kind === 'pixels' && this.previewCanvas) {
      const scale = Math.min(box.w / preview.width, box.h / preview.height);
      const dw = preview.width * scale;
      const dh = preview.height * scale;
      const dx = box.x + box.w - dw;
      const dy = box.y + (box.h - dh) / 2;
      c.save();
      c.beginPath();
      c.rect(dx, dy, dw, dh * easeOut(reveal));
      c.clip();
      c.imageSmoothingEnabled = false;
      c.drawImage(this.previewCanvas, dx, dy, dw, dh);
      // Pixel grid: each cell is one real sampled pixel.
      if (scale >= 5) {
        c.strokeStyle = 'rgba(12,13,15,0.35)';
        c.lineWidth = 1;
        c.beginPath();
        for (let i = 1; i < preview.width; i++) {
          c.moveTo(Math.round(dx + i * scale) + 0.5, dy);
          c.lineTo(Math.round(dx + i * scale) + 0.5, dy + dh);
        }
        for (let j = 1; j < preview.height; j++) {
          c.moveTo(dx, Math.round(dy + j * scale) + 0.5);
          c.lineTo(dx + dw, Math.round(dy + j * scale) + 0.5);
        }
        c.stroke();
      }
      c.restore();
      if (!this.reduced && reveal < 1) {
        c.fillStyle = rgba(ROLE_COLOR.pixels, 0.7);
        c.fillRect(dx, dy + dh * easeOut(reveal), dw, 1.5);
      }
      c.fillStyle = MUTED;
      c.textAlign = 'right';
      c.fillText(`${factLine}${facts ? ' · ' : ''}${preview.width}×${preview.height} real sample`, box.x + box.w, labelY);
      c.textAlign = 'left';
      return;
    }
    if (preview?.kind === 'frames' && this.framesCanvases.length) {
      const n = this.framesCanvases.length;
      const gap = 6;
      const fw = Math.min((box.w - gap * (n - 1)) / n, (box.h - 16) * (preview.width / preview.height));
      const fh = fw * (preview.height / preview.width);
      const total = fw * n + gap * (n - 1);
      const x0 = box.x + box.w - total;
      const y0 = box.y + (box.h - fh) / 2;
      this.framesCanvases.forEach((fc, i) => {
        const a = Math.min(1, Math.max(0, reveal * n - i));
        c.globalAlpha = a;
        c.imageSmoothingEnabled = true;
        c.drawImage(fc, x0 + i * (fw + gap), y0, fw, fh);
        c.fillStyle = MUTED;
        c.font = `500 9px ${MONO}`;
        c.fillText(fmtDuration(preview.times[i] ?? 0), x0 + i * (fw + gap), y0 + fh + 12);
        c.globalAlpha = 1;
      });
      c.font = `500 10px ${MONO}`;
      c.fillStyle = MUTED;
      c.textAlign = 'right';
      c.fillText(factLine, box.x + box.w, labelY);
      c.textAlign = 'left';
      return;
    }
    if (preview?.kind === 'waveform') {
      const n = preview.peaks.length;
      const bw = box.w / n;
      const mid = box.y + box.h / 2;
      c.fillStyle = rgba(ROLE_COLOR.samples, 0.9);
      for (let i = 0; i < n; i++) {
        if (i / n > reveal) break;
        const p = preview.peaks[i] ?? 0;
        const hh = Math.max(1, p * box.h * 0.48);
        c.fillRect(box.x + i * bw, mid - hh, Math.max(1, bw - 1), hh * 2);
      }
      c.fillStyle = MUTED;
      c.textAlign = 'right';
      c.fillText(factLine, box.x + box.w, labelY);
      c.textAlign = 'left';
      return;
    }
    if (preview?.kind === 'outline') {
      const lineH = 14;
      const rows = Math.min(preview.items.length, Math.floor(box.h / lineH));
      c.font = `500 10px ${MONO}`;
      for (let i = 0; i < rows; i++) {
        if (i / rows > reveal) break;
        const it = preview.items[i]!;
        const y = box.y + i * lineH + 10;
        const indent = Math.min(4, it.level) * 12;
        const color = it.level > 0 ? ROLE_COLOR.header : ROLE_COLOR.text;
        c.fillStyle = rgba(color, 0.9);
        c.fillRect(box.x + indent, y - 7, 3, 9);
        c.fillStyle = it.level > 0 ? INK : MUTED;
        c.fillText(ellipsize(c, it.text, box.w - indent - 12), box.x + indent + 9, y);
      }
      c.fillStyle = MUTED;
      c.textAlign = 'right';
      c.fillText(factLine, box.x + box.w, labelY);
      c.textAlign = 'left';
      return;
    }
    if (preview?.kind === 'grid') {
      const rows = preview.rows.slice(0, Math.floor(box.h / 16));
      const cols = Math.max(1, ...rows.map((r) => r.length));
      const cw = box.w / cols;
      c.font = `500 9px ${MONO}`;
      rows.forEach((row, i) => {
        if (i / rows.length > reveal) return;
        const y = box.y + i * 16;
        row.forEach((cell, j) => {
          c.fillStyle = i === 0 ? rgba(ROLE_COLOR.header, 0.12) : 'rgba(236,231,221,0.035)';
          c.fillRect(box.x + j * cw, y, cw - 2, 14);
          c.fillStyle = i === 0 ? ROLE_COLOR.header : INK;
          c.fillText(ellipsize(c, cell, cw - 8), box.x + j * cw + 4, y + 10);
        });
      });
      c.font = `500 10px ${MONO}`;
      c.fillStyle = MUTED;
      c.textAlign = 'right';
      c.fillText(factLine, box.x + box.w, labelY);
      c.textAlign = 'left';
      return;
    }
    if (facts) {
      c.textAlign = 'right';
      c.fillStyle = INK;
      c.font = `${this.L.compact ? 22 : 30}px ${SERIF}`;
      c.fillText(bigFact(facts), box.x + box.w, box.y + box.h / 2 + 8);
      c.font = `500 10px ${MONO}`;
      c.fillStyle = MUTED;
      c.fillText(factLine, box.x + box.w, labelY);
      c.textAlign = 'left';
      return;
    }
    // Nothing decoded yet: an engine core, rotating only while work is running.
    const cx = box.x + box.w - Math.min(box.w, box.h) / 2;
    const cy = box.y + box.h / 2;
    const rad = Math.min(box.w, box.h) * 0.32;
    const running = s.phase === 'running';
    for (let i = 0; i < 3; i++) {
      c.strokeStyle = rgba(i === 0 ? ACCENT : i === 1 ? ROLE_COLOR.pixels : ROLE_COLOR.text, 0.6 - i * 0.15);
      c.lineWidth = 2;
      c.beginPath();
      const a0 = (running && !this.reduced ? this.t * (0.9 + i * 0.5) * (i % 2 ? -1 : 1) : 0) + i;
      c.arc(cx, cy, rad - i * 9, a0, a0 + Math.PI * (0.9 - i * 0.2));
      c.stroke();
    }
    c.lineWidth = 1;
    void hop;
  }

  /* ------------------------------------------------------------ packets */

  private spawnAndDrawPackets(dt: number) {
    const s = this.state!;
    const c = this.ctx;
    const L = this.L;
    const ch = L.chamber;
    const tnow = performance.now();
    const hop0 = s.hops[0];
    const intakeStage = hop0?.stages.find((x) => (x.id === 'read' || x.id === 'decode' || x.id === 'transform' || x.id === 'encode') && x.status !== 'pending');

    // 1. Source bytes into the first engine.
    if (hop0 && this.groups.length && (intakeStage || hop0.status === 'done')) {
      if (!this.intakeStart) this.intakeStart = tnow;
      const measured = intakeStage && (intakeStage.id === 'read' || intakeStage.id === 'decode') && intakeStage.status === 'active' ? intakeStage.progress : null;
      // Measured read/decode: bytes enter as they are consumed.
      // Otherwise the engine received the whole file at once: hand it over in file order.
      const threshold = measured !== null ? measured : Math.min(1, (tnow - this.intakeStart) / (this.reduced ? 1 : 700));
      for (const g of this.groups) {
        if (g.departed || g.f1 > threshold + 1e-9) continue;
        g.departed = true;
        for (const b of this.src) if (b.f1 <= g.f1 + 1e-9 && b.f0 >= g.f0 - 1e-9) b.departed = true;
        for (const b of this.src) if (b.f0 < g.f1 && b.f1 > g.f0 && b.f1 <= g.f1 + 1e-6) b.departed = true;
        if (this.reduced) continue;
        const x0 = L.stripX + ((g.f0 + g.f1) / 2) * L.stripW;
        const y0 = L.srcY + L.stripH / 2;
        const x1 = ch.x + ch.w / 2 + (Math.random() - 0.5) * 60;
        const y1 = ch.y + 6;
        this.packets.push({
          color: ROLE_COLOR[g.role],
          x0,
          y0,
          cx: x0 + (x1 - x0) * 0.15,
          cy: (y0 + y1) / 2 + 20,
          x1,
          y1,
          t0: tnow,
          dur: 620 + Math.random() * 260,
          w0: Math.min(14, Math.max(4, (g.f1 - g.f0) * L.stripW)),
        });
      }
    } else {
      this.intakeStart = 0;
    }

    // 2. Intermediate files between hops (real size from hop-done).
    s.hops.forEach((h, i) => {
      if (i === s.hops.length - 1 || h.status !== 'done' || this.hopPacketSent.has(i)) return;
      this.hopPacketSent.add(i);
      if (this.reduced) return;
      const x0 = ch.x + ch.w / 2;
      const y0 = ch.y + ch.h - 4;
      this.packets.push({
        color: ACCENT,
        x0,
        y0,
        cx: ch.x + ch.w + 40,
        cy: ch.y + ch.h / 2,
        x1: x0 + 30,
        y1: ch.y + 6,
        t0: tnow,
        dur: 900,
        w0: 10,
        label: `${formatInfo(h.to).label} ${fmtBytes(h.outSize ?? 0)}`,
      });
    });

    // 3. Bytes out of the last engine into the output strip while it writes.
    const final = s.hops[s.hops.length - 1];
    const writing = final?.stages.find((x) => x.status === 'active' && (x.id === 'encode' || x.id === 'package'));
    if (writing && !this.reduced && tnow - this.lastOutPacket > (writing.progress !== null ? 60 : 140)) {
      this.lastOutPacket = tnow;
      const at = writing.progress !== null ? this.shownFill : Math.random();
      const part = this.out.find((b) => at >= b.f0 && at <= b.f1) ?? this.out[0];
      if (part) {
        const x0 = ch.x + ch.w / 2 + (Math.random() - 0.5) * 50;
        const y0 = ch.y + ch.h - 6;
        const x1 = L.stripX + at * L.stripW;
        const y1 = L.outY + L.stripH / 2;
        this.packets.push({ color: ROLE_COLOR[part.role], x0, y0, cx: x1, cy: (y0 + y1) / 2 - 10, x1, y1, t0: tnow, dur: 560, w0: 6 });
      }
    }

    // Draw.
    c.save();
    c.globalCompositeOperation = 'lighter';
    const alive: Packet[] = [];
    for (const p of this.packets) {
      const u = (tnow - p.t0) / p.dur;
      if (u >= 1) continue;
      alive.push(p);
      const e = easeInOut(Math.max(0, u));
      const inv = 1 - e;
      const x = inv * inv * p.x0 + 2 * inv * e * p.cx + e * e * p.x1;
      const y = inv * inv * p.y0 + 2 * inv * e * p.cy + e * e * p.y1;
      const w = p.w0 * (1 - 0.6 * e);
      const a = u < 0.1 ? u / 0.1 : u > 0.85 ? (1 - u) / 0.15 : 1;
      const glow = this.glow(p.color);
      c.globalAlpha = 0.55 * a;
      c.drawImage(glow, x - 12, y - 12, 24, 24);
      c.globalAlpha = a;
      c.fillStyle = p.color;
      c.fillRect(x - w / 2, y - 2.5, w, 5);
      if (p.label) {
        c.globalCompositeOperation = 'source-over';
        c.font = `500 10px ${MONO}`;
        c.fillStyle = ACCENT;
        c.fillText(p.label, x + 10, y + 4);
        c.globalCompositeOperation = 'lighter';
      }
    }
    c.restore();
    this.packets = alive;
    void dt;
  }

  private glow(color: string): HTMLCanvasElement {
    let g = this.glows.get(color);
    if (!g) {
      g = document.createElement('canvas');
      g.width = g.height = 48;
      const x = g.getContext('2d')!;
      const grad = x.createRadialGradient(24, 24, 0, 24, 24, 24);
      grad.addColorStop(0, rgba(color, 0.9));
      grad.addColorStop(1, rgba(color, 0));
      x.fillStyle = grad;
      x.fillRect(0, 0, 48, 48);
      this.glows.set(color, g);
    }
    return g;
  }

  /* ------------------------------------------------------------ hit test */

  hitTest(px: number, py: number): HitResult | null {
    const s = this.state;
    if (!s) return null;
    const L = this.L;
    const pick = (blocks: Block[], y: number, side: 'input' | 'output', size: number): HitResult | null => {
      if (py < y - 4 || py > y + L.stripH + 4) return null;
      let best: Block | null = null;
      for (const b of blocks) {
        if (px >= b.x - 2 && px <= b.x + Math.max(b.w, 1) + 2) {
          if (!best || b.w < best.w) best = b;
        }
      }
      return best
        ? { side, name: best.name, role: best.role, segment: best.seg, x: px, y: y, fileSize: size, f0: best.f0, f1: best.f1 }
        : null;
    };
    return (
      pick(this.src, L.srcY, 'input', s.input.size) ??
      (this.outStructure ? pick(this.out, L.outY, 'output', s.output?.size ?? 0) : null)
    );
  }
}

/* ------------------------------------------------------------ helpers */

function rgbaCanvas(rgbaData: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const x = cv.getContext('2d')!;
  const img = x.createImageData(w, h);
  img.data.set(rgbaData.subarray(0, w * h * 4));
  x.putImageData(img, 0, 0);
  return cv;
}

const measureCache = new Map<string, number>();
function measure(c: CanvasRenderingContext2D, text: string): number {
  const key = c.font + '|' + text;
  let v = measureCache.get(key);
  if (v === undefined) {
    v = c.measureText(text).width;
    if (measureCache.size > 4000) measureCache.clear();
    measureCache.set(key, v);
  }
  return v;
}

function ellipsize(c: CanvasRenderingContext2D, text: string, max: number): string {
  if (measure(c, text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(c, text.slice(0, mid) + '…') <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function calloutPriority(role: SegmentRole): number {
  switch (role) {
    case 'signature':
    case 'header':
      return 5;
    case 'metadata':
    case 'palette':
      return 4;
    case 'index':
    case 'trailer':
      return 3;
    case 'style':
    case 'media':
      return 2;
    default:
      return 1;
  }
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);

export function describeFacts(f: NonNullable<HopView['facts']>): string {
  switch (f.kind) {
    case 'raster':
      return `${f.width}×${f.height} px${f.frames && f.frames > 1 ? ` · ${f.frames} frames` : ''}${f.channels ? ` · ${f.channels === 4 ? 'RGBA' : f.channels === 3 ? 'RGB' : f.channels === 1 ? 'grey' : `${f.channels} ch`}` : ''}${f.depth ? ` ${f.depth}-bit` : ''}`;
    case 'pages':
      return `${f.pages} page${f.pages === 1 ? '' : 's'}${f.width && f.height ? ` · ${Math.round(f.width)}×${Math.round(f.height)} pt` : ''}`;
    case 'document':
      return [`${f.blocks} blocks`, f.headings ? `${f.headings} headings` : '', f.tables ? `${f.tables} tables` : '', f.images ? `${f.images} images` : '', f.words ? `${f.words.toLocaleString()} words` : '']
        .filter(Boolean)
        .join(' · ');
    case 'table':
      return `${f.rows.toLocaleString()} rows × ${f.cols} cols${f.sheets > 1 ? ` · ${f.sheets} sheets` : ''}`;
    case 'tree':
      return `${f.nodes.toLocaleString()} nodes · depth ${f.depth}`;
    case 'audio':
      return `${fmtDuration(f.durationS)} · ${(f.sampleRate / 1000).toFixed(1)} kHz · ${f.channels === 1 ? 'mono' : f.channels === 2 ? 'stereo' : `${f.channels} ch`}${f.codec ? ` · ${f.codec}` : ''}`;
    case 'video':
      return `${f.width}×${f.height}${f.fps ? ` · ${Math.round(f.fps * 100) / 100} fps` : ''} · ${fmtDuration(f.durationS)}${f.videoCodec ? ` · ${f.videoCodec}` : ''}${f.audioCodec ? ` + ${f.audioCodec}` : ''}`;
    case 'text':
      return `${f.chars.toLocaleString()} chars · ${f.lines.toLocaleString()} lines`;
  }
}

function bigFact(f: NonNullable<HopView['facts']>): string {
  switch (f.kind) {
    case 'raster':
      return `${f.width} × ${f.height}`;
    case 'pages':
      return `${f.pages} page${f.pages === 1 ? '' : 's'}`;
    case 'document':
      return `${f.blocks} blocks`;
    case 'table':
      return `${f.rows.toLocaleString()} × ${f.cols}`;
    case 'tree':
      return `${f.nodes.toLocaleString()} nodes`;
    case 'audio':
      return fmtDuration(f.durationS);
    case 'video':
      return `${f.width} × ${f.height}`;
    case 'text':
      return `${f.lines.toLocaleString()} lines`;
  }
}
