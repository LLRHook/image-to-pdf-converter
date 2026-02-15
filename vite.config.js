import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { cpSync, mkdirSync, existsSync } from 'fs';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'chrome-extension',
      writeBundle() {
        cpSync('manifest.json', 'dist/manifest.json');
        if (existsSync('public/icons')) {
          mkdirSync('dist/icons', { recursive: true });
          cpSync('public/icons', 'dist/icons', { recursive: true });
        }
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        offscreen: resolve(import.meta.dirname, 'offscreen.html'),
        'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.js'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'service-worker') {
            return 'service-worker.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
