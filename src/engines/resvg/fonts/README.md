Drop `.ttf` / `.otf` / `.ttc` files here to make SVG `<text>` render.

resvg runs in WebAssembly and cannot see system fonts, so without a bundled font every `<text>`
element is skipped. Any font file in this folder is picked up automatically at build time,
downloaded through `ctx.fetchAsset` with the rest of the engine's assets, and registered as the
default family. Only fonts whose licence allows redistribution under the app's licence belong here
(for example OFL fonts such as Noto Sans or Inter). No font ships by default.
