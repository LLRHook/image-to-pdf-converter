import type { EdgeSpec } from '../../core/types';
import { BUNDLE_TARGETS, PANDOC_SOURCES, PANDOC_TARGETS, DOC_NAMES, decodeStage, loadLabel } from './spec';

export const edges: EdgeSpec[] = [
  {
    from: PANDOC_SOURCES,
    to: PANDOC_TARGETS,
    cost: 8,
    fidelity: 'semantic',
    mayBundle: true,
    stages: (from, to) => [
      { id: 'load', label: loadLabel },
      decodeStage(from),
      { id: 'encode', label: `Write ${DOC_NAMES[to]}` },
      ...(BUNDLE_TARGETS.has(to) ? [{ id: 'package' as const, label: 'Collect embedded images' }] : []),
    ],
    note: (from, to) => {
      if (to === 'txt') return 'Formatting and images are dropped; only the text is kept.';
      if (to === 'md') return from === 'txt' ? undefined : 'Fonts, colours and page layout are not kept; structure is.';
      if (to === 'html' && (from === 'md' || from === 'tex')) return 'Scripts in the source are blocked in the HTML.';
      if (to === 'tex') return 'Written as a standalone LaTeX document.';
      return undefined;
    },
  },
];
