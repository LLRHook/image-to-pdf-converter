/** Pure data shared by edges.ts (main thread) and engine.ts (worker). */
export const DEFAULT_DPI = 150;
export const MIN_DPI = 36;
export const MAX_DPI = 600;
/** Pages we will render or extract one by one (PNG / JPEG / SVG / text / HTML). */
export const MAX_PAGES = 500;
/** EPUB -> PDF only lays pages out; no per-page image is held, so a long novel is fine. */
export const MAX_PAGES_TYPESET = 3000;
/** Per rendered page. */
export const MAX_SIDE_PX = 16384;
export const MAX_PIXELS = 100_000_000;
/** Everything we keep in memory before it is returned (bytes). */
export const MAX_OUTPUT_BYTES = 768 * 1024 * 1024;
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;
/** EPUB pages are typeset onto A5 (points) with an 11 pt base font. */
export const EPUB_PAGE = { width: 420, height: 595, fontSize: 11 } as const;
