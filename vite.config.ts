/**
 * Renderer build (Vite).
 *
 * The renderer is a plain single-page app with no Node access: everything it
 * needs arrives through the preload bridge. `base: './'` keeps asset URLs
 * relative so the same build works from `file://` inside the packaged app.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(rootDir, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(rootDir, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
  },
});
