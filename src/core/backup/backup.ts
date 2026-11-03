/**
 * Backup, verification and restore.
 *
 * Design goals:
 *  - A backup is a *consistent* SQLite snapshot taken with `VACUUM INTO`,
 *    which is safe while the application is running (WAL included).
 *  - Every backup is hashed (SHA-256) and logged so tampering is detectable.
 *  - A restore never overwrites the live database without first validating the
 *    candidate file, checking schema compatibility, and taking a safety backup
 *    of the current data.
 *
 * Offline-first: backups are plain files the owner can copy to a pen drive,
 * another PC, or a cloud folder. No network is involved.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AppError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import type { Ctx } from '../kernel';
import { LATEST_SCHEMA_VERSION } from '../db/schema';
import { currentSchemaVersion } from '../db/migrator';
import { getBoolSetting, getNumberSetting, getSetting, setSetting } from '../services/settings';
import { recordAudit } from '../services/audit';

export type BackupKind = 'manual' | 'auto' | 'pre_restore' | 'pre_migration';

export interface BackupInfo {
  id: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  kind: BackupKind;
}

function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function sha256File(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

/**
 * Create a consistent backup of the live database.
 * Uses `VACUUM INTO`, which writes a fully checkpointed, defragmented copy.
 */
export function createBackup(
  ctx: Ctx,
  opts: { directory: string; kind?: BackupKind; label?: string },
): BackupInfo {
  const directory = opts.directory;
  if (!directory || directory.trim() === '') {
    throw new ValidationError('A backup folder is required', 'ব্যাকআপ ফোল্ডার নির্বাচন করুন।');
  }
  mkdirSync(directory, { recursive: true });
  const kind: BackupKind = opts.kind ?? 'manual';
  const unique = Math.random().toString(36).slice(2, 6);
  const file = join(
    resolve(directory),
    `merqo-backup-${timestampSlug()}-${unique}-${
      opts.label ? opts.label.replace(/[^\w-]+/g, '') + '-' : ''
    }${kind}.db`,
  );

  if (existsSync(file)) {
    // Overwrite: VACUUM INTO fails if the target exists.
    unlinkSync(file);
  }

  // VACUUM INTO requires a literal path; escape single quotes defensively.
  const escaped = file.replace(/'/g, "''");
  ctx.db.exec(`VACUUM INTO '${escaped}'`);

  const sizeBytes = statSync(file).size;
  const sha256 = sha256File(file);
  const id = newId();
  const at = ctx.clock.nowIso();

  ctx.db.run(
    `INSERT INTO backup_log (id, at, biz_date, kind, path, size_bytes, sha256, status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [id, at, ctx.clock.todayBizDate(), kind, file, sizeBytes, sha256, opts.label ?? null],
  );
  setSetting(ctx.db, 'backup.last_run', at, at);
  recordAudit(ctx, {
    action: 'backup.create',
    entity: 'backup',
    entityId: id,
    details: { path: file, sizeBytes, sha256, kind },
  });

  return { id, path: file, sizeBytes, sha256, createdAt: at, kind };
}

export interface BackupVerification {
  valid: boolean;
  path: string;
  sizeBytes: number;
  sha256: string;
  schemaVersion: number;
  appVersion: string | null;
  integrity: string;
  counts: Record<string, number>;
  errors: string[];
}

/**
 * Validate a backup file before it is trusted for restore:
 * real SQLite file, integrity check passes, schema is compatible, and the core
 * tables exist with plausible row counts.
 */
export async function verifyBackup(
  path: string,
  openFn: (file: string) => Promise<import('../db/driver').SqlDatabase>,
): Promise<BackupVerification> {
  const errors: string[] = [];
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new AppError(`Backup file not found: ${path}`, {
      code: 'BACKUP_INVALID',
      messageBn: 'ব্যাকআপ ফাইল পাওয়া যায়নি।',
    });
  }
  const sizeBytes = statSync(resolved).size;
  const sha256 = sha256File(resolved);
  let schemaVersion = 0;
  let appVersion: string | null = null;
  let integrity = 'unknown';
  const counts: Record<string, number> = {};

  let db: import('../db/driver').SqlDatabase;
  try {
    db = await openFn(resolved);
  } catch (err) {
    return {
      valid: false,
      path: resolved,
      sizeBytes,
      sha256,
      schemaVersion,
      appVersion,
      integrity: 'unreadable',
      counts,
      errors: [`File is not a readable SQLite database: ${(err as Error).message}`],
    };
  }
  try {
    const row = db.prepare('PRAGMA integrity_check').get<Record<string, unknown>>();
    integrity = row ? String(Object.values(row)[0]) : 'unknown';
    if (integrity !== 'ok') errors.push(`Integrity check failed: ${integrity}`);

    const hasMigrations = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get<{ name: string }>();
    if (!hasMigrations) {
      errors.push('Not a MERQO database: schema_migrations table is missing');
    } else {
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get<{ v: number }>();
      schemaVersion = v?.v ?? 0;
      if (schemaVersion > LATEST_SCHEMA_VERSION) {
        errors.push(
          `Backup schema v${schemaVersion} is newer than this application supports (v${LATEST_SCHEMA_VERSION})`,
        );
      }
    }

    try {
      const meta = db
        .prepare("SELECT value FROM app_meta WHERE key = 'app_version'")
        .get<{ value: string }>();
      appVersion = meta?.value ?? null;
    } catch {
      appVersion = null;
    }

    for (const table of ['products', 'customers', 'suppliers', 'sales_invoices', 'journal_entries']) {
      try {
        const c = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get<{ c: number }>();
        counts[table] = c?.c ?? 0;
      } catch {
        errors.push(`Table missing: ${table}`);
        counts[table] = -1;
      }
    }
  } finally {
    db.close();
  }

  return {
    valid: errors.length === 0,
    path: resolved,
    sizeBytes,
    sha256,
    schemaVersion,
    appVersion,
    integrity,
    counts,
    errors,
  };
}

export interface RestorePlan {
  backup: BackupVerification;
  safetyBackup: BackupInfo | null;
  targetPath: string;
}

/**
 * Prepare a restore: validate the candidate, take a safety copy of the current
 * database and return the plan. The caller (main process) must close the
 * database, call `applyRestore`, then restart the application.
 */
export async function prepareRestore(
  ctx: Ctx,
  opts: {
    backupPath: string;
    dbPath: string;
    backupDirectory: string;
    openFn: (file: string) => Promise<import('../db/driver').SqlDatabase>;
  },
): Promise<RestorePlan> {
  const verification = await verifyBackup(opts.backupPath, opts.openFn);
  if (!verification.valid) {
    throw new AppError(`Backup cannot be restored: ${verification.errors.join('; ')}`, {
      code: 'BACKUP_INVALID',
      messageBn: 'এই ব্যাকআপ ফাইল ব্যবহারযোগ্য নয়।',
      details: { errors: verification.errors },
    });
  }
  if (resolve(verification.path) === resolve(opts.dbPath)) {
    throw new AppError('The selected file is the live database', {
      code: 'BACKUP_INVALID',
      messageBn: 'নির্বাচিত ফাইলটি চলমান ডাটাবেস।',
    });
  }
  const safetyBackup = createBackup(ctx, {
    directory: opts.backupDirectory,
    kind: 'pre_restore',
    label: 'before-restore',
  });
  recordAudit(ctx, {
    action: 'restore.prepare',
    entity: 'backup',
    entityId: safetyBackup.id,
    severity: 'critical',
    details: { backupPath: verification.path, sha256: verification.sha256 },
  });
  return { backup: verification, safetyBackup, targetPath: opts.dbPath };
}

/**
 * Replace the live database file with the validated backup.
 * Must be executed with the database closed. WAL/SHM sidecars are removed so
 * the restored file becomes the single source of truth.
 */
export function applyRestore(plan: RestorePlan): void {
  const target = resolve(plan.targetPath);
  if (existsSync(target)) {
    copyFileSync(target, `${target}.replaced-${Date.now()}`);
  }
  copyFileSync(plan.backup.path, target);
  for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
    if (existsSync(sidecar)) {
      try {
        unlinkSync(sidecar);
      } catch {
        // sidecar may be locked; restore still succeeded
      }
    }
  }
}

export interface BackupLogRow {
  id: string;
  at: string;
  kind: BackupKind;
  path: string;
  size_bytes: number;
  sha256: string;
  status: 'success' | 'failed';
  note: string | null;
}

export function listBackups(ctx: Ctx, limit = 50): BackupLogRow[] {
  return ctx.db.all<BackupLogRow>(
    'SELECT * FROM backup_log ORDER BY at DESC LIMIT ?',
    [Math.min(limit, 500)],
  );
}

/** Delete oldest backups beyond the configured retention count. */
export function pruneBackups(ctx: Ctx, directory: string, keep?: number): { removed: string[] } {
  const retention = keep ?? getNumberSetting(ctx.db, 'backup.retention_count', 14);
  const rows = ctx.db.all<{ id: string; path: string }>(
    "SELECT id, path FROM backup_log WHERE status = 'success' AND kind IN ('auto','manual') ORDER BY at DESC",
  );
  const removed: string[] = [];
  const stale = rows.slice(retention);
  for (const row of stale) {
    try {
      if (existsSync(row.path) && resolve(row.path).startsWith(resolve(directory))) {
        unlinkSync(row.path);
        removed.push(row.path);
      }
      ctx.db.run('DELETE FROM backup_log WHERE id = ?', [row.id]);
    } catch {
      // A locked or already-missing file is not fatal.
    }
  }
  return { removed };
}

/**
 * Decide whether an automatic backup is due.
 * Called on application start and after every N completed sales.
 */
export function autoBackupDue(ctx: Ctx): { due: boolean; reason: string } {
  if (!getBoolSetting(ctx.db, 'backup.auto_enabled')) return { due: false, reason: 'disabled' };
  const location = getSetting(ctx.db, 'backup.location') ?? '';
  if (location.trim() === '') return { due: false, reason: 'no-location' };
  const frequency = getSetting(ctx.db, 'backup.frequency') ?? 'daily';
  if (frequency === 'manual') return { due: false, reason: 'manual' };

  const last = getSetting(ctx.db, 'backup.last_run') ?? '';
  if (!last) return { due: true, reason: 'never-run' };
  const lastDate = new Date(last).getTime();
  if (Number.isNaN(lastDate)) return { due: true, reason: 'invalid-timestamp' };
  const nowMs = new Date(ctx.clock.nowIso()).getTime();
  const hours = (nowMs - lastDate) / 3_600_000;
  const threshold = frequency === 'weekly' ? 24 * 7 : 24;
  return { due: hours >= threshold, reason: `elapsed-${hours.toFixed(1)}h` };
}

export function runAutoBackupIfDue(ctx: Ctx): BackupInfo | null {
  const check = autoBackupDue(ctx);
  if (!check.due) return null;
  const location = getSetting(ctx.db, 'backup.location');
  if (!location) return null;
  const info = createBackup(ctx, { directory: location, kind: 'auto' });
  pruneBackups(ctx, location);
  return info;
}

export function backupFileName(path: string): string {
  return basename(path);
}
