import type { EdgeSpec, StageSpec } from '../../core/types';
import type { FormatId } from '../../core/formats';
import { DEFAULT_DPI, EPUB_PAGE, MAX_PAGES } from './meta';

const LOAD: StageSpec = { id: 'load', label: 'Load MuPDF 1.28' };
const PACKAGE: StageSpec = { id: 'package', label: 'Package result (ZIP when several pages)' };

const OPEN: Record<string, string> = {
  pdf: 'Open PDF, read page tree',
  epub: 'Open EPUB, typeset pages',
};

const ENCODE: Record<string, string> = {
  png: 'Render pages to PNG',
  jpg: 'Render pages to JPEG',
  svg: 'Draw pages as SVG',
  txt: 'Extract text',
  html: 'Extract text with layout as HTML',
  pdf: 'Typeset PDF pages',
};

const stagesFor = (bundles: boolean) => (from: FormatId, to: FormatId): StageSpec[] => [
  LOAD,
  { id: 'decode', label: OPEN[from]! },
  { id: 'encode', label: ENCODE[to]! },
  ...(bundles ? [PACKAGE] : []),
];

export const edges: EdgeSpec[] = [
  {
    // One file for a single page, a ZIP with one file per page otherwise.
    from: ['pdf', 'epub'],
    to: ['png'],
    cost: 7, // 10 MB wasm
    fidelity: 'raster',
    mayBundle: true,
    stages: stagesFor(true),
    note: (from) =>
      from === 'pdf'
        ? `Rendered at ${DEFAULT_DPI} dpi; several pages are returned as a ZIP, up to ${MAX_PAGES} pages`
        : `Typeset on A5 pages, rendered at ${DEFAULT_DPI} dpi; several pages are returned as a ZIP`,
  },
  {
    from: ['pdf'],
    to: ['jpg'],
    cost: 7,
    fidelity: 'raster',
    mayBundle: true,
    stages: stagesFor(true),
    note: () => `Rendered at ${DEFAULT_DPI} dpi, quality 90; several pages are returned as a ZIP, up to ${MAX_PAGES} pages`,
  },
  {
    from: ['pdf'],
    to: ['svg'],
    cost: 7,
    fidelity: 'semantic', // vector content is kept; the page becomes a flat drawing
    mayBundle: true,
    stages: stagesFor(true),
    note: () => 'One SVG per page, returned as a ZIP when there are several',
  },
  {
    from: ['pdf'],
    to: ['txt', 'html'],
    cost: 7,
    fidelity: 'semantic', // text and its reading order, not the page
    stages: stagesFor(false),
    note: (_from, to) =>
      to === 'txt' ? 'Only selectable text is extracted; scanned pages have none' : 'Text is positioned like the page; images are not included',
  },
  {
    from: ['epub'],
    to: ['pdf'],
    cost: 7,
    fidelity: 'semantic', // reflowable book is re-typeset into fixed pages
    stages: stagesFor(false),
    note: () => `Typeset on ${EPUB_PAGE.width}×${EPUB_PAGE.height} pt pages with built-in fonts`,
  },
];
