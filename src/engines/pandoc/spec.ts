/** Pure data shared by the pandoc and typst edge declarations (no library imports). */
import type { FormatId } from '../../core/formats';
import type { StageSpec } from '../../core/types';
import { PANDOC_VERSION } from './version';

export const DOC_NAMES: Partial<Record<FormatId, string>> = {
  docx: 'DOCX',
  odt: 'ODT',
  rtf: 'RTF',
  epub: 'EPUB',
  md: 'Markdown',
  html: 'HTML',
  tex: 'LaTeX',
  txt: 'plain text',
  pdf: 'PDF',
};

/** Formats pandoc can read (plain text has no reader: the AST is built from it). */
export const PANDOC_SOURCES = ['docx', 'odt', 'rtf', 'epub', 'md', 'html', 'tex', 'txt'] as const satisfies readonly FormatId[];
/** Formats pandoc can write. */
export const PANDOC_TARGETS = ['docx', 'odt', 'rtf', 'epub', 'md', 'html', 'tex', 'txt'] as const satisfies readonly FormatId[];

export const loadLabel = `Load pandoc ${PANDOC_VERSION}`;

export function decodeStage(from: FormatId): StageSpec {
  return {
    id: 'decode',
    label: from === 'txt' ? 'Split plain text into pandoc AST' : `Read ${DOC_NAMES[from]} into pandoc AST`,
  };
}

/** Targets whose images stay separate files, so the result may be a ZIP (document + media/). */
export const BUNDLE_TARGETS: ReadonlySet<string> = new Set(['md', 'tex']);
