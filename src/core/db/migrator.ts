/**
 * Migration runner.
 *
 * - Tracks applied versions in `schema_migrations` with a SHA-256 checksum of
 *   the migration SQL. A checksum mismatch means an already-applied migration
 *   was edited in place — that is a hard error, because silently changing
 *   history could corrupt existing business databases.
 * - Applies pending migrations one at a time inside a transaction.
 * - Optionally invokes a backup hook before the first pending migration so a
 *   power failure or crash mid-upgrade can never leave a customer without a
 *   recoverable copy of their data.
 * - Never drops or rewrites user data.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../foundation/errors';
import type { Db } from './context';
import { MIGRATIONS, type Migration } from './schema';

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

export interface MigrationOptions {
  /** Called once before the first pending migration is applied. */
  beforeMigration?: (from: number, to: number) => void;
  now?: () => string;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function ensureMigrationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function currentSchemaVersion(db: Db): number {
  ensureMigrationTable(db);
  const row = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  return row?.v ?? 0;
}

export function appliedMigrations(db: Db): MigrationRecord[] {
  ensureMigrationTable(db);
  return db.all<MigrationRecord>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
  );
}

export function runMigrations(db: Db, opts: MigrationOptions = {}): MigrationResult {
  ensureMigrationTable(db);
  const now = opts.now ?? (() => new Date().toISOString());
  const applied = appliedMigrations(db);
  const appliedByVersion = new Map(applied.map((m) => [m.version, m]));

  // Verify history integrity before touching anything.
  for (const migration of MIGRATIONS) {
    const record = appliedByVersion.get(migration.version);
    if (!record) continue;
    const expected = checksumOf(migration.sql);
    if (record.checksum !== expected) {
      throw new AppError(
        `Migration ${migration.version} (${migration.name}) has been modified after it was applied. ` +
          'Applied migrations must never change.',
        {
          code: 'MIGRATION_FAILED',
          messageBn:
            'ডাটাবেস মাইগ্রেশন ইতিহাসে অসঙ্গতি পাওয়া গেছে। সহায়তার জন্য যোগাযোগ করুন।',
          details: { version: migration.version, applied: record.checksum, current: expected },
        },
      );
    }
  }

  const fromVersion = applied.length > 0 ? applied[applied.length - 1].version : 0;
  const pending = MIGRATIONS.filter((m) => !appliedByVersion.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );

  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [] };
  }

  // Refuse to "upgrade" a database that is newer than this build understands.
  const knownMax = Math.max(...MIGRATIONS.map((m) => m.version));
  if (fromVersion > knownMax) {
    throw new AppError(
      `This database schema (v${fromVersion}) is newer than this application supports (v${knownMax}).`,
      {
        code: 'MIGRATION_FAILED',
        messageBn:
          'এই ডাটাবেস নতুন সংস্করণের। অনুগ্রহ করে অ্যাপ্লিকেশনের সর্বশেষ সংস্করণ ব্যবহার করুন।',
        details: { databaseVersion: fromVersion, supportedVersion: knownMax },
      },
    );
  }

  if (opts.beforeMigration) {
    opts.beforeMigration(fromVersion, pending[pending.length - 1].version);
  }

  const appliedNow: number[] = [];
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [migration.version, migration.name, checksumOf(migration.sql), now()],
      );
      appliedNow.push(migration.version);
    });
  }

  return {
    fromVersion,
    toVersion: appliedNow[appliedNow.length - 1] ?? fromVersion,
    applied: appliedNow,
  };
}

export function migrationStatus(db: Db): {
  current: number;
  latest: number;
  pending: Migration[];
} {
  const current = currentSchemaVersion(db);
  return {
    current,
    latest: Math.max(...MIGRATIONS.map((m) => m.version)),
    pending: MIGRATIONS.filter((m) => m.version > current),
  };
}
