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
 * Fluidity: one rAF loop that sleeps while nothing moves (frame() reports
 * whether another frame is needed), time-based exponential smoothing for
 * every moving value (frame-rate independent), cached background and glow
 * sprites, no allocations in the hot path beyond packets.
 */
import type { FileStructure, Segment, SegmentRole } from '../core/structure/types';
import { LIMITS, fmtChannels } from '../core/structure/util';
import { formatInfo } from '../core/formats';
import { engineName } from '../core/engineNames';
import { now } from '../core/clock';
import type { Facts, Preview, StageId } from '../core/types';
import { activeStage, runningStage, type VizState, type HopView, type StageView } from './model';
import { ghostFor } from './templates';
import { ROLE_LABEL, currentTheme, rgba, type Theme } from './palette';

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
  /** Share of the file (not of the block) already handed to the engine by departed packet groups. */
  read: number;
}

interface Packet {
  color: string;
  /** Outline drawn around the packet on light themes. */
  outline: string;
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type PreviewOf<K extends Preview['kind']> = Extract<Preview, { kind: K }>;

interface Layout {
  pad: number;
  srcTitleY: number;
  srcCalloutY: number;
  srcY: number;
  stripH: number;
  chamber: Box;
  outY: number;
  outCalloutY: number;
  outTitleY: number;
  stripX: number;
  stripW: number;
  compact: boolean;
}

const MAX_PACKET_GROUPS = 120;
/** Smoothed values closer than this to their target (px, or alpha) count as settled. */
const SETTLED = 0.005;

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

/**
 * A container that spans most of the file (EBML Segment, RIFF, a big moov)
 * says little on its own, so it is drawn as its real children instead, with
 * any bytes the children don't cover kept as the container itself.
 */
function displaySegments(segs: Segment[], size: number, depth = 0): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const kids = s.children?.filter((k) => k.length > 0) ?? [];
    if (depth < 2 && s.role === 'container' && kids.length > 1 && s.length / size > 0.2) {
      const inner = displaySegments([...kids].sort((a, b) => a.offset - b.offset), size, depth + 1);
      let cur = s.offset;
      for (const k of inner) {
        if (k.offset > cur) out.push({ name: s.name, role: 'container', offset: cur, length: k.offset - cur });
        out.push(k);
        cur = Math.max(cur, k.offset + k.length);
      }
      if (cur < s.offset + s.length) out.push({ name: s.name, role: 'container', offset: cur, length: s.offset + s.length - cur });
    } else out.push(s);
  }
  return out;
}

function blocksFrom(structure: FileStructure): Block[] {
  const size = Math.max(1, structure.size);
  const segs = displaySegments([...structure.segments].sort((a, b) => a.offset - b.offset), size);
  const out: Block[] = [];
  let cursor = 0;
  for (const s of segs) {
    if (s.offset > cursor) {
      out.push({ name: 'unparsed', role: 'unknown', f0: cursor / size, f1: s.offset / size, x: 0, w: 0, alpha: 1, read: 0 });
    }
    const start = Math.max(cursor, s.offset);
    const end = Math.min(size, s.offset + s.length);
    if (end > start) out.push({ name: s.name, role: s.role, f0: start / size, f1: end / size, x: 0, w: 0, alpha: 1, read: 0, seg: s });
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
      read: 0,
    });
  }
  return out;
}

/** Why only part of the file is drawn, as a short aside after the part count ('' when all of it is). */
export function truncationNote(st: FileStructure): string {
  if (!st.truncated) return '';
  switch (st.truncatedBy) {
    case 'budget':
      return ` (only the first ${Math.round(LIMITS.budget / 1024 / 1024)} MB were read)`;
    case 'segments':
      return ' (too many to list them all)';
    case 'error':
      return ' (the rest couldn’t be read)';
    default:
      return ' (not all of it was read)';
  }
}

const PAYLOAD: ReadonlySet<SegmentRole> = new Set(['pixels', 'samples', 'text', 'records', 'media']);
/** Stages that take in the source bytes. */
const INTAKE: ReadonlySet<StageId> = new Set(['read', 'decode', 'transform']);

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
  private payloadReleaseAt = 0;
  /** Animated pixel lengths of the two strips, on one shared byte scale. */
  private srcLen = 0;
  private outLen = 0;
  private previewCanvas: HTMLCanvasElement | null = null;
  /** The latest decoded preview and facts across hops, picked once per state change. */
  private preview: Preview | null = null;
  private facts: Facts | null = null;
  private factLine = '';
  private previewShownAt = 0;
  private framesCanvases: HTMLCanvasElement[] = [];
  /** Ellipsized grid/outline text for the current preview, box and theme. */
  private fitted: { preview: Preview; w: number; h: number; th: Theme; rows: string[][] } | null = null;
  /** Thin-segment label candidates per strip, most interesting first. */
  private calloutOrder = new WeakMap<Block[], Block[]>();
  private hopPacketSent = new Set<number>();
  private t = 0;
  /** Set during a frame by anything that still moves, so the host knows to draw another. */
  private busy = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private reduced: boolean,
    /** Called when the picture changes, so a sleeping host loop can wake up. */
    private onDirty: () => void = () => {},
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  private th: Theme = currentTheme();

  setTheme(th: Theme) {
    if (th === this.th) return;
    this.th = th;
    this.bg = null;
    this.glows.clear();
    this.onDirty();
  }

  setReducedMotion(r: boolean) {
    this.reduced = r;
    this.onDirty();
  }

  /**
   * Both strips use the same bytes-per-pixel scale, so their lengths compare
   * exactly: an output half the size of the input is drawn half as long.
   * Until the output exists its size is unknown, so the input sets the scale
   * and the output placeholder uses the same length.
   */
  private lengthTargets(): { src: number; out: number } {
    const W = this.L.stripW;
    const s = this.state;
    if (!s) return { src: W, out: W };
    const outSize = s.output?.structure ? s.output.size : null;
    const max = Math.max(1, s.input.size, outSize ?? 0);
    return { src: (W * s.input.size) / max, out: outSize === null ? (W * s.input.size) / max : (W * outSize) / max };
  }

  /** Snap a block to its byte range on a strip `len` px long. */
  private place(b: Block, len: number) {
    b.x = this.L.stripX + b.f0 * len;
    b.w = (b.f1 - b.f0) * len;
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
    // Snap strips and blocks to the new geometry.
    const len = this.lengthTargets();
    this.srcLen = len.src;
    this.outLen = len.out;
    for (const b of this.src) this.place(b, this.srcLen);
    for (const b of this.out) this.place(b, this.outLen);
    this.onDirty();
  }

  setState(s: VizState | null) {
    const prev = this.state;
    this.state = s;
    this.onDirty();
    if (!s) {
      this.reset();
      return;
    }
    if (s.input.structure && s.input.structure !== this.srcStructure) {
      this.srcStructure = s.input.structure;
      this.src = blocksFrom(s.input.structure);
      this.srcLen = this.lengthTargets().src;
      for (const b of this.src) {
        this.place(b, this.srcLen);
        if (!this.reduced) {
          // Segments grow in from their start.
          b.w = 0;
          b.alpha = 0;
        }
      }
      this.groups = packetGroups(this.src).map((g) => ({ ...g, departed: false }));
    }
    // New run on the same input: un-read the source.
    if (prev && prev.startedAt !== s.startedAt) this.resetRun();
    const ghostKey = `${s.route.to}:${s.startedAt}`;
    if (this.outGhostKey !== ghostKey && s.hops.length) {
      this.outGhostKey = ghostKey;
      const parts = ghostFor(s.route.to);
      const total = parts.reduce((a, p) => a + p.weight, 0);
      const len = this.lengthTargets().out;
      let acc = 0;
      this.out = parts.map((p) => {
        const f0 = acc / total;
        acc += p.weight;
        const b: Block = { name: p.name, role: p.role, f0, f1: acc / total, x: 0, w: 0, alpha: 0, read: 0 };
        this.place(b, len);
        return b;
      });
      this.outStructure = null;
    }
    if (s.output?.structure && s.output.structure !== this.outStructure) {
      this.outStructure = s.output.structure;
      const real = blocksFrom(s.output.structure);
      const len = this.lengthTargets().out;
      // Start each real block where the ghost of the same role was, so the
      // expected layout visibly resolves into the true one.
      for (const b of real) {
        if (this.reduced) {
          this.place(b, len);
          continue;
        }
        const ghost = this.out.find((o) => o.role === b.role) ?? this.out[this.out.length - 1];
        b.x = ghost?.x ?? this.L.stripX;
        b.w = ghost?.w ?? 0;
      }
      this.out = real;
    }
    const preview = s.hops.findLast((h) => h.preview)?.preview ?? null;
    if (preview !== this.preview) {
      this.preview = preview;
      this.previewCanvas = null;
      this.framesCanvases = [];
      this.fitted = null;
      this.previewShownAt = performance.now();
      if (preview?.kind === 'pixels') this.previewCanvas = rgbaCanvas(preview.rgba, preview.width, preview.height);
      if (preview?.kind === 'frames')
        this.framesCanvases = preview.frames.map((f) => rgbaCanvas(f, preview.width, preview.height));
    }
    const facts = s.hops.findLast((h) => h.facts)?.facts ?? null;
    if (facts !== this.facts) {
      this.facts = facts;
      this.factLine = facts ? describeFacts(facts) : '';
    }
  }

  /** Forget a run: what was read from the source, packets in flight, the output and its fill. */
  private resetRun() {
    for (const g of this.groups) g.departed = false;
    for (const b of this.src) {
      b.departed = false;
      b.read = 0;
    }
    this.packets = [];
    this.hopPacketSent.clear();
    this.out = [];
    this.outStructure = null;
    this.outGhostKey = '';
    this.shownFill = 0;
  }

  private reset() {
    this.resetRun();
    this.src = [];
    this.srcStructure = null;
    this.groups = [];
    this.shownProgress = 0;
    this.previewCanvas = null;
    this.preview = null;
    this.framesCanvases = [];
    this.fitted = null;
    this.facts = null;
    this.factLine = '';
  }

  /* ------------------------------------------------------------ frame */

  /** Draw one frame. Returns whether anything is still moving; when not, the host may stop until onDirty. */
  frame(dtMs: number): boolean {
    const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
    this.t += dt;
    this.busy = false;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground();
    const s = this.state;
    this.updateBlocks(dt);
    this.drawSource();
    this.drawChamber(dt);
    this.drawOutput(dt);
    if (s) {
      const tnow = performance.now();
      this.spawnIntake(s, tnow);
      this.spawnHandoffs(s, tnow);
      this.spawnWrites(s, tnow);
      this.drawPackets(tnow);
    }
    return this.busy;
  }

  /** approach(), flagging the frame busy until the value has settled. */
  private ease(cur: number, target: number, dt: number, k: number, eps = SETTLED): number {
    const v = approach(cur, target, dt, k);
    if (Math.abs(target - v) > eps) this.busy = true;
    return v;
  }

  private drawBackground() {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    if (!this.bg) {
      // The page behind the canvas is the sky / aurora; the canvas only adds
      // the engine chamber as a pane of glass, cached once per size and theme.
      const bg = document.createElement('canvas');
      bg.width = this.canvas.width;
      bg.height = this.canvas.height;
      const b = bg.getContext('2d')!;
      b.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const ch = this.L.chamber;
      const r = 22;
      if (this.th.name === 'light') {
        b.shadowColor = 'rgba(40,90,180,0.16)';
        b.shadowBlur = 40;
        b.shadowOffsetY = 18;
      }
      b.fillStyle = this.th.panelFill;
      roundRect(b, ch.x, ch.y, ch.w, ch.h, r);
      b.fill();
      b.shadowColor = 'transparent';
      b.strokeStyle = this.th.panelStroke;
      b.lineWidth = 1;
      roundRect(b, ch.x + 0.5, ch.y + 0.5, ch.w - 1, ch.h - 1, r);
      b.stroke();
      // Intake and outlet: soft lights where bytes enter and leave.
      for (const y of [ch.y, ch.y + ch.h]) {
        const g = b.createRadialGradient(ch.x + ch.w / 2, y, 0, ch.x + ch.w / 2, y, 70);
        g.addColorStop(0, rgba(this.th.accent, this.th.name === 'light' ? 0.18 : 0.22));
        g.addColorStop(1, rgba(this.th.accent, 0));
        b.fillStyle = g;
        b.fillRect(ch.x + ch.w / 2 - 70, y - 70, 140, 140);
      }
      this.bg = bg;
    }
    c.drawImage(this.bg, 0, 0, this.w, this.h);
  }

  private updateBlocks(dt: number) {
    const k = this.reduced ? 40 : 9;
    const len = this.lengthTargets();
    this.srcLen = this.ease(this.srcLen, len.src, dt, this.reduced ? 40 : 4);
    this.outLen = this.ease(this.outLen, len.out, dt, this.reduced ? 40 : 4);
    const x0 = this.L.stripX;
    for (const b of this.src) {
      b.x = this.ease(b.x, x0 + b.f0 * this.srcLen, dt, k);
      b.w = this.ease(b.w, (b.f1 - b.f0) * this.srcLen, dt, k * 0.8);
      b.alpha = this.ease(b.alpha, 1, dt, 6, SETTLED / 2);
    }
    for (const b of this.out) {
      b.x = this.ease(b.x, x0 + b.f0 * this.outLen, dt, k);
      b.w = this.ease(b.w, (b.f1 - b.f0) * this.outLen, dt, k);
      b.alpha = this.ease(b.alpha, 1, dt, 5, SETTLED / 2);
    }
  }

  /* ------------------------------------------------------------ strips */

  /**
   * `fill` (measured output progress) is only given with `ghost`; `consumed`
   * dims what the source has already handed to the engine.
   */
  private drawStrip(blocks: Block[], y: number, opts: { len: number; fill?: number; ghost?: boolean; consumed?: boolean }) {
    const c = this.ctx;
    const { stripX, stripH } = this.L;
    const stripW = opts.len;
    c.fillStyle = this.th.track;
    c.fillRect(stripX, y, stripW, stripH);
    for (const b of blocks) {
      if (b.w <= 0.01) continue;
      const color = this.th.role[b.role];
      const w = Math.max(0.75, b.w);
      if (opts.ghost) {
        c.strokeStyle = rgba(color, 0.55 * b.alpha);
        c.setLineDash([3, 3]);
        c.strokeRect(b.x + 0.5, y + 0.5, Math.max(0, w - 1), stripH - 1);
        c.setLineDash([]);
        continue;
      }
      const dim = opts.consumed && b.departed;
      // Part of a large segment already consumed by a streaming engine.
      const rf = !dim && opts.consumed ? readFraction(b) : 0;
      const full = (b.name === 'not inspected' ? 0.18 : 0.92) * b.alpha;
      if (dim) {
        c.fillStyle = rgba(color, 0.22 * b.alpha);
        c.fillRect(b.x, y, w, stripH);
      } else if (rf > 0) {
        c.fillStyle = rgba(color, 0.22 * b.alpha);
        c.fillRect(b.x, y, w * rf, stripH);
        c.fillStyle = rgba(color, full);
        c.fillRect(b.x + w * rf, y, w * (1 - rf), stripH);
      } else {
        c.fillStyle = rgba(color, full);
        c.fillRect(b.x, y, w, stripH);
      }
      if (dim) {
        c.strokeStyle = rgba(color, 0.5 * b.alpha);
        c.strokeRect(b.x + 0.5, y + 0.5, Math.max(0, w - 1), stripH - 1);
      }
    }
    // Fill overlay for the output being written (measured only).
    if (opts.fill !== undefined) {
      const fw = stripW * opts.fill;
      c.save();
      c.beginPath();
      c.rect(stripX, y, fw, stripH);
      c.clip();
      for (const b of blocks) {
        c.fillStyle = rgba(this.th.role[b.role], 0.85);
        c.fillRect(b.x, y, Math.max(0.75, b.w), stripH);
      }
      c.restore();
    }
    // Segment separators + inline labels where they fit.
    c.font = this.th.mono(this.L.compact ? 9 : 10, 500);
    c.textBaseline = 'middle';
    for (const b of blocks) {
      if (b.w > 3) {
        c.fillStyle = this.th.name === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(8,8,14,0.55)';
        c.fillRect(b.x + b.w - 0.5, y, 1, stripH);
      }
      // A label needs its own width plus 12 px, so thinner blocks never get one.
      if (b.w <= 12) continue;
      const label = b.seg?.count && b.seg.count > 1 ? `${b.name} ×${b.seg.count.toLocaleString()}` : b.name;
      const tw = measure(c, label);
      if (b.w > tw + 12) {
        const read = opts.consumed && (b.departed || readFraction(b) > 0.02);
        const underFill = opts.fill !== undefined && b.x + 6 + tw <= stripX + stripW * opts.fill;
        c.fillStyle = underFill
          ? this.th.onSegment
          : opts.ghost || read
            ? rgba(this.labelColor(b.role), read ? 0.7 : 0.8)
            : this.th.onSegment;
        c.fillText(label, b.x + 6, y + stripH / 2 + 0.5);
      }
    }
  }

  /** Names for segments too thin to label inline, lifted above/below the strip with leader lines. */
  private drawCallouts(blocks: Block[], stripY: number, labelY: number, above: boolean) {
    const c = this.ctx;
    const { stripH } = this.L;
    c.font = this.th.mono(this.L.compact ? 9 : 10, 500);
    c.textBaseline = 'middle';
    // Pick the most structurally interesting thin segments. Labels in the left
    // half are packed left-to-right, labels in the right half right-to-left, so
    // clusters at either end of a file stay next to their segments.
    const max = this.L.compact ? 5 : 10;
    let order = this.calloutOrder.get(blocks);
    if (!order) {
      order = blocks.filter((b) => b.name !== 'unparsed').sort((a, b) => calloutPriority(b.role) - calloutPriority(a.role) || a.f0 - b.f0);
      this.calloutOrder.set(blocks, order);
    }
    const picked: Block[] = [];
    for (const b of order) {
      if (b.w > 0 && measure(c, b.name) + 12 >= b.w && picked.push(b) >= max) break;
    }
    picked.sort((a, b) => a.f0 - b.f0);
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
      const color = this.th.role[b.role];
      c.strokeStyle = rgba(color, 0.45 * b.alpha);
      c.beginPath();
      const y0 = above ? stripY : stripY + stripH;
      const y1 = above ? labelY + 7 : labelY - 7;
      c.moveTo(cx + 0.5, y0);
      c.lineTo(cx + 0.5, (y0 + y1) / 2);
      c.lineTo(lx + tw / 2 + 0.5, y1);
      c.stroke();
      c.fillStyle = rgba(this.labelColor(b.role), 0.95 * b.alpha);
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
    c.fillStyle = this.th.muted;
    c.font = this.th.mono(L.compact ? 9 : 10, 500);
    c.fillText('ORIGINAL', L.pad, L.srcTitleY - (L.compact ? 0 : 1));
    const labelW = measure(c, 'ORIGINAL') + 12;
    c.fillStyle = this.th.ink;
    c.font = this.th.title(L.compact ? 17 : 21);
    const nameMax = L.stripW - labelW - 200;
    c.fillText(ellipsize(c, s.input.name, Math.max(80, nameMax)), L.pad + labelW, L.srcTitleY);
    c.font = this.th.mono(L.compact ? 9 : 10, 500);
    c.fillStyle = this.th.muted;
    const meta = `${info.label} · ${fmtBytes(s.input.size)}`;
    c.textAlign = 'right';
    c.fillText(meta, L.pad + L.stripW, L.srcTitleY);
    c.textAlign = 'left';

    if (!this.src.length) {
      // Structure still being parsed.
      c.fillStyle = this.th.track;
      c.fillRect(L.stripX, L.srcY, L.stripW, L.stripH);
      if (!this.reduced) {
        this.busy = true;
        const x = L.stripX + ((this.t * 0.45) % 1) * L.stripW;
        const grad = c.createLinearGradient(x - 120, 0, x, 0);
        grad.addColorStop(0, rgba(this.th.ink, 0));
        grad.addColorStop(1, rgba(this.th.ink, 0.08));
        c.fillStyle = grad;
        c.fillRect(Math.max(L.stripX, x - 120), L.srcY, Math.min(120, x - L.stripX), L.stripH);
      }
      c.fillStyle = this.th.muted;
      c.font = this.th.mono(10, 500);
      c.textBaseline = 'middle';
      c.fillText('reading structure…', L.stripX + 8, L.srcY + L.stripH / 2);
      return;
    }
    this.drawStrip(this.src, L.srcY, { len: this.srcLen, consumed: true });
    this.drawCallouts(this.src, L.srcY, L.srcCalloutY, true);
  }

  private drawOutput(dt: number) {
    const s = this.state;
    const c = this.ctx;
    const L = this.L;
    if (!s || !this.out.length) return;
    const final = s.hops[s.hops.length - 1];
    const writing = final ? writingStage(final) : undefined;
    const finalDone = final?.status === 'done';
    const measured = writing && writing.progress !== null ? writing.progress : null;
    const ghost = !this.outStructure;
    const targetFill = finalDone ? 1 : measured ?? this.shownFill;
    this.shownFill = approach(this.shownFill, targetFill, dt, this.reduced ? 40 : 7);
    // The fill is only drawn over the ghost, so only there does it need to settle.
    if (ghost && Math.abs(targetFill - this.shownFill) * this.outLen > SETTLED) this.busy = true;

    c.textBaseline = 'alphabetic';
    // Title row.
    c.fillStyle = this.th.muted;
    c.font = this.th.mono(L.compact ? 9 : 10, 500);
    c.fillText('CONVERTED', L.pad, L.outTitleY);
    const labelW = measure(c, 'CONVERTED') + 12;
    // The produced format once known: a bundle is a ZIP whatever the target was.
    const info = formatInfo(s.output?.format ?? s.route.to);
    c.fillStyle = s.output ? this.th.ink : this.th.muted;
    c.font = this.th.title(L.compact ? 17 : 21);
    const outName = s.output?.name ?? `New ${info.label} file`;
    c.fillText(ellipsize(c, outName, Math.max(80, L.stripW - labelW - 220)), L.pad + labelW, L.outTitleY);
    c.font = this.th.mono(L.compact ? 9 : 10, 500);
    c.textAlign = 'right';
    c.fillStyle = this.th.muted;
    if (s.output) {
      c.fillText(`${info.label} · ${fmtBytes(s.output.size)}`, L.pad + L.stripW, L.outTitleY);
    } else if (ghost) {
      c.fillText('usual layout · real size shown when finished', L.pad + L.stripW, L.outTitleY);
    }
    c.textAlign = 'left';

    this.drawStrip(this.out, L.outY, { len: this.outLen, ghost, fill: ghost ? this.shownFill : undefined });
    this.drawScaleGuide(ghost);
    // Indeterminate writing: shimmer across the ghost, never a fill.
    if (ghost && writing && measured === null && !this.reduced) {
      const x = L.stripX + ((this.t * 0.6) % 1.3) * this.outLen;
      const grad = c.createLinearGradient(x - 160, 0, x, 0);
      grad.addColorStop(0, rgba(this.th.accent, 0));
      grad.addColorStop(1, rgba(this.th.accent, 0.22));
      c.fillStyle = grad;
      c.fillRect(Math.max(L.stripX, x - 160), L.outY, Math.max(0, Math.min(160, x - L.stripX, L.stripX + this.outLen - (x - 160))), L.stripH);
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
      c.font = this.th.title(L.compact ? 24 : 32);
      c.fillStyle = this.th.ink;
      c.fillText(this.srcStructure ? 'What’s inside' : 'Reading the file…', x0, ch.y + (L.compact ? 50 : 60));
      c.font = this.th.mono(L.compact ? 10 : 11, 500);
      c.fillStyle = this.th.muted;
      const summary = this.srcStructure?.summary ?? '';
      c.fillText(ellipsize(c, summary, ch.w - 40), x0, ch.y + (L.compact ? 72 : 84));
      if (this.srcStructure) {
        c.fillText(
          `${this.srcStructure.segments.length.toLocaleString()} parts${truncationNote(this.srcStructure)}. Pick a format below.`,
          x0,
          ch.y + (L.compact ? 90 : 104),
        );
        this.drawLegend(x0, ch.y + ch.h - 26, L.compact ? ch.w - 40 : ch.w * 0.5 - 40);
        if (!L.compact) this.drawManifest(this.srcStructure, ch.x + ch.w * 0.5, ch.y + 22, ch.w * 0.5 - 20, ch.h - 44);
      }
      // Output strip placeholder keeps the layout stable before a target is chosen.
      c.strokeStyle = rgba(this.th.ink, 0.08);
      c.setLineDash([4, 4]);
      c.strokeRect(L.stripX + 0.5, L.outY + 0.5, L.stripW - 1, L.stripH - 1);
      c.setLineDash([]);
      c.font = this.th.mono(10, 500);
      c.fillStyle = this.th.faint;
      c.textBaseline = 'middle';
      c.fillText('the converted file will appear here', L.stripX + 10, L.outY + L.stripH / 2);
      c.textBaseline = 'alphabetic';
      return;
    }
    // Elapsed time, meters, shimmer and the engine core move for as long as the run does.
    if (s.phase === 'running') this.busy = true;
    const active = activeStage(s)?.stage;
    const t = now();
    const inner = { x: ch.x + 20, y: ch.y + 16, w: ch.w - 40, h: ch.h - 32 };

    // Header: hop chips.
    c.textBaseline = 'alphabetic';
    let x = inner.x;
    c.font = this.th.mono(L.compact ? 9 : 10, 500);
    s.hops.forEach((h, i) => {
      const label = `${s.hops.length > 1 ? `${i + 1} · ` : ''}${engineName(h.engine)}  ${formatInfo(h.from).label}→${formatInfo(h.to).label}`;
      const tw = measure(c, label);
      const isActive = i === s.activeHop && s.phase === 'running';
      c.fillStyle = h.status === 'done' ? rgba(this.th.accent, 0.12) : isActive ? rgba(this.th.accent, 0.2) : rgba(this.th.ink, 0.05);
      roundRect(c, x, inner.y, tw + 20, 20, 10);
      c.fill();
      c.fillStyle = h.status === 'failed' ? this.th.danger : isActive || h.status === 'done' ? this.th.accent : this.th.muted;
      c.fillText(label, x + 10, inner.y + 14);
      x += tw + 28;
    });

    // Title + stage line.
    const titleY = inner.y + (L.compact ? 50 : 58);
    c.font = this.th.title(L.compact ? 24 : 32);
    c.fillStyle = this.th.ink;
    let title = 'Converting';
    let sub = '';
    if (s.phase === 'done') {
      title = 'Done';
      sub = `Took ${fmtMs((s.endedAt ?? t) - s.startedAt)} on your computer.`;
    } else if (s.phase === 'error') {
      title = 'Something went wrong';
      sub = s.error ?? '';
    } else if (s.phase === 'cancelled') {
      title = 'Stopped';
      sub = 'The conversion was stopped and its memory freed.';
    } else if (active) {
      sub = active.label;
    } else {
      sub = 'Starting…';
    }
    c.fillText(title, inner.x, titleY);
    c.font = this.th.mono(L.compact ? 10 : 11, 500);
    c.fillStyle = s.phase === 'error' ? this.th.danger : this.th.muted;
    c.fillText(ellipsize(c, sub, inner.w * (L.compact ? 1 : 0.5)), inner.x, titleY + 22);

    // Fallback notice. Engines fall back for many reasons (missing codec, unsupported input), so no reason is guessed.
    if (hop.fallbacks.length && s.phase === 'running') {
      c.fillStyle = rgba(this.th.notice, 0.9);
      c.fillText(ellipsize(c, `Switched to ${engineName(hop.engine)} for this file.`, inner.w * 0.5), inner.x, titleY + 40);
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
    if (ir.h > 40) this.drawRepresentation(s, ir);
  }

  /**
   * When the real output exists, a dashed guide drops from the end of the
   * input to the output row, and the output end is labelled with its exact
   * size relative to the original.
   */
  private drawScaleGuide(ghost: boolean) {
    const s = this.state;
    if (!s?.output || ghost) return;
    const c = this.ctx;
    const L = this.L;
    const inEnd = L.stripX + this.srcLen;
    const outEnd = L.stripX + this.outLen;
    c.save();
    c.strokeStyle = rgba(this.th.ink, 0.28);
    c.setLineDash([3, 4]);
    // Only in the gaps above and below the engine panel, never across it.
    const gx = Math.round(inEnd) + 0.5;
    c.beginPath();
    c.moveTo(gx, L.srcY + L.stripH + 2);
    c.lineTo(gx, L.chamber.y - 6);
    c.moveTo(gx, L.chamber.y + L.chamber.h + 6);
    c.lineTo(gx, L.outY - 2);
    c.stroke();
    c.restore();
    const ratio = s.output.size / Math.max(1, s.input.size);
    const label =
      ratio < 0.995 ? `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}% of the original` : ratio > 1.005 ? `${ratio.toFixed(ratio < 10 ? 2 : 0)}× the original` : 'same size as the original';
    c.font = this.th.mono(11, 500);
    c.textBaseline = 'middle';
    const tw = measure(c, label);
    const fits = outEnd + 10 + tw <= L.stripX + L.stripW;
    const lx = fits ? outEnd + 12 : Math.max(L.stripX + 8, outEnd - tw - 12);
    if (!fits) {
      c.fillStyle = this.th.name === 'light' ? 'rgba(255,255,255,0.88)' : 'rgba(10,10,18,0.78)';
      roundRect(c, lx - 7, L.outY + 4, tw + 14, L.stripH - 8, (L.stripH - 8) / 2);
      c.fill();
    }
    c.fillStyle = this.th.ink;
    c.fillText(label, lx, L.outY + L.stripH / 2 + 0.5);
    c.textBaseline = 'alphabetic';
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
    c.font = this.th.mono(9, 500);
    c.textBaseline = 'alphabetic';
    c.fillStyle = this.th.faint;
    c.fillText('OFFSET', x, y + 10);
    c.fillText('SEGMENT', x + 78, y + 10);
    c.textAlign = 'right';
    c.fillText('BYTES', x + w, y + 10);
    c.textAlign = 'left';
    list.forEach((s, i) => {
      const ry = y + 28 + i * rowH;
      if (!s) {
        c.fillStyle = this.th.faint;
        c.fillText(`⋯ ${(segs.length - rows + 1).toLocaleString()} more`, x + 78, ry);
        return;
      }
      c.fillStyle = this.th.muted;
      c.fillText(`0x${s.offset.toString(16).toUpperCase().padStart(6, '0')}`, x, ry);
      c.fillStyle = this.th.role[s.role];
      c.fillRect(x + 66, ry - 7, 6, 6);
      c.fillStyle = this.th.ink;
      const sizeText = s.length.toLocaleString();
      const sw = measure(c, sizeText);
      const name = `${s.name}${s.count && s.count > 1 ? ` ×${s.count}` : ''}`;
      const nameW = Math.min(measure(c, name), (w - 78 - sw) * 0.5);
      c.fillText(ellipsize(c, name, nameW + 1), x + 78, ry);
      if (s.detail) {
        c.fillStyle = this.th.muted;
        c.fillText(ellipsize(c, s.detail, w - 78 - nameW - sw - 24), x + 78 + nameW + 10, ry);
      }
      c.textAlign = 'right';
      c.fillStyle = this.th.muted;
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
    c.font = this.th.mono(10, 500);
    let cx = x;
    for (const [role, f] of items) {
      const pct = f * 100;
      const label = `${ROLE_LABEL[role]} ${pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%`;
      const tw = measure(c, label) + 22;
      if (cx + tw > x + maxW) break;
      c.fillStyle = this.th.role[role];
      c.fillRect(cx, y - 8, 8, 8);
      c.fillStyle = this.th.muted;
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
    c.font = this.th.mono(10, 500);
    c.textBaseline = 'alphabetic';
    let measured: number | null = st.progress;
    let label: string;
    if (asset && st.id === 'load') {
      measured = asset.total ? asset.loaded / asset.total : null;
      label = asset.total
        ? `Downloading the converter (first time only): ${fmtBytes(asset.loaded)} of ${fmtBytes(asset.total)}`
        : `Downloading the converter (first time only): ${fmtBytes(asset.loaded)}`;
    } else {
      label = measured !== null ? `${Math.floor(this.shownProgress * 100)}%` : `Working… ${fmtMs(t - (st.startedAt ?? t))}`;
    }
    c.fillStyle = this.th.track;
    c.fillRect(x, y, w, 3);
    if (measured !== null) {
      this.shownProgress = approach(this.shownProgress, measured, dt, this.reduced ? 40 : 8);
      const g = c.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, this.th.flow[0]);
      g.addColorStop(0.55, this.th.flow[1]);
      g.addColorStop(1, this.th.flow[2]);
      c.fillStyle = g;
      roundRect(c, x, y - 0.5, Math.max(4, w * this.shownProgress), 4, 2);
      c.fill();
    } else if (!this.reduced) {
      // Indeterminate: a travelling segment, clearly not a fill level.
      const p = (this.t * 0.7) % 1;
      const seg = w * 0.18;
      const sx = x - seg + p * (w + seg);
      c.fillStyle = rgba(this.th.accent, 0.75);
      c.fillRect(Math.max(x, sx), y, Math.max(0, Math.min(seg, x + w - sx, sx + seg - x)), 3);
    }
    c.fillStyle = this.th.muted;
    c.fillText(label, x, y + 18);
  }

  private drawStageTimeline(s: VizState, x: number, y: number, w: number) {
    const c = this.ctx;
    const stages = s.hops.flatMap((h) => h.stages.filter((st) => st.startedAt !== undefined && st.endedAt !== undefined));
    const total = Math.max(1, (s.endedAt ?? 0) - s.startedAt);
    c.font = this.th.mono(10, 500);
    c.textBaseline = 'alphabetic';
    let cx = x;
    const colors = [this.th.accent, this.th.role.pixels, this.th.role.text, this.th.role.metadata, this.th.role.samples, this.th.role.index];
    stages.forEach((st, i) => {
      const sw = Math.max(2, (((st.endedAt ?? 0) - (st.startedAt ?? 0)) / total) * w);
      c.fillStyle = colors[i % colors.length]!;
      c.fillRect(cx, y, Math.min(sw, x + w - cx), 3);
      cx += sw;
    });
    c.fillStyle = this.th.muted;
    const slowest = [...stages].sort((a, b) => (b.endedAt! - b.startedAt!) - (a.endedAt! - a.startedAt!))[0];
    c.fillText(slowest ? `Slowest step: ${slowest.label} (${fmtMs(slowest.endedAt! - slowest.startedAt!)})` : '', x, y + 18);
  }

  /* ------------------------------------------------------------ representation */

  /** The decoded in-between data: a preview when the engine sent one, else its key fact, else the engine core. */
  private drawRepresentation(s: VizState, r: Box) {
    const c = this.ctx;
    c.font = this.th.mono(10, 500);
    c.textBaseline = 'alphabetic';
    const box = { x: r.x, y: r.y, w: r.w, h: r.h - 22 };
    const p = this.preview;
    let caption = this.factLine;
    if (p?.kind === 'pixels' && this.previewCanvas) {
      this.drawPixels(p, this.previewCanvas, box);
      caption = `${this.factLine}${this.facts ? ' · ' : ''}preview from the decoded pixels`;
    } else if (p?.kind === 'frames' && this.framesCanvases.length) this.drawFrames(p, box);
    else if (p?.kind === 'waveform') this.drawWaveform(p, box);
    else if (p?.kind === 'outline') this.drawOutline(p, box);
    else if (p?.kind === 'grid') this.drawGrid(p, box);
    else if (this.facts) this.drawBigFact(this.facts, box);
    else {
      this.drawCore(s, box);
      return;
    }
    c.font = this.th.mono(10, 500);
    c.fillStyle = this.th.muted;
    c.textAlign = 'right';
    c.fillText(caption, box.x + box.w, r.y + r.h - 4);
    c.textAlign = 'left';
  }

  /** How far the current preview has unfolded (0..1, over 650 ms); keeps frames coming until it has. */
  private reveal(): number {
    const v = this.reduced ? 1 : Math.min(1, (performance.now() - this.previewShownAt) / 650);
    if (v < 1) this.busy = true;
    return v;
  }

  /** Ellipsized preview text, recomputed only when the preview, its box or the theme changes. */
  private fit(p: Preview, box: Box, build: () => string[][]): string[][] {
    const f = this.fitted;
    if (f && f.preview === p && f.w === box.w && f.h === box.h && f.th === this.th) return f.rows;
    const rows = build();
    this.fitted = { preview: p, w: box.w, h: box.h, th: this.th, rows };
    return rows;
  }

  private drawPixels(p: PreviewOf<'pixels'>, img: HTMLCanvasElement, box: Box) {
    const c = this.ctx;
    const reveal = this.reveal();
    const scale = Math.min(box.w / p.width, box.h / p.height);
    const dw = p.width * scale;
    const dh = p.height * scale;
    const dx = box.x + box.w - dw;
    const dy = box.y + (box.h - dh) / 2;
    c.save();
    c.beginPath();
    c.rect(dx, dy, dw, dh * easeOut(reveal));
    c.clip();
    c.imageSmoothingEnabled = false;
    c.drawImage(img, dx, dy, dw, dh);
    // Pixel grid: each cell is one real sampled pixel.
    if (scale >= 5) {
      c.strokeStyle = this.th.name === 'light' ? 'rgba(255,255,255,0.55)' : 'rgba(8,8,14,0.4)';
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < p.width; i++) {
        c.moveTo(Math.round(dx + i * scale) + 0.5, dy);
        c.lineTo(Math.round(dx + i * scale) + 0.5, dy + dh);
      }
      for (let j = 1; j < p.height; j++) {
        c.moveTo(dx, Math.round(dy + j * scale) + 0.5);
        c.lineTo(dx + dw, Math.round(dy + j * scale) + 0.5);
      }
      c.stroke();
    }
    c.restore();
    if (!this.reduced && reveal < 1) {
      c.fillStyle = rgba(this.th.role.pixels, 0.7);
      c.fillRect(dx, dy + dh * easeOut(reveal), dw, 1.5);
    }
  }

  private drawFrames(p: PreviewOf<'frames'>, box: Box) {
    const c = this.ctx;
    const reveal = this.reveal();
    const n = this.framesCanvases.length;
    const gap = 6;
    const fw = Math.min((box.w - gap * (n - 1)) / n, (box.h - 16) * (p.width / p.height));
    const fh = fw * (p.height / p.width);
    const total = fw * n + gap * (n - 1);
    const x0 = box.x + box.w - total;
    const y0 = box.y + (box.h - fh) / 2;
    this.framesCanvases.forEach((fc, i) => {
      const a = Math.min(1, Math.max(0, reveal * n - i));
      c.globalAlpha = a;
      c.imageSmoothingEnabled = true;
      c.drawImage(fc, x0 + i * (fw + gap), y0, fw, fh);
      c.fillStyle = this.th.muted;
      c.font = this.th.mono(9, 500);
      c.fillText(fmtDuration(p.times[i] ?? 0), x0 + i * (fw + gap), y0 + fh + 12);
      c.globalAlpha = 1;
    });
  }

  private drawWaveform(p: PreviewOf<'waveform'>, box: Box) {
    const c = this.ctx;
    const reveal = this.reveal();
    const n = p.peaks.length;
    const bw = box.w / n;
    const mid = box.y + box.h / 2;
    c.fillStyle = rgba(this.th.role.samples, 0.9);
    for (let i = 0; i < n; i++) {
      if (i / n > reveal) break;
      const v = p.peaks[i] ?? 0;
      const hh = Math.max(1, v * box.h * 0.48);
      c.fillRect(box.x + i * bw, mid - hh, Math.max(1, bw - 1), hh * 2);
    }
  }

  private drawOutline(p: PreviewOf<'outline'>, box: Box) {
    const c = this.ctx;
    const reveal = this.reveal();
    const lineH = 14;
    c.font = this.th.mono(10, 500);
    const lines = this.fit(p, box, () =>
      p.items.slice(0, Math.floor(box.h / lineH)).map((it) => [ellipsize(c, it.text, box.w - Math.min(4, it.level) * 12 - 12)]),
    );
    const rows = lines.length;
    for (let i = 0; i < rows; i++) {
      if (i / rows > reveal) break;
      const it = p.items[i]!;
      const y = box.y + i * lineH + 10;
      const indent = Math.min(4, it.level) * 12;
      const color = it.level > 0 ? this.th.role.header : this.th.role.text;
      c.fillStyle = rgba(color, 0.9);
      c.fillRect(box.x + indent, y - 7, 3, 9);
      c.fillStyle = it.level > 0 ? this.th.ink : this.th.muted;
      c.fillText(lines[i]![0]!, box.x + indent + 9, y);
    }
  }

  private drawGrid(p: PreviewOf<'grid'>, box: Box) {
    const c = this.ctx;
    const reveal = this.reveal();
    c.font = this.th.mono(9, 500);
    const cells = this.fit(p, box, () => {
      const rows = p.rows.slice(0, Math.floor(box.h / 16));
      const cw = box.w / Math.max(1, ...rows.map((r) => r.length));
      return rows.map((row) => row.map((cell) => ellipsize(c, cell, cw - 8)));
    });
    let cols = 1;
    for (const row of cells) cols = Math.max(cols, row.length);
    const cw = box.w / cols;
    cells.forEach((row, i) => {
      if (i / cells.length > reveal) return;
      const y = box.y + i * 16;
      row.forEach((text, j) => {
        c.fillStyle = i === 0 ? rgba(this.th.role.header, 0.12) : rgba(this.th.ink, 0.04);
        c.fillRect(box.x + j * cw, y, cw - 2, 14);
        c.fillStyle = i === 0 ? this.th.role.header : this.th.ink;
        c.fillText(text, box.x + j * cw + 4, y + 10);
      });
    });
  }

  private drawBigFact(facts: Facts, box: Box) {
    const c = this.ctx;
    c.textAlign = 'right';
    c.fillStyle = this.th.ink;
    c.font = this.th.title(this.L.compact ? 22 : 30);
    c.fillText(bigFact(facts), box.x + box.w, box.y + box.h / 2 + 8);
    c.textAlign = 'left';
  }

  /** Nothing decoded yet: an engine core, moving only while work is running. */
  private drawCore(s: VizState, box: Box) {
    const c = this.ctx;
    const cx = box.x + box.w - Math.min(box.w, box.h) / 2;
    const cy = box.y + box.h / 2;
    const rad = Math.min(box.w, box.h) * 0.32;
    const running = s.phase === 'running' && !this.reduced;
    if (this.th.name === 'light') {
      // A prism ring that turns only while the engine works.
      const g = c.createConicGradient(running ? this.t * 0.8 : 0, cx, cy);
      const stops = [this.th.role.pixels, this.th.role.style, this.th.role.header, this.th.role.records, this.th.role.pixels];
      stops.forEach((col, i) => g.addColorStop(i / (stops.length - 1), col));
      c.save();
      c.shadowColor = 'rgba(110,130,255,0.35)';
      c.shadowBlur = 30;
      c.lineWidth = Math.max(6, rad * 0.16);
      c.strokeStyle = g;
      c.beginPath();
      c.arc(cx, cy, rad, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    } else {
      // A breathing orb.
      const breath = running ? 1 + 0.08 * Math.sin(this.t * 2) : 1;
      const r = rad * 1.15 * breath;
      const g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.18, rgba(this.th.flow[1], 0.9));
      g.addColorStop(0.55, rgba(this.th.flow[1], 0.35));
      g.addColorStop(1, rgba(this.th.flow[1], 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
    }
  }

  /* ------------------------------------------------------------ packets */

  /** 1. Source bytes into the first engine. */
  private spawnIntake(s: VizState, tnow: number) {
    const L = this.L;
    const ch = L.chamber;
    const hop0 = s.hops[0];
    const started = hop0?.stages.some((x) => (INTAKE.has(x.id) || x.id === 'encode') && x.status !== 'pending');
    if (!hop0 || !this.groups.length || !(started || hop0.status === 'done')) {
      this.intakeStart = 0;
      this.payloadReleaseAt = 0;
      return;
    }
    if (!this.intakeStart) this.intakeStart = tnow;
    // Headers, indexes and metadata go in as soon as the engine starts
    // reading. Payload (pixels, samples, text, rows) goes in when it is
    // really consumed:
    //  - a stage that measures progress -> payload follows that fraction
    //    (streaming engines such as WebCodecs and FFmpeg);
    //  - 'read' followed by a later decode/transform stage is a container
    //    parse, so payload waits for the stage that consumes it;
    //  - any other running intake stage had the whole file at once, so the
    //    payload is handed over in file order.
    const st = hop0.stages;
    const active = runningStage(hop0);
    const ai = active ? st.indexOf(active) : -1;
    const firstIntake = st.findIndex((x) => INTAKE.has(x.id));
    let mode: 'hold' | 'measured' | 'release' = 'release';
    let measured = 0;
    if (hop0.status !== 'done' && active) {
      if (INTAKE.has(active.id)) {
        if (active.progress !== null) {
          mode = 'measured';
          measured = active.progress;
        } else if (active.id === 'read' && st.slice(ai + 1).some((x) => x.id !== 'read' && INTAKE.has(x.id))) {
          mode = 'hold';
        }
      } else if (ai < firstIntake) {
        mode = 'hold';
      }
    }
    if (mode === 'release' && !this.payloadReleaseAt) this.payloadReleaseAt = tnow;
    if (mode !== 'release') this.payloadReleaseAt = 0;
    const timed = Math.min(1, (tnow - this.intakeStart) / (this.reduced ? 1 : 500));
    const released = this.payloadReleaseAt ? Math.min(1, (tnow - this.payloadReleaseAt) / (this.reduced ? 1 : 700)) : 0;
    const payloadTotal = this.groups.reduce((a, g) => a + (PAYLOAD.has(g.role) ? g.f1 - g.f0 : 0), 0) || 1;
    let payloadSeen = 0;
    let waiting = false;
    for (const g of this.groups) {
      const isPayload = PAYLOAD.has(g.role);
      if (isPayload) payloadSeen += g.f1 - g.f0;
      if (g.departed) continue;
      const share = payloadSeen / payloadTotal;
      const due = isPayload
        ? mode === 'measured'
          ? share <= measured + 1e-9
          : mode === 'release' && share <= released + 1e-9
        : g.f1 <= timed + 1e-9 || timed >= 1;
      if (!due) {
        waiting = true;
        continue;
      }
      g.departed = true;
      for (const b of this.src) {
        if (b.f0 < g.f1 && b.f1 > g.f0) {
          b.read += Math.min(g.f1, b.f1) - Math.max(g.f0, b.f0);
          if (b.f1 <= g.f1 + 1e-6) b.departed = true;
        }
      }
      if (this.reduced) continue;
      const x0 = L.stripX + ((g.f0 + g.f1) / 2) * this.srcLen;
      const y0 = L.srcY + L.stripH / 2;
      const x1 = ch.x + ch.w / 2 + (Math.random() - 0.5) * 60;
      const y1 = ch.y + 6;
      const color = this.th.role[g.role];
      this.packets.push({
        color,
        outline: rgba(color, 0.9),
        x0,
        y0,
        cx: x0 + (x1 - x0) * 0.15,
        cy: (y0 + y1) / 2 + 20,
        x1,
        y1,
        t0: tnow,
        dur: 620 + Math.random() * 260,
        w0: Math.min(14, Math.max(4, (g.f1 - g.f0) * this.srcLen)),
      });
    }
    // Bytes still to hand over keep the frames coming.
    if (waiting) this.busy = true;
  }

  /** 2. Intermediate files between hops (real size from hop-done). */
  private spawnHandoffs(s: VizState, tnow: number) {
    const ch = this.L.chamber;
    s.hops.forEach((h, i) => {
      if (i === s.hops.length - 1 || h.status !== 'done' || this.hopPacketSent.has(i)) return;
      this.hopPacketSent.add(i);
      if (this.reduced) return;
      const x0 = ch.x + ch.w / 2;
      const y0 = ch.y + ch.h - 4;
      this.packets.push({
        color: this.th.accent,
        outline: rgba(this.th.accent, 0.9),
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
  }

  /** 3. Bytes out of the last engine into the output strip while it writes. */
  private spawnWrites(s: VizState, tnow: number) {
    const L = this.L;
    const ch = L.chamber;
    const final = s.hops[s.hops.length - 1];
    const writing = final ? writingStage(final) : undefined;
    if (!writing || this.reduced || tnow - this.lastOutPacket <= (writing.progress !== null ? 60 : 140)) return;
    this.lastOutPacket = tnow;
    const at = writing.progress !== null ? this.shownFill : Math.random();
    const part = this.out.find((b) => at >= b.f0 && at <= b.f1) ?? this.out[0];
    if (!part) return;
    const x0 = ch.x + ch.w / 2 + (Math.random() - 0.5) * 50;
    const y0 = ch.y + ch.h - 6;
    const x1 = L.stripX + at * this.outLen;
    const y1 = L.outY + L.stripH / 2;
    const color = this.th.role[part.role];
    this.packets.push({ color, outline: rgba(color, 0.9), x0, y0, cx: x1, cy: (y0 + y1) / 2 - 10, x1, y1, t0: tnow, dur: 560, w0: 6 });
  }

  private drawPackets(tnow: number) {
    if (!this.packets.length) return;
    const c = this.ctx;
    c.save();
    const blend = this.th.additive ? 'lighter' : 'source-over';
    c.globalCompositeOperation = blend;
    c.lineCap = 'round';
    const alive: Packet[] = [];
    for (const p of this.packets) {
      const u = (tnow - p.t0) / p.dur;
      if (u >= 1) continue;
      alive.push(p);
      const e = easeInOut(Math.max(0, u));
      const x = bezier(p.x0, p.cx, p.x1, e);
      const y = bezier(p.y0, p.cy, p.y1, e);
      const w = p.w0 * (1 - 0.6 * e);
      const a = u < 0.1 ? u / 0.1 : u > 0.85 ? (1 - u) / 0.15 : 1;
      // Comet trail along the same curve: the flow reads as a ribbon.
      c.strokeStyle = p.color;
      let px = x;
      let py = y;
      for (let k = 1; k <= 6; k++) {
        const ek = easeInOut(Math.max(0, u - k * 0.022));
        const tx = bezier(p.x0, p.cx, p.x1, ek);
        const ty = bezier(p.y0, p.cy, p.y1, ek);
        c.globalAlpha = a * (0.5 - k * 0.07);
        c.lineWidth = Math.max(1, 4.5 - k * 0.6);
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(tx, ty);
        c.stroke();
        px = tx;
        py = ty;
      }
      const glow = this.glow(p.color);
      c.globalAlpha = (this.th.additive ? 0.55 : 0.45) * a;
      c.drawImage(glow, x - 13, y - 13, 26, 26);
      c.globalAlpha = a;
      c.fillStyle = this.th.additive ? p.color : '#ffffff';
      roundRect(c, x - w / 2, y - 3, w, 6, 3);
      c.fill();
      if (!this.th.additive) {
        c.strokeStyle = p.outline;
        c.lineWidth = 1;
        c.stroke();
      }
      if (p.label) {
        c.globalCompositeOperation = 'source-over';
        c.font = this.th.mono(10, 500);
        c.fillStyle = this.th.ink;
        c.fillText(p.label, x + 12, y + 4);
        c.globalCompositeOperation = blend;
      }
    }
    c.restore();
    this.packets = alive;
    if (alive.length) this.busy = true;
  }

  /** Neutral roles are drawn faint; their text needs a readable colour. */
  private labelColor(role: SegmentRole): string {
    return role === 'container' || role === 'padding' || role === 'unknown' ? this.th.muted : this.th.role[role];
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

/** Share of a block already handed to the engine. */
function readFraction(b: Block): number {
  return Math.min(1, b.read / Math.max(1e-12, b.f1 - b.f0));
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

/**
 * The stage in which the output file is being produced: encode/package, or a
 * measured transform in a hop that has no separate encode stage (streaming
 * engines decode, encode and mux in one pass).
 */
function writingStage(hop: HopView): StageView | undefined {
  const active = runningStage(hop);
  if (!active) return undefined;
  if (active.id === 'encode' || active.id === 'package') return active;
  if (active.id === 'transform' && active.progress !== null && !hop.stages.some((x) => x.id === 'encode')) return active;
  return undefined;
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

/** One coordinate of a quadratic Bézier from a via b to c at t. */
function bezier(a: number, b: number, c: number, t: number): number {
  const i = 1 - t;
  return i * i * a + 2 * i * t * b + t * t * c;
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);

export function describeFacts(f: Facts): string {
  switch (f.kind) {
    case 'raster':
    {
      // Raw size of the pixels: width × height × channels × bytes per channel × frames.
      const raw = f.channels && f.depth ? f.width * f.height * f.channels * (f.depth / 8) * (f.frames ?? 1) : 0;
      return `${f.width}×${f.height} px${f.frames && f.frames > 1 ? ` · ${f.frames} frames` : ''}${f.channels ? ` · ${f.channels === 4 ? 'RGBA' : f.channels === 3 ? 'RGB' : f.channels === 1 ? 'grey' : `${f.channels} ch`}` : ''}${f.depth ? ` ${f.depth}-bit` : ''}${raw ? ` · ${fmtBytes(raw)} uncompressed` : ''}`;
    }
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
      return `${fmtDuration(f.durationS)} · ${(f.sampleRate / 1000).toFixed(1)} kHz · ${fmtChannels(f.channels)}${f.codec ? ` · ${f.codec}` : ''}`;
    case 'video':
      return `${f.width}×${f.height}${f.fps ? ` · ${Math.round(f.fps * 100) / 100} fps` : ''} · ${fmtDuration(f.durationS)}${f.videoCodec ? ` · ${f.videoCodec}` : ''}${f.audioCodec ? ` + ${f.audioCodec}` : ''}`;
    case 'text':
      return `${f.chars.toLocaleString()} chars · ${f.lines.toLocaleString()} lines`;
  }
}

function bigFact(f: Facts): string {
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
