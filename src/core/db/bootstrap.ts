/**
 * Database bootstrap: migrations + first-run seed data.
 *
 * Idempotent by design — safe to call on every application start.
 */
import {
  CHART_OF_ACCOUNTS,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_UNITS,
} from '../accounting/accounts';
import { newId } from '../foundation/ids';
import type { Clock } from '../foundation/clock';
import { SystemClock } from '../foundation/clock';
import { runMigrations } from './migrator';
import type { Db } from './context';
import { DEFAULT_SETTINGS, setSetting } from '../services/settings';

export interface BootstrapOptions {
  clock?: Clock;
  beforeMigration?: (from: number, to: number) => void;
  /** Version string of the running application, stored in app_meta. */
  appVersion?: string;
}

export interface BootstrapResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
  seeded: boolean;
}

export function bootstrapDatabase(db: Db, opts: BootstrapOptions = {}): BootstrapResult {
  const clock = opts.clock ?? new SystemClock();
  const now = clock.nowIso();

  const migration = runMigrations(db, {
    beforeMigration: opts.beforeMigration,
    now: () => now,
  });

  const seededFlag = db.get<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'seeded'",
  );
  if (seededFlag?.value === '1') {
    if (opts.appVersion) {
      db.run(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['app_version', opts.appVersion],
      );
    }
    return { ...migration, seeded: false };
  }

  db.transaction(() => {
    seedChartOfAccounts(db, now);
    seedUnits(db, now);
    seedExpenseCategories(db, now);
    seedDefaultSettings(db, now);
    seedSequences(db, now);
    seedSystemUser(db, now);
    db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['seeded', '1']);
    db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['installed_at', now]);
    if (opts.appVersion) {
      db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['app_version', opts.appVersion]);
    }
  });

  return { ...migration, seeded: true };
}

export function seedChartOfAccounts(db: Db, now: string): void {
  for (const def of CHART_OF_ACCOUNTS) {
    const existing = db.get<{ id: string }>('SELECT id FROM accounts WHERE code = ?', [def.code]);
    if (existing) continue;
    db.run(
      `INSERT INTO accounts (id, code, name, name_bn, type, subtype, parent_id, is_system, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, ?)`,
      [newId(), def.code, def.name, def.nameBn, def.type, def.subtype ?? null, def.isSystem ? 1 : 0, now],
    );
  }
}

export function seedUnits(db: Db, now: string): void {
  for (const unit of DEFAULT_UNITS) {
    const existing = db.get<{ id: string }>('SELECT id FROM units WHERE short_name = ?', [
      unit.shortName,
    ]);
    if (existing) continue;
    db.run(
      `INSERT INTO units (id, name, name_bn, short_name, allow_decimal, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId(), unit.name, unit.nameBn, unit.shortName, unit.allowDecimal ? 1 : 0, now],
    );
  }
}

export function seedExpenseCategories(db: Db, now: string): void {
  for (const cat of DEFAULT_EXPENSE_CATEGORIES) {
    const existing = db.get<{ id: string }>(
      'SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE',
      [cat.name],
    );
    if (existing) continue;
    const account = db.get<{ id: string }>('SELECT id FROM accounts WHERE code = ?', [
      cat.accountCode,
    ]);
    if (!account) continue;
    db.run(
      `INSERT INTO expense_categories (id, name, name_bn, account_id, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [newId(), cat.name, cat.nameBn, account.id, now],
    );
  }
}

export function seedDefaultSettings(db: Db, now: string): void {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = db.get<{ key: string }>('SELECT key FROM settings WHERE key = ?', [key]);
    if (existing) continue;
    setSetting(db, key, value, now);
  }
}

export function seedSequences(db: Db, now: string): void {
  void now;
  const defaults: Array<[string, string, number]> = [
    ['invoice', 'INV-', 6],
    ['purchase', 'PUR-', 6],
    ['receipt', 'RCP-', 6],
    ['payment', 'PAY-', 6],
    ['expense', 'EXP-', 6],
    ['sales_return', 'SR-', 6],
    ['purchase_return', 'PR-', 6],
    ['journal', 'JV-', 6],
    ['customer', 'CUS-', 5],
    ['supplier', 'SUP-', 5],
    ['product', 'SKU-', 6],
  ];
  for (const [key, prefix, padding] of defaults) {
    const existing = db.get<{ key: string }>('SELECT key FROM document_sequences WHERE key = ?', [
      key,
    ]);
    if (existing) continue;
    db.run(
      'INSERT INTO document_sequences (key, prefix, next_value, padding) VALUES (?, ?, 1, ?)',
      [key, prefix, padding],
    );
  }
}

export function seedSystemUser(db: Db, now: string): void {
  const existing = db.get<{ id: string }>('SELECT id FROM users LIMIT 1');
  if (existing) return;
  db.run(
    `INSERT INTO users (id, username, full_name, role, password_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    [newId(), 'owner', 'Business Owner', 'owner', now, now],
  );
}
