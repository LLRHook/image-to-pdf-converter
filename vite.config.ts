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

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/. Override with BASE=/ for other hosts.
  base: process.env.BASE ?? './',
  plugins: [react(), assetSizes()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
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
