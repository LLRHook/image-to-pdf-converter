import type { EdgeSpec, StageSpec } from '../../core/types';

/** Tiny fast paths that avoid the 16 MB pandoc download. No library import here. */
const stages = (decode: string, encode: string): StageSpec[] => [
  { id: 'decode', label: decode },
  { id: 'encode', label: encode },
];

export const edges: EdgeSpec[] = [
  {
    from: ['md'],
    to: ['html'],
    cost: 1,
    fidelity: 'lossless',
    stages: () => stages('Parse Markdown', 'Render HTML'),
    note: () => 'Scripts and frames in raw HTML are removed.',
  },
  {
    from: ['txt'],
    to: ['html'],
    cost: 1,
    fidelity: 'lossless',
    stages: () => stages('Split plain text into paragraphs', 'Write HTML'),
  },
  {
    from: ['txt'],
    to: ['md'],
    cost: 1,
    fidelity: 'lossless',
    stages: () => stages('Split plain text into paragraphs', 'Write Markdown'),
  },
  {
    // Falls back to pandoc (EngineUnsupportedError) for tables, raw HTML, footnotes and front matter.
    from: ['md'],
    to: ['txt'],
    cost: 1,
    fidelity: 'semantic',
    stages: () => stages('Parse Markdown', 'Write plain text'),
    note: () => 'Formatting and images are dropped; only the text is kept.',
  },
];
