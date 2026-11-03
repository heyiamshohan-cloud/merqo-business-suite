import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db/context';
import { openDatabase } from '../src/core/db/driver';
import { bootstrapDatabase } from '../src/core/db/bootstrap';
import { createCtx } from '../src/core/kernel';
import { FixedClock } from '../src/core/foundation/clock';
import {
  applyRestore,
  autoBackupDue,
  createBackup,
  listBackups,
  prepareRestore,
  pruneBackups,
  verifyBackup,
} from '../src/core/backup/backup';
import { createProduct } from '../src/core/catalog/catalog';
import { createCustomer } from '../src/core/parties/parties';
import { stockIn } from '../src/core/inventory/stock';
import { createSale } from '../src/core/sales/sales';
import { updateSettings } from '../src/core/services/settings';

let dir: string;
let dbPath: string;
let db: Db;
let ctx: ReturnType<typeof createCtx>;
const clock = new FixedClock(new Date('2026-01-02T06:00:00.000Z'));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'merqo-backup-'));
  dbPath = join(dir, 'merqo.db');
  const raw = await openDatabase(dbPath);
  db = new Db(raw);
  bootstrapDatabase(db, { clock, appVersion: '1.0.0-test' });
  ctx = createCtx(db, { clock });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function seedBusinessData(): { productId: string; customerId: string; invoiceId: string } {
  const product = createProduct(ctx, {
    name: 'Rice 5kg',
    purchasePrice: 60000,
    salePrice: 100000,
  });
  stockIn(ctx, {
    productId: product.id,
    qty: 10_000,
    totalValue: 600000,
    movement: 'opening',
    refType: 'opening',
    reason: 'Opening',
  });
  const customer = createCustomer(ctx, { name: 'Karim Traders', phone: '01711111111' });
  const sale = createSale(ctx, {
    lines: [{ productId: product.id, qty: 2 }],
    customerId: customer.id,
    payments: [{ method: 'cash', amount: 150000 }],
  });
  return { productId: product.id, customerId: customer.id, invoiceId: sale.invoiceId };
}

describe('backup creation', () => {
  it('creates a consistent, hashed snapshot and logs it', () => {
    seedBusinessData();
    const backup = createBackup(ctx, { directory: join(dir, 'backups') });
    expect(existsSync(backup.path)).toBe(true);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);

    const logged = listBackups(ctx);
    expect(logged).toHaveLength(1);
    expect(logged[0].sha256).toBe(backup.sha256);
    expect(logged[0].kind).toBe('manual');
  });

  it('produces a database that can be opened independently', async () => {
    seedBusinessData();
    const backup = createBackup(ctx, { directory: join(dir, 'backups') });
    const verification = await verifyBackup(backup.path, (f) => openDatabase(f));
    expect(verification.valid).toBe(true);
    expect(verification.integrity).toBe('ok');
    expect(verification.counts.products).toBe(1);
    expect(verification.counts.sales_invoices).toBe(1);
    expect(verification.schemaVersion).toBe(1);
  });

  it('requires a destination folder', () => {
    expect(() => createBackup(ctx, { directory: '' })).toThrow();
  });
});

describe('backup verification', () => {
  it('reports a file that is not a database as invalid (no crash)', async () => {
    const bad = join(dir, 'not-a-db.db');
    writeFileSync(bad, 'this is definitely not sqlite');
    const result = await verifyBackup(bad, (f) => openDatabase(f));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a truncated / corrupted database', async () => {
    seedBusinessData();
    const backup = createBackup(ctx, { directory: join(dir, 'backups') });
    const bytes = readFileSync(backup.path);
    const truncated = join(dir, 'truncated.db');
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 3)));
    const result = await verifyBackup(truncated, (f) => openDatabase(f));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('detects a file whose hash changed after creation', async () => {
    seedBusinessData();
    const backup = createBackup(ctx, { directory: join(dir, 'backups') });
    const tampered = join(dir, 'tampered.db');
    const bytes = readFileSync(backup.path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
    writeFileSync(tampered, bytes);
    const original = await verifyBackup(backup.path, (f) => openDatabase(f));
    const modified = await verifyBackup(tampered, (f) => openDatabase(f));
    expect(original.sha256).not.toBe(modified.sha256);
  });
});

describe('restore workflow', () => {
  it('takes a safety backup and restores the chosen snapshot', async () => {
    const seeded = seedBusinessData();
    const backupDir = join(dir, 'backups');
    const goodBackup = createBackup(ctx, { directory: backupDir, label: 'good' });

    // Diverge: add another product after the backup.
    createProduct(ctx, { name: 'Later product', purchasePrice: 100, salePrice: 200 });
    expect(db.count('products')).toBe(2);

    const plan = await prepareRestore(ctx, {
      backupPath: goodBackup.path,
      dbPath,
      backupDirectory: backupDir,
      openFn: (f) => openDatabase(f),
    });
    expect(plan.backup.valid).toBe(true);
    expect(plan.safetyBackup?.sha256).toBeTruthy();
    expect(listBackups(ctx).some((b) => b.kind === 'pre_restore')).toBe(true);

    // Simulate the main process: close, replace files, reopen.
    db.close();
    applyRestore(plan);

    const reopened = new Db(await openDatabase(dbPath));
    const reopenedCtx = createCtx(reopened, { clock });
    expect(reopened.count('products')).toBe(1);
    expect(reopened.count('sales_invoices')).toBe(1);
    const sale = reopened.get<{ total: number; due: number }>(
      'SELECT total, due FROM sales_invoices WHERE id = ?',
      [seeded.invoiceId],
    );
    expect(sale?.total).toBe(200000);
    expect(sale?.due).toBe(50000);
    reopened.close();
  });

  it('refuses to restore an invalid file', async () => {
    seedBusinessData();
    const bad = join(dir, 'broken.db');
    writeFileSync(bad, 'nope');
    await expect(
      prepareRestore(ctx, {
        backupPath: bad,
        dbPath,
        backupDirectory: join(dir, 'backups'),
        openFn: (f) => openDatabase(f),
      }),
    ).rejects.toThrow();
  });

  it('refuses to restore the live database over itself', async () => {
    seedBusinessData();
    await expect(
      prepareRestore(ctx, {
        backupPath: dbPath,
        dbPath,
        backupDirectory: join(dir, 'backups'),
        openFn: (f) => openDatabase(f),
      }),
    ).rejects.toThrow();
  });
});

describe('retention and scheduling', () => {
  it('prunes backups beyond the retention count', () => {
    const backupDir = join(dir, 'backups');
    for (let i = 0; i < 5; i++) {
      createBackup(ctx, { directory: backupDir });
    }
    const before = listBackups(ctx).length;
    expect(before).toBe(5);
    const { removed } = pruneBackups(ctx, backupDir, 2);
    expect(removed.length).toBe(3);
    expect(listBackups(ctx).length).toBe(2);
  });

  it('reports when an automatic backup is due', () => {
    updateSettings(db, { 'backup.auto_enabled': true, 'backup.location': join(dir, 'auto') }, clock.nowIso());
    expect(autoBackupDue(ctx).due).toBe(true); // never run
    createBackup(ctx, { directory: join(dir, 'auto'), kind: 'auto' });
    expect(autoBackupDue(ctx).due).toBe(false); // just ran
    updateSettings(db, { 'backup.auto_enabled': false }, clock.nowIso());
    expect(autoBackupDue(ctx)).toEqual({ due: false, reason: 'disabled' });
  });
});
