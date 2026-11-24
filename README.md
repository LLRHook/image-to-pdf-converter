# any→any

Convert images, documents, spreadsheets, audio and video between formats, entirely in your browser.
While it works, the page shows the file's real internal structure coming apart and the new format being
assembled.

**Live:** https://llrhook.github.io/image-to-pdf-converter/

## Privacy model

Nothing you convert leaves your device, and nothing is kept.

| Layer | What it does |
|---|---|
| No backend | The site is static files on GitHub Pages. There is no server that could receive a file. |
| Workers | Every conversion step runs in a fresh Web Worker that is terminated when the step ends, which releases its memory. |
| Network jail | Before engine code loads, each worker wraps `fetch`/XHR/`importScripts` and removes WebSocket/EventSource/WebTransport, allowing only this site's own files. |
| CSP | The built page ships `connect-src 'self'`, `form-action 'none'` and no third-party origins. Fonts and engines are self-hosted. |
| Service worker | Refuses every non-GET or cross-origin request. It caches only the app's own files (engines included) so they work offline. |
| No storage | No cookies, localStorage, IndexedDB or OPFS. Downloads use short-lived `blob:` URLs that are revoked. |

Playwright tests assert that a conversion makes zero requests outside the site's origin.

## What converts to what

The planner (`src/core/graph.ts`) chains engines automatically, for example SVG → PNG (resvg) → AVIF
(ImageMagick). The format picker lists every reachable target and labels it lossless, lossy, re-laid out
or rasterised.

| Family | Engine (WebAssembly unless noted) | License |
|---|---|---|
| Raster images, HEIC/PSD read, images → PDF | ImageMagick 7 (`@imagemagick/magick-wasm`) | Apache-2.0 |
| SVG → PNG | resvg (`@resvg/resvg-wasm`) | MPL-2.0 |
| PDF → images, text, HTML, SVG | MuPDF (`mupdf`) | AGPL-3.0-or-later |
| DOCX, ODT, RTF, EPUB, Markdown, HTML, LaTeX | pandoc 3 (`pandoc-wasm`) | GPL-2.0-or-later |
| Documents → PDF | pandoc → Typst (`@myriaddreamin/typst.ts`) | Apache-2.0 |
| XLSX, XLS, ODS, CSV, TSV, JSON | SheetJS CE 0.20.3, papaparse | Apache-2.0, MIT |
| JSON, YAML, XML | `yaml`, `fast-xml-parser` | ISC, MIT |
| Audio/video (fast path) | Mediabunny on the browser's WebCodecs | MPL-2.0 |
| Audio/video (fallback), GIF | FFmpeg (`@ffmpeg/core`, single-thread) | GPL-2.0-or-later |

Engines download on first use only and are cached afterwards.

Known limits:
- Document → PDF output is re-typeset with Typst, so the result keeps the content but not the original
  page design. Pixel-faithful DOCX → PDF needs LibreOffice, which is planned for the desktop build.
- Very large videos are limited by browser memory (FFmpeg path ≤ 1.5 GB).

## The loading screen

`src/viz/` draws only what really happens:

- The **input strip** is the file's actual byte layout from `src/core/structure/` (PNG chunks, JPEG
  markers, MP4 boxes, ZIP entries of a DOCX, PDF objects…). Widths are true byte proportions. Thin
  segments are named with callouts, and hovering shows offset, length and parsed detail.
- **Stages** come from the engine as they happen. A percentage appears only when the engine measured one
  (pages, frames, rows, bytes downloaded). Steps it can't measure show elapsed time and an
  indeterminate meter, never a fake bar.
- The **middle panel** shows a real sample of the decoded data: a downsampled pixel grid, video frames,
  an audio waveform, a document outline or the first table cells.
- The **output strip** starts as the target format's expected layout. After writing, the real output
  is parsed and the strip morphs into its true segments and sizes.

The loading screen honours `prefers-reduced-motion`.

## Development

```bash
npm install
npm run dev          # http://localhost:5173 (engine harness at /harness.html)
npm test             # unit tests (Vitest, Node)
npm run test:e2e     # real engines in Chromium, Firefox, WebKit (Playwright)
npm run build        # static site in dist/
```

Adding an engine: create `src/engines/<id>/edges.ts` (pure data: from/to formats, cost, fidelity, the exact
stages it reports) and `src/engines/<id>/engine.ts` (`convert(req, ctx)`, run inside a worker). The
registry discovers both automatically. See `src/core/types.ts` for the contract.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). Bundled engines keep their own licenses (table above).
