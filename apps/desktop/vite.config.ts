import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const PDFJS_ROOT = fileURLToPath(new URL('./node_modules/pdfjs-dist', import.meta.url));
const PDFJS_ASSETS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

/**
 * Serves the files pdf.js fetches at runtime (CJK maps, standard fonts, decoders)
 * from `/pdfjs/`, same-origin as the CSP requires. pdf.js asks for them by name, so
 * they cannot go through the bundler.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'synapseread:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const relative = decodeURIComponent((request.url ?? '').split('?')[0] ?? '');
        const file = resolve(PDFJS_ROOT, `.${relative}`);
        const inAssets = PDFJS_ASSETS.some((name) => file.startsWith(resolve(PDFJS_ROOT, name)));
        if (!inAssets || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        createReadStream(file).pipe(response);
      });
    },
    writeBundle({ dir }) {
      for (const name of PDFJS_ASSETS) {
        cpSync(resolve(PDFJS_ROOT, name), resolve(dir as string, 'pdfjs', name), {
          recursive: true,
        });
      }
    },
  };
}

// Tauri expects a fixed dev port and needs its own CLI output left on screen.
export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  clearScreen: false,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
    // The browser preview loads its sample documents from `fixtures/`.
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'safari16',
    // Assets load from disk, not the network, so large chunks carry little cost.
    chunkSizeWarningLimit: 4096,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
