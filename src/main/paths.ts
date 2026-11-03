/**
 * File-system layout.
 *
 * Business data, logs, backups and licence material live under the Windows
 * per-user application data folder — never inside the installation directory —
 * so uninstalling or upgrading the application can never delete a shop's
 * records.
 */
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AppPaths {
  userData: string;
  dataDir: string;
  databasePath: string;
  backupDir: string;
  logDir: string;
  licenseDir: string;
  exportDir: string;
  tempDir: string;
}

let cached: AppPaths | null = null;

export function resolvePaths(): AppPaths {
  if (cached) return cached;
  const userData = app.getPath('userData');
  const dataDir = join(userData, 'data');
  const paths: AppPaths = {
    userData,
    dataDir,
    databasePath: join(dataDir, 'merqo.db'),
    backupDir: join(userData, 'backups'),
    logDir: join(userData, 'logs'),
    licenseDir: join(userData, 'license'),
    exportDir: join(app.getPath('documents'), 'MERQO Exports'),
    tempDir: join(userData, 'temp'),
  };
  for (const dir of [
    paths.dataDir,
    paths.backupDir,
    paths.logDir,
    paths.licenseDir,
    paths.tempDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  cached = paths;
  return paths;
}

export function resetPathsCache(): void {
  cached = null;
}
