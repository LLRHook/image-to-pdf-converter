# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) for client-side file format conversion. All conversions happen in-browser — no backend.

## Commands

All commands run from the project root:

- **Dev server:** `npm run dev` (Vite dev server for UI work)
- **Build:** `npm run build` (outputs to `dist/`)
- **Load in Chrome:** `chrome://extensions/` → Developer mode → Load unpacked → select `dist/`

## Architecture

**Chrome Extension (Manifest V3)** — React popup, service worker, offscreen document.

### Entry points

| Entry | File | Purpose |
|-------|------|---------|
| Popup | `popup.html` → `src/popup/main.jsx` | React UI for file upload + conversion |
| Service worker | `src/background/service-worker.js` | Context menus, image fetch, pdf-lib conversion |
| Offscreen | `offscreen.html` → `src/offscreen/offscreen.js` | Canvas-based image-to-image conversion |

### Component hierarchy

`popup.html` → `App.jsx` → `FileUpload.jsx` (single component handles everything)

### Conversion engine (`src/conversion/`)

| Module | Formats | Library | DOM needed? |
|--------|---------|---------|-------------|
| `imageToPdf.js` | PNG/JPG → PDF | pdf-lib | No |
| `imageToImage.js` | PNG/JPG ↔ PNG/JPG | Canvas API | Yes |
| `textToPdf.js` | TXT → PDF | jsPDF | Yes |
| `docxToPdf.js` | DOCX → PDF | mammoth + jsPDF | Yes |
| `spreadsheet.js` | XLSX ↔ CSV | xlsx | No |
| `index.js` | Unified `convert()` dispatcher | — | — |

### Context menu flow

1. Right-click image → "Convert image to..." → PDF/PNG/JPG
2. Service worker fetches image, converts (pdf-lib for PDF, offscreen doc for image-to-image)
3. Triggers `chrome.downloads.download()`

### Key libraries

| Library | Purpose |
|---------|---------|
| `pdf-lib` | PDF creation from images (no DOM) |
| `jspdf` | PDF generation for text/DOCX |
| `mammoth` | DOCX → HTML parsing |
| `xlsx` | Excel/CSV read/write |

### Styling

Tailwind CSS utility classes inline in JSX. PostCSS configured at root.

### Build system

Vite with `@vitejs/plugin-react`. Multi-entry build: popup (HTML), offscreen (HTML), service worker (JS). Custom plugin copies `manifest.json` and `public/icons/` to `dist/`.

### Shared utilities

- `src/shared/constants.js` — Format groups, output format logic, max file size
- `src/shared/messaging.js` — Chrome message type constants
