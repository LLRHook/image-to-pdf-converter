/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Writes dist/asset-sizes.json: the exact (decompressed) byte size of every
 * emitted asset. Engine downloads read it so the loading screen can show true
 * percentages even when the host gzips responses.
 */
function assetSizes(): Plugin {
  let outDir = 'dist';
  return {
    name: 'asset-sizes',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      // Walk the finished output (main + worker bundles + copied public files).
      const sizes: Record<string, number> = {};
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          const s = statSync(p);
          if (s.isDirectory()) walk(p);
          else if (!p.endsWith('.map')) sizes[relative(outDir, p).split(sep).join('/')] = s.size;
        }
      };
      walk(outDir);
      writeFileSync(join(outDir, 'asset-sizes.json'), JSON.stringify(sizes));
    },
  };
}

/**
 * Content-Security-Policy for the built page (dev needs inline scripts for
 * HMR, so this is build-only). connect-src 'self' is the key line: the page
 * cannot send anything anywhere except this site, and only GETs of its own
 * files happen in practice.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

const BUILD_ID = process.env.GITHUB_SHA?.slice(0, 12) ?? Date.now().toString(36);

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // GitHub Pages serves the site from /<repo>/. Override with BASE=/ for other hosts.
  base: process.env.BASE ?? './',
  plugins: [react(), csp(), assetSizes()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Pre-bundle up front so the first dev run doesn't reload mid-conversion.
    include: ['mediabunny', '@mediabunny/mp3-encoder', '@mediabunny/flac-encoder', '@mediabunny/aac-encoder'],
    // These ship their own workers / wasm loaders that break when pre-bundled.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core', '@imagemagick/magick-wasm', 'mupdf', 'pandoc-wasm'],
  },
  build: {
    target: 'es2023',
    assetsInlineLimit: 0, // never inline wasm/fonts as data: URLs
    chunkSizeWarningLimit: 4096,
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
