# Bundled fonts for PDF output (Typst)

The Typst compiler build used here (`@myriaddreamin/typst-ts-web-compiler`) embeds **no fonts**, so
these files are what every PDF is drawn with. They load through `ctx.fetchAsset` (Vite `?url`),
never from a CDN. Without at least one file in this folder the `typst` engine publishes no edges.

## Source

All nine files are the **unmodified** font files of the official Typst assets repository, tag
`v0.13.1` (the font set the Typst compiler itself embeds):

`https://github.com/typst/typst-assets/tree/v0.13.1/files/fonts`
(raw: `https://raw.githubusercontent.com/typst/typst-assets/v0.13.1/files/fonts/<file>`)

Verified 2026-11-24: each file was re-downloaded from the raw URL above and is byte-identical
to the copy here (SHA-256 below). Licence texts: [`LICENSES.txt`](./LICENSES.txt), copied from the
repository's [`NOTICE`](https://raw.githubusercontent.com/typst/typst-assets/v0.13.1/NOTICE).

| File | Family / version (from the font's own name table) | Licence | SHA-256 |
|------|---------------------------------------------------|---------|---------|
| `LibertinusSerif-Regular.otf` | Libertinus Serif, Version 7.051 | OFL-1.1 | `fcf06307a77367394fcb0ccb241e59eea70dba3d732be309647611224679c733` |
| `LibertinusSerif-Italic.otf` | Libertinus Serif, Version 7.051 | OFL-1.1 | `9a393d63d6e05f620d3dc0190dfd35a8ede58c0808cf0fc9de7fcb9c723e4c24` |
| `LibertinusSerif-Bold.otf` | Libertinus Serif, Version 7.051 | OFL-1.1 | `0264914210ed51b3231ebc92ce529e9f2e166ba9eebf0cd4a579558690a27b64` |
| `LibertinusSerif-BoldItalic.otf` | Libertinus Serif, Version 7.051 | OFL-1.1 | `47a665259f09f554f5d133d7718cdad43ff462c6a6b2328f38023465e62d57ce` |
| `DejaVuSansMono.ttf` | DejaVu Sans Mono, Version 2.37 | Bitstream Vera + Arev + public domain | `b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582` |
| `DejaVuSansMono-Bold.ttf` | DejaVu Sans Mono Bold, Version 2.37 | same | `bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769` |
| `DejaVuSansMono-Oblique.ttf` | DejaVu Sans Mono Oblique, Version 2.37 | same | `742097840c541870e8d6dc5c9b37bb1ceeea6c0dedd1d475faf903ef9df734b0` |
| `DejaVuSansMono-BoldOblique.ttf` | DejaVu Sans Mono Bold Oblique, Version 2.37 | same | `91713a71d550bba22c2a6b2bb2a9ad8f9a159e12e4e9f0a5b2677998ba21213e` |
| `NewCMMath-Regular.otf` | New Computer Modern Math, Version 4.0 (A. Tsolomitis, 2019-2021) | GUST Font License 1.0 (LPPL-based) | `bfd2f9b22caacd41b8b29cfe3f6d72f976f221a65362e07eda35cbae863721b7` |

## Licences and GPL-3.0-or-later compatibility

- **Libertinus Serif** (Copyright 2012-2024 The Libertinus Project Authors): SIL Open Font License 1.1.
  Bundling and redistribution with software is permitted; the font is not sold on its own and keeps
  its licence (`LICENSES.txt`). The OFL applies to the font files, not to the PDFs made with them.
- **DejaVu Sans Mono**: Bitstream Vera licence (permissive, redistribution allowed with the notice),
  Arev additions, DejaVu changes in the public domain. Unmodified here, so no renaming duty applies.
- **New Computer Modern Math** (GUST Font License, which is the LaTeX Project Public License 1.3c
  terms): free to redistribute unmodified, as here.

These are font data files shipped next to the program, not code linked into it; all three licences
allow redistribution alongside GPL-3.0-or-later software.

## What the set covers

Latin, Greek and Cyrillic text (Libertinus Serif), monospace code (DejaVu Sans Mono) and maths
(New Computer Modern Math). CJK, Arabic, Indic scripts and emoji have **no glyphs** in this set; the
engine tells the user when a document contains them.

## Changing the set

Use only fonts under a GPL-3.0-compatible licence (OFL-1.1, Bitstream Vera/DejaVu, GUST/LPPL). Take them
from the font's official release, record the URL, version, licence and SHA-256 here, and add the
licence text to `LICENSES.txt`. Total size is 3,551,588 bytes (about 3.4 MiB) uncompressed.
