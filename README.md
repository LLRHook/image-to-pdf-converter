# File Format Converter — Chrome Extension

A Chrome extension that converts images, documents, and spreadsheets between formats. All conversions happen in-browser — no data leaves your device.

## Features

- **Popup converter**: Click the extension icon to upload and convert files
- **Right-click context menu**: Right-click any image on a webpage to convert it to PDF, PNG, or JPG
- **Supported conversions**:
  - Images (PNG, JPG, JPEG) → PDF, PNG, JPG, JPEG
  - Documents (TXT, DOCX) → PDF
  - Spreadsheets (XLSX, CSV) → CSV, XLSX
- Client-side processing — no files uploaded anywhere
- Drag-and-drop file upload

## Installation

### From source (development)

1. Clone and build:
   ```bash
   git clone https://github.com/LLRHook/image-to-pdf-converter.git
   cd image-to-pdf-converter
   npm install
   npm run build
   ```

2. Load in Chrome:
   - Navigate to `chrome://extensions/`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select the `dist/` folder

## Development

```bash
npm install        # Install dependencies
npm run dev        # Start Vite dev server (for UI development)
npm run build      # Build extension to dist/
```

After changing code, run `npm run build` and click the refresh icon on `chrome://extensions/` to reload.

## Architecture

- **Manifest V3** Chrome extension
- **Popup** (`popup.html`) — React UI with file upload and format selection
- **Service worker** (`service-worker.js`) — Registers context menus, handles image fetch + conversion
- **Offscreen document** (`offscreen.html`) — Canvas-based image format conversion (used by context menu)
- **Conversion engine** (`src/conversion/`) — Modular converters using pdf-lib, jsPDF, mammoth, xlsx

## Privacy

All conversions happen locally in your browser. No files or data are sent to any server.

## License

MIT
