/** Resource limits shared by the document engines. Inputs are treated as hostile. */
export const LIMITS = {
  /** Largest input file we accept. */
  inputBytes: 50 * 1024 * 1024,
  /** Total uncompressed size declared inside a ZIP container (DOCX/ODT/EPUB), a zip-bomb guard. */
  zipUncompressedBytes: 400 * 1024 * 1024,
  /** Largest single entry declared inside a ZIP container. */
  zipEntryBytes: 150 * 1024 * 1024,
  /** Most entries in a ZIP container. */
  zipEntries: 20_000,
  /** Largest pandoc JSON AST we will carry between the reader and the writer. */
  astBytes: 160 * 1024 * 1024,
  /** Most images carried through a conversion. */
  images: 5_000,
  /** Total bytes of images carried through a conversion. */
  imageBytes: 200 * 1024 * 1024,
} as const;

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * Markdown readers are quadratic (or worse) in the number of `_` / `*` delimiter runs inside one
 * whitespace-free word. Measured on one core: marked, `a_` x 10k = 0.8 s, x 40k = 10 s; pandoc-wasm,
 * `a_` x 2k = 7.5 s, x 4k = 20 s, x 8k = 76 s. Spaces between the delimiters and balanced pairs
 * are linear. A wasm call cannot be interrupted from inside its worker, so hostile input is refused
 * up front, in linear time, instead of hanging the conversion.
 *
 * The estimate is the sum over words of (delimiter runs)^2. The budget is ~2,000 runs in one word,
 * a few seconds of pandoc at worst; real documents have a few dozen at most.
 */
export const MARKDOWN_WORK_BUDGET = 4e6;

export function markdownWork(src: string): number {
  let work = 0;
  let runs = 0; // delimiter runs in the current word
  let inRun = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 95 || c === 42) {
      if (!inRun) runs++;
      inRun = true;
    } else {
      inRun = false;
      // ASCII whitespace ends the word
      if (c === 32 || c === 10 || c === 9 || c === 13) {
        work += runs * runs;
        runs = 0;
      }
    }
  }
  return work + runs * runs;
}

/**
 * Block quotes nested N deep cost pandoc ~N^2 (300 deep = 0.05 s, 1,000 = 2.4 s, 3,000 = 14 s) and
 * overflow marked's stack. Real documents nest a handful of levels.
 */
export const MARKDOWN_MAX_QUOTE_DEPTH = 400;
// Spaces belong to exactly one place (after a `>`), so this cannot backtrack exponentially.
const DEEP_QUOTES = new RegExp(`^ {0,3}(?:>[ \\t]*){${MARKDOWN_MAX_QUOTE_DEPTH + 1}}`, 'm');

export function assertMarkdownTractable(src: string): void {
  if (DEEP_QUOTES.test(src)) {
    throw new Error(`This Markdown nests block quotes more than ${MARKDOWN_MAX_QUOTE_DEPTH} levels deep. Converting it would take far too long, so it was refused.`);
  }
  if (markdownWork(src) > MARKDOWN_WORK_BUDGET) {
    throw new Error('This Markdown has a run of text with thousands of _ or * marks and no spaces. Converting it would take far too long, so it was refused. Break up or remove that text and try again.');
  }
}
