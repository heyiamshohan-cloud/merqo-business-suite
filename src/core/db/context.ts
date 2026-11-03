/**
 * Database context: the single entry point the business layer uses for SQL.
 *
 * Every financial write path runs inside `Db.transaction()`, which wraps the
 * work in a SQLite `BEGIN IMMEDIATE` transaction (nested calls become
 * SAVEPOINTs). If anything throws, the whole unit of work rolls back — this is
 * what guarantees that an invoice, its stock movements, its payments and its
 * journal entry can never be persisted half-applied.
 */
import { AppError } from '../foundation/errors';
import type { RunResult, SqlDatabase, SqlParam } from './driver';

export type Params = SqlParam[];

export class Db {
  private depth = 0;
  private savepointSeq = 0;
  private closed = false;

  constructor(readonly raw: SqlDatabase) {}

  get driverName(): 'better-sqlite3' | 'node:sqlite' {
    return this.raw.driverName;
  }

  get inMemory(): boolean {
    return this.raw.inMemory;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  all<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    try {
      const rows = this.raw.prepare(sql).all<T>(...params);
      // Normalise driver-specific row objects into plain objects.
      return rows.map((r) => ({ ...(r as object) }) as T);
    } catch (err) {
      throw this.wrap(err, sql);
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: Params = []): T | undefined {
    try {
      const row = this.raw.prepare(sql).get<T>(...params);
      return row ? ({ ...(row as object) } as T) : undefined;
    } catch (err) {
      throw this.wrap(err, sql);
    }
  }

  run(sql: string, params: Params = []): RunResult {
    try {
      return this.raw.prepare(sql).run(...params);
    } catch (err) {
      throw this.wrap(err, sql);
    }
  }

  /** Single scalar value, or `fallback` when the query returns nothing. */
  scalar<T = number>(sql: string, params: Params = [], fallback?: T): T {
    const row = this.get<Record<string, unknown>>(sql, params);
    if (!row) {
      if (fallback !== undefined) return fallback;
      return fallback as T;
    }
    const values = Object.values(row);
    return (values[0] as T) ?? (fallback as T);
  }

  /** Shorthand for a numeric sum that may be NULL. */
  sum(sql: string, params: Params = []): number {
    const v = this.scalar<number | null>(sql, params, null);
    if (v === null || v === undefined) return 0;
    // `|| 0` normalises -0 to 0 so equality checks stay predictable.
    return Number(v) || 0;
  }

  count(table: string, where = '1=1', params: Params = []): number {
    return this.sum(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, params);
  }

  exists(sql: string, params: Params = []): boolean {
    return this.get(sql, params) !== undefined;
  }

  /**
   * Run `fn` inside a transaction. Nested calls use SAVEPOINTs, so service
   * functions can compose freely without knowing whether they are the
   * outermost writer.
   */
  transaction<T>(fn: () => T): T {
    if (this.closed) throw new AppError('Database is closed', { code: 'DB_ERROR' });
    const isOuter = this.depth === 0;
    const savepoint = `sp_${++this.savepointSeq}`;
    if (isOuter) {
      this.raw.exec('BEGIN IMMEDIATE');
    } else {
      this.raw.exec(`SAVEPOINT ${savepoint}`);
    }
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (isOuter) {
        this.raw.exec('COMMIT');
      } else {
        this.raw.exec(`RELEASE ${savepoint}`);
      }
      return result;
    } catch (err) {
      this.depth--;
      try {
        if (isOuter) {
          this.raw.exec('ROLLBACK');
        } else {
          this.raw.exec(`ROLLBACK TO ${savepoint}`);
          this.raw.exec(`RELEASE ${savepoint}`);
        }
      } catch {
        // Rollback failure must not mask the original error.
      }
      throw err;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.raw.close();
    }
  }

  /** Wrap low-level driver failures into a typed application error. */
  private wrap(err: unknown, sql: string): unknown {
    if (err instanceof AppError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (lower.includes('unique constraint')) {
      return new AppError(`Duplicate value rejected by the database: ${message}`, {
        code: 'DUPLICATE',
        messageBn: 'একই তথ্য আগেই সংরক্ষিত আছে।',
        details: { sql: sql.slice(0, 200) },
        cause: err,
      });
    }
    if (lower.includes('foreign key constraint')) {
      return new AppError(`Related record is missing or still in use: ${message}`, {
        code: 'CONFLICT',
        messageBn: 'সম্পর্কিত রেকর্ড পাওয়া যায়নি বা এখনো ব্যবহৃত হচ্ছে।',
        details: { sql: sql.slice(0, 200) },
        cause: err,
      });
    }
    if (lower.includes('check constraint')) {
      return new AppError(`Value rejected by a data integrity rule: ${message}`, {
        code: 'VALIDATION',
        messageBn: 'তথ্য যাচাইকরণে সমস্যা হয়েছে।',
        details: { sql: sql.slice(0, 200) },
        cause: err,
      });
    }
    return new AppError(`Database error: ${message}`, {
      code: 'DB_ERROR',
      messageBn: 'ডাটাবেস ত্রুটি ঘটেছে।',
      details: { sql: sql.slice(0, 200) },
      cause: err,
    });
  }
}
