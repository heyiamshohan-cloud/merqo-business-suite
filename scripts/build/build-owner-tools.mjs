/**
 * Builds the two owner-only utilities.
 *
 * Step 1 (any OS): bundle each CLI to a self-contained CommonJS file in
 *   `dist/tools/`. These run with any Node 20+ runtime and are what the owner
 *   uses during development.
 *
 * Step 2 (Windows only): embed each bundle into a single executable with the
 *   Node SEA pipeline, producing genuine Windows .exe files:
 *     MERQO-License-Generator.exe  — OWNER ONLY, requires the private key file
 *     MERQO-DB-Utility.exe         — OWNER/SUPPORT ONLY, read-mostly admin tool
 *
 * SEA binaries are NOT produced on Linux/macOS on purpose: a Linux binary is not
 * a Windows executable, and shipping one renamed as `.exe` would be a lie.
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT_DIR = resolve('dist/tools');
mkdirSync(OUT_DIR, { recursive: true });

const SHARED = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['better-sqlite3'],
  logLevel: 'info',
  sourcemap: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const TOOLS = [
  { name: 'license-generator', entry: 'tools/license-generator/cli.ts', exe: 'MERQO-License-Generator' },
  { name: 'db-utility', entry: 'tools/db-utility/cli.ts', exe: 'MERQO-DB-Utility' },
];

for (const tool of TOOLS) {
  await build({ ...SHARED, entryPoints: [tool.entry], outfile: join(OUT_DIR, `${tool.name}.cjs`) });
}

console.log('owner tools bundled -> dist/tools/*.cjs');

if (process.platform !== 'win32') {
  console.log(
    'Skipping Windows .exe generation: the SEA pipeline must run on Windows (CI win32 job).',
  );
  process.exit(0);
}

for (const tool of TOOLS) {
  const bundlePath = join(OUT_DIR, `${tool.name}.cjs`);
  const blobPath = join(OUT_DIR, `${tool.name}.blob`);
  const exePath = join(OUT_DIR, `${tool.exe}.exe`);
  const seaConfig = join(OUT_DIR, `${tool.name}.sea.json`);

  writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    ),
  );

  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

  copyFileSync(process.execPath, exePath);
  const { inject } = await import('postject');
  await inject(exePath, 'NODE_SEA_BLOB', readFileSync(blobPath), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  for (const leftover of [blobPath, seaConfig]) {
    if (existsSync(leftover)) rmSync(leftover);
  }
  console.log(`created ${exePath}`);
}
