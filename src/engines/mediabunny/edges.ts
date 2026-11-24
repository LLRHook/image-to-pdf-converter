import type { EdgeSpec } from '../../core/types';
import { READS, WRITES, mediabunnyStages, supportsPair } from './plan';

const LOSSLESS_TARGETS = new Set<string>(['wav', 'flac']);

/**
 * Preferred audio/video engine: WebCodecs through mediabunny. Uses the
 * browser's own (usually hardware) codecs, copies tracks when the target
 * container can hold them, and needs no wasm download except small MP3/AAC/FLAC
 * encoders for browsers that lack them. When this browser cannot decode or
 * encode what the job needs, the engine throws EngineUnsupportedError and the
 * runner continues with FFmpeg.
 */
export const edges: EdgeSpec[] = [
  {
    from: READS,
    to: WRITES,
    cost: 2,
    exclude: (from, to) => !supportsPair(from, to),
    fidelity: (_from, to) => (LOSSLESS_TARGETS.has(to) ? 'lossless' : 'lossy'),
    stages: mediabunnyStages,
    note: (from, to) => {
      const video = ['mp4', 'webm', 'mov', 'mkv'];
      if (video.includes(from) && video.includes(to)) return 'Tracks the new container can hold are copied without re-encoding.';
      return undefined;
    },
  },
];
