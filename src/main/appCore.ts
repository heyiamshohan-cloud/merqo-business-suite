/**
 * Application core container for the Electron main process.
 *
 * Owns the single database connection (SQLite allows one writer; keeping the
 * handle exclusively in the main process is what makes the transaction model
 * sound), the operator context, the logger and the device identity.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../core/db/context';
import { integrityCheck, openDatabase, foreignKeyCheck } from '../core/db/driver';
import { bootstrapDatabase } from '../core/db/bootstrap';
import { currentSchemaVersion } from '../core/db/migrator';
import { SystemClock } from '../core/foundation/clock';
import { createCtx, type Ctx } from '../core/kernel';
import { getSetting, updateSettings } from '../core/services/settings';
import { recordAudit } from '../core/services/audit';
import { licenseStatus, type LicenseStatus } from '../core/licensing/license';
import {
  EMBEDDED_PUBLIC_KEY_PEM,
  EMBEDDED_KEY_FINGERPRINT,
  IS_DEVELOPMENT_KEY,
} from '../core/licensing/publicKey';
import { runAutoBackupIfDue } from '../core/backup/backup';
import {
  assertOperatingAllowed,
  evaluationState,
  startEvaluationIfNeeded,
  type EvaluationState,
} from '../core/licensing/enforcement';
import type { AppPaths } from './paths';
import { collectDeviceIdentity, type DeviceIdentity } from './device';
import { Logger } from './logger';

export interface StartupReport {
  databasePath: string;
  schemaVersion: number;
  integrity: string;
  foreignKeyViolations: number;
  migratedFrom: number;
  migratedTo: number;
  autoBackupPath: string | null;
  developmentKey: boolean;
}

export class MerqoAppCore {
  db: Db | null = null;
  ctx: Ctx | null = null;
  readonly clock = new SystemClock();
  readonly device: DeviceIdentity;
  readonly log: Logger;
  startup: StartupReport | null = null;
  private userId: string | null = null;

  constructor(
    readonly paths: AppPaths,
    readonly appVersion: string,
  ) {
    this.log = new Logger(paths.logDir);
    this.device = collectDeviceIdentity();
  }

  get publicKeyPem(): string {
    return EMBEDDED_PUBLIC_KEY_PEM;
  }

  get keyFingerprint(): string {
    return EMBEDDED_KEY_FINGERPRINT;
  }

  get isDevelopmentKey(): boolean {
    return IS_DEVELOPMENT_KEY;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Open the database, run migrations (with a pre-migration backup) and seed. */
  async init(): Promise<StartupReport> {
    const dbPath = this.paths.databasePath;
    this.log.info('Opening database', { path: dbPath, appVersion: this.appVersion });

    const raw = await openDatabase(dbPath);
    this.db = new Db(raw);

    const integrity = integrityCheck(raw);
    if (integrity !== 'ok') {
      this.log.error('Database integrity check failed', { integrity });
      // Preserve the damaged file for support; never silently overwrite it.
      if (existsSync(dbPath)) {
        const quarantine = `${dbPath}.corrupt-${Date.now()}`;
        try {
          copyFileSync(dbPath, quarantine);
          this.log.warn('Damaged database copied aside', { path: quarantine });
        } catch (err) {
          this.log.warn('Could not copy damaged database aside', { error: String(err) });
        }
      }
    }

    const before = currentSchemaVersion(this.db);
    const result = bootstrapDatabase(this.db, {
      clock: this.clock,
      appVersion: this.appVersion,
      beforeMigration: () => {
        // Snapshot before any schema upgrade so a failed upgrade is recoverable.
        const target = join(this.paths.backupDir, `merqo-premigration-v${before}-${Date.now()}.db`);
        try {
          this.db?.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
          this.log.info('Pre-migration backup created', { path: target });
        } catch (err) {
          this.log.warn('Pre-migration backup failed', { error: String(err) });
        }
      },
    });

    this.ctx = createCtx(this.db, { clock: this.clock, userId: this.userId });
    this.resolveOperator();

    const fk = foreignKeyCheck(raw);

    let autoBackupPath: string | null = null;
    try {
      const backup = runAutoBackupIfDue(this.ctx);
      autoBackupPath = backup?.path ?? null;
    } catch (err) {
      this.log.warn('Automatic backup failed', { error: String(err) });
    }

    startEvaluationIfNeeded(this.ctx, this.license());

    recordAudit(this.ctx, {
      action: 'app.start',
      entity: 'system',
      details: { appVersion: this.appVersion, schema: result.toVersion, device: this.device.summary },
    });

    this.startup = {
      databasePath: dbPath,
      schemaVersion: result.toVersion,
      integrity,
      foreignKeyViolations: fk.length,
      migratedFrom: result.fromVersion,
      migratedTo: result.toVersion,
      autoBackupPath,
      developmentKey: IS_DEVELOPMENT_KEY,
    };
    this.log.info('Database ready', { ...this.startup } as unknown as Record<string, unknown>);
    return this.startup;
  }

  /** Bind the operator identity used for the audit trail. */
  resolveOperator(): void {
    if (!this.db) return;
    if (this.userId) {
      const exists = this.db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [this.userId]);
      if (exists) return;
    }
    const owner = this.db.get<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
    this.userId = owner?.id ?? null;
    if (this.ctx) this.ctx = { ...this.ctx, userId: this.userId };
  }

  requireCtx(): Ctx {
    if (!this.ctx) throw new Error('Application core is not initialised');
    return this.ctx;
  }

  requireDb(): Db {
    if (!this.db) throw new Error('Database is not open');
    return this.db;
  }

  license(): LicenseStatus {
    return licenseStatus(this.requireCtx(), {
      publicKeyPem: this.publicKeyPem,
      deviceHash: this.device.fingerprint,
    });
  }

  /** Begin the 14-day evaluation window on first run (no-op once licensed). */
  startEvaluation(): void {
    startEvaluationIfNeeded(this.requireCtx(), this.license());
  }

  evaluation(): EvaluationState {
    return evaluationState(this.requireCtx(), this.license());
  }

  /** Throws when the evaluation has expired and no licence is active. */
  assertOperatingAllowed(): EvaluationState {
    return assertOperatingAllowed(this.requireCtx(), this.license());
  }

  language(): 'bn' | 'en' {
    const v = getSetting(this.requireDb(), 'app.language');
    return v === 'en' ? 'en' : 'bn';
  }

  setLanguage(lang: 'bn' | 'en'): void {
    updateSettings(this.requireDb(), { 'app.language': lang }, this.clock.nowIso());
  }

  async close(): Promise<void> {
    if (this.ctx) {
      try {
        recordAudit(this.ctx, { action: 'app.stop', entity: 'system' });
      } catch {
        // ignore
      }
    }
    this.db?.close();
    this.db = null;
    this.ctx = null;
  }
}
