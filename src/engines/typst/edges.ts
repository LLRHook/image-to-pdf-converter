import type { EdgeSpec } from '../../core/types';
import { DOC_NAMES, PANDOC_SOURCES, decodeStage } from '../pandoc/spec';

/**
 * Typst's compiler build has no embedded fonts, so this engine only appears
 * once font files exist in ./fonts (see fonts/README.md). Without them there
 * is no way to render any text, and offering the conversion would just fail.
 */
const hasFonts = Object.keys(import.meta.glob('./fonts/*.{otf,ttf}', { query: '?url', import: 'default' })).length > 0;

export const edges: EdgeSpec[] = hasFonts
  ? [
      {
        from: PANDOC_SOURCES,
        to: ['pdf'],
        cost: 10,
        fidelity: 'semantic',
        stages: (from) => [
          { id: 'load', label: 'Load pandoc + Typst' },
          decodeStage(from),
          { id: 'transform', label: 'Typeset with Typst' },
          { id: 'encode', label: `Write ${DOC_NAMES.pdf}` },
        ],
        note: () =>
          'Re-typeset with Typst; page layout differs from the original. Text outside Latin, Greek and Cyrillic (CJK, Arabic, emoji) is left blank.',
      },
    ]
  : [];
