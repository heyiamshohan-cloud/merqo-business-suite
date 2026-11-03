/**
 * SQLite driver abstraction.
 *
 * Two drivers are supported behind one narrow, synchronous interface:
 *
 *  1. `better-sqlite3` — used by the packaged Windows application (Electron
 *     main process). Fastest mature synchronous driver, bundled at build time.
 *  2. `node:sqlite` — built into Node >= 22, used for the automated test suite
 *     and headless tooling so the business core can be executed and verified
 *     without any native compilation step.
 *
 * Both are SQLite 3.x with identical SQL semantics; the core only ever uses
 * the small surface defined below (exec / prepare / all / get / run), which
 * keeps the two drivers behaviourally interchangeable.
 */
import { createRequire } from 'node:module';

export type SqlParam = string | number | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlStatement {
  all<T = Record<string, unknown>>(...params: SqlParam[]): T[];
  get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined;
  run(...params: SqlParam[]): RunResult;
}

export interface SqlDatabase {
  readonly driverName: 'better-sqlite3' | 'node:sqlite';
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
  /** True when the database file is in-memory (tests). */
  readonly inMemory: boolean;
}

export interface OpenOptions {
  readonly?: boolean;
  /** Skip durability pragmas (used for throwaway in-memory databases). */
  fastPragmas?: boolean;
}

function normalizeParams(params: unknown[]): SqlParam[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'number') {
      if (!Number.isFinite(p)) throw new Error(`Non-finite SQL parameter: ${p}`);
      return p;
    }
    if (typeof p === 'string') return p;
    if (typeof p === 'object') return JSON.stringify(p);
    return String(p);
  });
}

interface BetterSqliteStatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface BetterSqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatementLike;
  close(): void;
  pragma?(sql: string): unknown;
}

interface NodeSqliteStatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface NodeSqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatementLike;
  close(): void;
}

function wrapBetterSqlite(raw: BetterSqliteDatabaseLike, inMemory: boolean): SqlDatabase {
  const cache = new Map<string, SqlStatement>();
  return {
    driverName: 'better-sqlite3',
    inMemory,
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const cached = cache.get(sql);
      if (cached) return cached;
      const stmt = raw.prepare(sql);
      const wrapped: SqlStatement = {
        all: <T>(...params: SqlParam[]) => stmt.all(...normalizeParams(params)) as T[],
        get: <T>(...params: SqlParam[]) => stmt.get(...normalizeParams(params)) as T | undefined,
        run: (...params: SqlParam[]) => {
          const r = stmt.run(...normalizeParams(params));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
      cache.set(sql, wrapped);
      return wrapped;
    },
    close: () => raw.close(),
  };
}

function wrapNodeSqlite(raw: NodeSqliteDatabaseLike, inMemory: boolean): SqlDatabase {
  const cache = new Map<string, SqlStatement>();
  return {
    driverName: 'node:sqlite',
    inMemory,
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const cached = cache.get(sql);
      if (cached) return cached;
      const stmt = raw.prepare(sql);
      const wrapped: SqlStatement = {
        all: <T>(...params: SqlParam[]) => stmt.all(...normalizeParams(params)) as T[],
        get: <T>(...params: SqlParam[]) => stmt.get(...normalizeParams(params)) as T | undefined,
        run: (...params: SqlParam[]) => {
          const r = stmt.run(...normalizeParams(params));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
      cache.set(sql, wrapped);
      return wrapped;
    },
    close: () => raw.close(),
  };
}

/** Force a specific driver (tests use this to pin behaviour). */
export type DriverPreference = 'auto' | 'better-sqlite3' | 'node:sqlite';

let preferredDriver: DriverPreference = 'auto';

export function setDriverPreference(pref: DriverPreference): void {
  preferredDriver = pref;
}

export function activeDriverPreference(): DriverPreference {
  return preferredDriver;
}

function loadBetterSqlite(): ((file: string) => BetterSqliteDatabaseLike) | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('better-sqlite3') as
      | (new (file: string) => BetterSqliteDatabaseLike)
      | { default: new (file: string) => BetterSqliteDatabaseLike };
    const Ctor = typeof mod === 'function' ? mod : mod.default;
    if (!Ctor) return null;
    return (file: string) => new Ctor(file);
  } catch {
    return null;
  }
}

async function loadNodeSqlite(): Promise<
  ((file: string) => NodeSqliteDatabaseLike) | null
> {
  // `createRequire` is used first because bundlers and test runners commonly
  // rewrite dynamic `import('node:sqlite')` expressions (dropping the prefix),
  // while a plain require resolves the builtin reliably in every runtime.
  try {
    const require = createRequire(import.meta.url);
    const mod = require('node:sqlite') as {
      DatabaseSync: new (file: string) => NodeSqliteDatabaseLike;
    };
    if (mod?.DatabaseSync) {
      return (file: string) => new mod.DatabaseSync(file);
    }
  } catch {
    // fall through to dynamic import
  }
  try {
    const mod = (await import(/* @vite-ignore */ 'node:sqlite')) as unknown as {
      DatabaseSync: new (file: string) => NodeSqliteDatabaseLike;
    };
    return (file: string) => new mod.DatabaseSync(file);
  } catch {
    return null;
  }
}

/**
 * Open a SQLite database. Synchronous when `better-sqlite3` is available (the
 * packaged application); otherwise the promise resolves with the built-in
 * `node:sqlite` driver.
 */
export async function openDatabase(
  file: string,
  opts: OpenOptions = {},
): Promise<SqlDatabase> {
  const inMemory = file === ':memory:' || file === '';
  const target = inMemory ? ':memory:' : file;

  const wantBetter = preferredDriver === 'auto' || preferredDriver === 'better-sqlite3';
  if (wantBetter) {
    const open = loadBetterSqlite();
    if (open) {
      const raw = open(target);
      const db = wrapBetterSqlite(raw, inMemory);
      applyPragmas(db, opts, inMemory);
      return db;
    }
    if (preferredDriver === 'better-sqlite3') {
      throw new Error('better-sqlite3 driver was requested but is not installed');
    }
  }

  const openNode = await loadNodeSqlite();
  if (!openNode) {
    throw new Error(
      'No SQLite driver available: neither better-sqlite3 nor node:sqlite could be loaded',
    );
  }
  const raw = openNode(target);
  const db = wrapNodeSqlite(raw, inMemory);
  applyPragmas(db, opts, inMemory);
  return db;
}

/**
 * Durability and integrity pragmas.
 *
 * `synchronous = FULL` with WAL is the safest combination for a desktop
 * accounting application on unreliable mains power (common in the target
 * market): a committed transaction survives an abrupt power cut.
 */
function applyPragmas(db: SqlDatabase, opts: OpenOptions, inMemory: boolean): void {
  db.exec('PRAGMA foreign_keys = ON;');
  if (opts.readonly) db.exec('PRAGMA query_only = ON;');
  if (inMemory) {
    db.exec('PRAGMA temp_store = MEMORY;');
    return;
  }
  db.exec('PRAGMA journal_mode = WAL;');
  if (opts.fastPragmas) {
    db.exec('PRAGMA synchronous = NORMAL;');
  } else {
    db.exec('PRAGMA synchronous = FULL;');
  }
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA cache_size = -16000;'); // ~16 MB page cache
  db.exec('PRAGMA wal_autocheckpoint = 1000;');
}

/** Integrity check helper: returns SQLite's own verdict. */
export function integrityCheck(db: SqlDatabase): string {
  const rows = db.prepare('PRAGMA integrity_check;').all<Record<string, unknown>>();
  const first = rows[0];
  if (!first) return 'unknown';
  return String(Object.values(first)[0] ?? 'unknown');
}

/** Foreign key violation helper (empty array === clean). */
export function foreignKeyCheck(db: SqlDatabase): Record<string, unknown>[] {
  return db.prepare('PRAGMA foreign_key_check;').all<Record<string, unknown>>();
}
