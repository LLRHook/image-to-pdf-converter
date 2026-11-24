import type { EdgeSpec } from '../../core/types';
import type { FormatId } from '../../core/formats';
import { READS, WRITES, ffmpegStages, supportsPair } from './plan';

const LOSSLESS_TARGETS = new Set<string>(['wav', 'flac']);

/**
 * Last-resort audio/video engine: FFmpeg compiled to WebAssembly (GPL-2.0-or-later).
 * Slow and large (32 MB download) next to WebCodecs, but it decodes and encodes
 * almost anything and is the only engine for GIF.
 */
export const edges: EdgeSpec[] = [
  {
    from: READS,
    to: WRITES,
    cost: 9,
    exclude: (from, to) => !supportsPair(from, to),
    fidelity: (from, to) => {
      if (to === 'gif') return 'lossy';
      if (LOSSLESS_TARGETS.has(to) && from !== 'gif') return 'lossless';
      return 'lossy';
    },
    stages: ffmpegStages,
    note: (from: FormatId, to: FormatId) => {
      if (to === 'gif') return 'GIF is limited to 256 colours, 15 fps and 640 px wide.';
      if (from === 'gif') return 'GIF frames are re-encoded as video.';
      if (to === 'webm') return 'Encoded as VP8 + Opus in the browser.';
      return undefined;
    },
  },
];
