/**
 * Bundles the Electron main process and the preload bridge with esbuild.
 *
 * Main is bundled to CommonJS (`dist/main/index.cjs`) because Electron loads a
 * CommonJS entry most reliably and `better-sqlite3` is a native CommonJS module.
 * `electron` and native modules stay external — they are provided by the runtime
 * or unpacked by electron-builder.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
  sourcemap: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

mkdirSync('dist/main', { recursive: true });
mkdirSync('dist/preload', { recursive: true });

await build({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.cjs',
});

await build({
  ...shared,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
});

console.log('main + preload bundled');
