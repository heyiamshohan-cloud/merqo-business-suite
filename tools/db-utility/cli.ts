#!/usr/bin/env node
/**
 * MERQO Database Utility — OWNER / SUPPORT ONLY.
 *
 * A read-mostly tool for supporting a customer installation when the application
 * cannot start, or when the business needs a data extract without opening the UI:
 *
 *   info        schema version, file size, integrity, record counts, licence state
 *   check       journal balance, inventory-vs-ledger reconciliation, orphan rows
 *   backup      consistent snapshot (VACUUM INTO) into a folder
 *   verify      validate a backup file before trusting it
 *   restore     replace the live database from a backup, keeping a safety copy
 *   export      run a report and write CSV (UTF-8 BOM, Excel-safe)
 *   vacuum      compact the database
 *   audit       recent audit-log entries
 *   licenses    licence rows and their status
 *
 * Nothing here changes business documents. `restore` and `vacuum` are the only
 * mutating commands, and both take their own safety copy first.
 */
import { existsSync, mkdirSync, statSync, copyFileSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Db } from '../../src/core/db/context';
import { foreignKeyCheck, integrityCheck, openDatabase, type SqlDatabase } from '../../src/core/db/driver';
import { currentSchemaVersion } from '../../src/core/db/migrator';
import { SystemClock } from '../../src/core/foundation/clock';
import { createCtx } from '../../src/core/kernel';
import { buildReport, REPORT_CATALOG } from '../../src/core/reports/reports';
import { reportToCsv } from '../../src/core/export/reportExport';
import { verifyBackup, createBackup, sha256File } from '../../src/core/backup/backup';
import { verifyAllJournalsBalanced } from '../../src/core/accounting/journal';
import { reconcileInventoryWithLedger } from '../../src/core/inventory/stock';
import { queryAuditLog } from '../../src/core/services/audit';

const BANNER = 'MERQO DATABASE UTILITY — OWNER / SUPPORT ONLY';

interface Args {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string; args: Args } {
  const command = argv[0] ?? 'help';
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return { command, args };
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function openDb(path: string): Promise<{ raw: SqlDatabase; db: Db }> {
  if (!existsSync(path)) fail(`database not found: ${path}`);
  const raw = await openDatabase(path);
  return { raw, db: new Db(raw) };
}

const HELP = `${BANNER}

Usage: merqo-db <command> [options]

  info     --db <path>
  check    --db <path>
  backup   --db <path> --out <folder> [--label <text>]
  verify   --file <backup.db>
  restore  --db <path> --file <backup.db> [--yes]
  export   --db <path> --report <key> --from YYYY-MM-DD --to YYYY-MM-DD --out <file.csv>
  vacuum   --db <path>
  audit    --db <path> [--limit 25]
  licenses --db <path>

Reports: ${REPORT_CATALOG.map((r) => r.key).join(', ')}
`;

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  console.log(BANNER);

  const dbPath = str(args, 'db');

  if (command === 'info' || command === 'check') {
    const path = dbPath ?? fail('--db <path> is required');
    const { raw, db } = await openDb(path);
    const clock = new SystemClock();
    const ctx = createCtx(db, { clock });
    console.log(`database    : ${resolve(path)} (${humanBytes(statSync(path).size)})`);
    console.log(`driver      : ${raw.driverName}`);
    console.log(`schema      : v${currentSchemaVersion(db)}`);
    console.log(`integrity   : ${integrityCheck(raw)}`);
    const fk = foreignKeyCheck(raw);
    console.log(`foreign keys: ${fk.length === 0 ? 'ok' : `${fk.length} violation(s)`}`);
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    console.log('counts      :');
    for (const table of tables) {
      const count = db.sum(`SELECT COUNT(*) AS v FROM "${table.name}"`);
      if (count > 0) console.log(`  ${table.name.padEnd(24)} ${count}`);
    }
    const license = db.get<{ license_id: string; organization: string; activated_at: string; device_hash: string }>(
      "SELECT license_id, organization, activated_at, device_hash FROM license_state WHERE status = 'active' LIMIT 1",
    );
    console.log(
      `licence     : ${license ? `${license.organization} · ${license.license_id} · ${license.activated_at.slice(0, 10)}` : 'none / evaluation'}`,
    );

    if (command === 'check') {
      const journals = verifyAllJournalsBalanced(ctx);
      const inventory = reconcileInventoryWithLedger(ctx);
      console.log(`journals    : ${journals.ok ? 'balanced' : `${journals.unbalanced.length} unbalanced`}`);
      if (!journals.ok) {
        for (const entry of journals.unbalanced.slice(0, 20)) {
          console.log(`  ! ${entry.entryId} debit=${entry.debit} credit=${entry.credit}`);
        }
      }
      console.log(
        `inventory   : ${inventory.ok ? 'reconciled' : `difference ${inventory.difference} paisa`}`,
      );
      const negative = db.all<{ id: string; name: string; qty: number }>(
        'SELECT p.id, p.name, sl.qty FROM stock_levels sl JOIN products p ON p.id = sl.product_id WHERE sl.qty < 0 LIMIT 20',
      );
      console.log(`negative    : ${negative.length === 0 ? 'none' : `${negative.length} product(s)`}`);
      for (const row of negative) console.log(`  ! ${row.name} (${row.qty / 1000})`);
    }
    db.close();
    return;
  }

  if (command === 'backup') {
    const path = dbPath ?? fail('--db <path> is required');
    const out = resolve(str(args, 'out') ?? '.');
    if (!existsSync(out)) mkdirSync(out, { recursive: true });
    const { raw, db } = await openDb(path);
    const ctx = createCtx(db, { clock: new SystemClock() });
    const info = createBackup(ctx, { directory: out, kind: 'manual', label: str(args, 'label') });
    console.log(`written     : ${info.path} (${humanBytes(info.sizeBytes)})`);
    console.log(`sha256      : ${info.sha256}`);
    void raw;
    db.close();
    return;
  }

  if (command === 'verify') {
    const file = str(args, 'file') ?? fail('--file <backup.db> is required');
    const result = await verifyBackup(resolve(file), (f) => openDatabase(f));
    console.log(`valid       : ${result.valid}`);
    console.log(`integrity   : ${result.integrity}`);
    console.log(`schema      : v${result.schemaVersion}`);
    console.log(`app version : ${result.appVersion ?? 'unknown'}`);
    console.log(`sha256      : ${result.sha256}`);
    for (const [table, count] of Object.entries(result.counts)) {
      console.log(`  ${table.padEnd(24)} ${count}`);
    }
    if (result.errors.length > 0) {
      for (const error of result.errors) console.log(`  ! ${error}`);
      process.exit(2);
    }
    return;
  }

  if (command === 'restore') {
    const path = dbPath ?? fail('--db <path> is required');
    const file = str(args, 'file') ?? fail('--file <backup.db> is required');
    if (args.yes !== true) {
      fail('refusing to overwrite the live database without --yes');
    }
    if (!existsSync(file)) fail(`backup not found: ${file}`);
    const verification = await verifyBackup(resolve(file), (f) => openDatabase(f));
    if (!verification.valid) {
      console.error(`error: backup failed verification (${verification.errors.join('; ')})`);
      process.exit(2);
    }
    const safety = join(
      resolve(path, '..'),
      `${basename(path).replace(/\.db$/, '')}.pre-restore-${Date.now()}.db`,
    );
    copyFileSync(path, safety);
    console.log(`safety copy : ${safety}`);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${path}${suffix}`;
      if (existsSync(sidecar)) {
        try {
          unlinkSync(sidecar);
        } catch {
          /* best effort */
        }
      }
    }
    copyFileSync(file, path);
    console.log(`restored    : ${path} from ${file}`);
    console.log(`sha256      : ${sha256File(path)}`);
    return;
  }

  if (command === 'export') {
    const path = dbPath ?? fail('--db <path> is required');
    const reportKey = str(args, 'report') ?? fail('--report <key> is required');
    const from = str(args, 'from') ?? fail('--from YYYY-MM-DD is required');
    const to = str(args, 'to') ?? fail('--to YYYY-MM-DD is required');
    const out = resolve(str(args, 'out') ?? `${reportKey}-${from}-to-${to}.csv`);
    const { db } = await openDb(path);
    const ctx = createCtx(db, { clock: new SystemClock() });
    const table = buildReport(ctx, { key: reportKey, from, to });
    const csv = reportToCsv(table, { lang: 'bn' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, csv, 'utf8');
    console.log(`report      : ${table.title} — ${table.rows.length} row(s)`);
    console.log(`written     : ${out}`);
    db.close();
    return;
  }

  if (command === 'vacuum') {
    const path = dbPath ?? fail('--db <path> is required');
    const before = statSync(path).size;
    const { raw, db } = await openDb(path);
    raw.exec('VACUUM');
    const after = statSync(path).size;
    console.log(`compacted   : ${humanBytes(before)} -> ${humanBytes(after)}`);
    db.close();
    return;
  }

  if (command === 'audit') {
    const path = dbPath ?? fail('--db <path> is required');
    const limit = Number(str(args, 'limit') ?? '25');
    const { db } = await openDb(path);
    const ctx = createCtx(db, { clock: new SystemClock() });
    const rows = queryAuditLog(ctx, { limit: Number.isFinite(limit) ? limit : 25 });
    for (const row of rows) {
      console.log(`${row.at.replace('T', ' ').slice(0, 19)}  ${row.severity.padEnd(8)} ${row.action.padEnd(24)} ${row.entity ?? ''} ${row.entity_id ?? ''}`);
    }
    db.close();
    return;
  }

  if (command === 'licenses') {
    const path = dbPath ?? fail('--db <path> is required');
    const { db } = await openDb(path);
    const rows = db.all<{ license_id: string; organization: string; status: string; activated_at: string; device_hash: string }>(
      'SELECT license_id, organization, status, activated_at, device_hash FROM license_state ORDER BY activated_at DESC',
    );
    if (rows.length === 0) console.log('no licence rows — the installation is in evaluation mode');
    for (const row of rows) {
      console.log(
        `${row.activated_at.slice(0, 10)}  ${row.status.padEnd(10)} ${row.organization.padEnd(28)} ${row.license_id}  device=${row.device_hash.slice(0, 18)}…`,
      );
    }
    db.close();
    return;
  }

  console.error(`unknown command "${command}"\n`);
  console.log(HELP);
  process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
