/**
 * Visualiser state, reduced from real runner events only. Nothing in here is
 * estimated: stage boundaries come from engine `stage` calls, percentages
 * from engine `progress` calls (null when the engine cannot measure), byte
 * counts from the asset loader, facts/previews from the decoded data.
 */
import type { FileStructure } from '../core/structure/types';
import type { Hop, Route } from '../core/graph';
import type { RunEvent } from '../core/runner';
import type { Facts, Preview, StageId } from '../core/types';
import type { FormatId } from '../core/formats';

export type StageStatus = 'pending' | 'active' | 'done' | 'failed';

export interface StageView {
  id: StageId;
  label: string;
  status: StageStatus;
  startedAt?: number;
  endedAt?: number;
  /** Measured fraction, or null if the engine never reported one for this stage. */
  progress: number | null;
}

export interface AssetView {
  url: string;
  loaded: number;
  total: number | null;
}

export interface HopView {
  engine: string;
  from: FormatId;
  to: FormatId;
  stages: StageView[];
  assets: AssetView[];
  facts: Facts | null;
  preview: Preview | null;
  status: 'pending' | 'active' | 'done' | 'failed';
  startedAt?: number;
  endedAt?: number;
  outSize?: number;
  fallbacks: { fromEngine: string; reason: string }[];
}

export interface FileView {
  name: string;
  format: FormatId;
  size: number;
  structure: FileStructure | null;
}

export interface VizState {
  phase: 'running' | 'done' | 'error' | 'cancelled';
  input: FileView;
  output: FileView | null;
  route: Route;
  hops: HopView[];
  activeHop: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

const hopView = (h: Hop): HopView => ({
  engine: h.engine,
  from: h.from,
  to: h.to,
  stages: h.stages.map((s) => ({ id: s.id, label: s.label, status: 'pending', progress: null })),
  assets: [],
  facts: null,
  preview: null,
  status: 'pending',
  fallbacks: [],
});

export function initialState(input: FileView, route: Route, at: number): VizState {
  return { phase: 'running', input, output: null, route, hops: route.hops.map(hopView), activeHop: 0, startedAt: at };
}

function closeActive(h: HopView, at: number, status: StageStatus = 'done') {
  for (const s of h.stages) {
    if (s.status === 'active') {
      s.status = status;
      s.endedAt = at;
    }
  }
}

/** Returns a new top-level object (hops are copied) so React sees the change. */
export function reduce(prev: VizState, ev: RunEvent, lookupHop: (engine: string, from: FormatId, to: FormatId) => Hop | undefined): VizState {
  const s: VizState = { ...prev, hops: prev.hops.map((h) => ({ ...h, stages: h.stages.map((x) => ({ ...x })), assets: [...h.assets] })) };
  const hop = 'hop' in ev ? s.hops[ev.hop] : undefined;
  switch (ev.type) {
    case 'hop-start':
      if (hop) {
        hop.status = 'active';
        hop.startedAt ??= ev.at;
        s.activeHop = ev.hop;
      }
      break;
    case 'fallback': {
      if (!hop) break;
      const alt = lookupHop(ev.toEngine, hop.from, hop.to);
      closeActive(hop, ev.at, 'failed');
      const fresh = alt ? hopView(alt) : { ...hop, engine: ev.toEngine };
      s.hops[ev.hop] = {
        ...fresh,
        status: 'active',
        startedAt: hop.startedAt,
        fallbacks: [...hop.fallbacks, { fromEngine: ev.fromEngine, reason: ev.reason }],
      };
      break;
    }
    case 'stage': {
      if (!hop) break;
      closeActive(hop, ev.at);
      let st = hop.stages.find((x) => x.id === ev.stage && x.status === 'pending');
      if (!st) {
        // Engine reported a stage it did not declare. Show it rather than hide it.
        st = { id: ev.stage, label: ev.stage, status: 'pending', progress: null };
        hop.stages.push(st);
      }
      // Any declared stage skipped over is marked done at this instant.
      const idx = hop.stages.indexOf(st);
      for (let i = 0; i < idx; i++) {
        const p = hop.stages[i]!;
        if (p.status === 'pending') {
          p.status = 'done';
          p.startedAt = p.endedAt = ev.at;
        }
      }
      st.status = 'active';
      st.startedAt = ev.at;
      break;
    }
    case 'progress': {
      const st = hop?.stages.find((x) => x.status === 'active');
      if (st) st.progress = ev.value;
      break;
    }
    case 'asset': {
      if (!hop) break;
      const i = hop.assets.findIndex((a) => a.url === ev.url);
      const a = { url: ev.url, loaded: ev.loaded, total: ev.total };
      if (i >= 0) hop.assets[i] = a;
      else hop.assets.push(a);
      break;
    }
    case 'facts':
      if (hop) hop.facts = ev.facts;
      break;
    case 'preview':
      if (hop) hop.preview = ev.preview;
      break;
    case 'hop-done':
      if (hop) {
        closeActive(hop, ev.at);
        for (const st of hop.stages) if (st.status === 'pending') st.status = 'done';
        hop.status = 'done';
        hop.endedAt = ev.at;
        hop.outSize = ev.size;
      }
      break;
    case 'done':
      s.phase = 'done';
      s.endedAt = ev.at;
      s.output = { name: ev.result.name, format: s.route.to, size: ev.result.blob.size, structure: null };
      break;
    case 'error':
      if (hop) {
        closeActive(hop, ev.at, 'failed');
        hop.status = 'failed';
        hop.endedAt = ev.at;
      }
      s.phase = 'error';
      s.error = ev.message;
      s.endedAt = ev.at;
      break;
    case 'cancelled':
      s.phase = 'cancelled';
      s.endedAt = ev.at;
      for (const h of s.hops) closeActive(h, ev.at, 'failed');
      break;
    case 'log':
      break;
  }
  return s;
}

export function withOutputStructure(s: VizState, structure: FileStructure): VizState {
  return s.output ? { ...s, output: { ...s.output, structure } } : s;
}

/** The stage currently running, across hops. */
export function activeStage(s: VizState): { hop: HopView; stage: StageView } | null {
  const hop = s.hops[s.activeHop];
  const stage = hop?.stages.find((x) => x.status === 'active');
  return hop && stage ? { hop, stage } : null;
}
