/**
 * Structured file logger.
 *
 * Writes newline-delimited JSON to `logs/merqo-YYYY-MM-DD.log`, rotating the
 * file when it exceeds ~5 MB. Logs never contain passwords, licence private
 * keys or full database contents — only operational metadata and error codes.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEYS = /pass(word|phrase)|privatekey|secret|token|apikey/i;

export class Logger {
  constructor(private readonly logDir: string) {
    mkdirSync(logDir, { recursive: true });
  }

  private fileFor(date = new Date()): string {
    const d = date.toISOString().slice(0, 10);
    return join(this.logDir, `merqo-${d}.log`);
  }

  private rotateIfNeeded(file: string): void {
    try {
      if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
        renameSync(file, `${file}.${Date.now()}.bak`);
      }
    } catch {
      // rotation is best-effort
    }
  }

  private sanitize(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[deep]';
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => this.sanitize(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : this.sanitize(v, depth + 1);
    }
    return out;
  }

  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry = {
      at: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta: this.sanitize(meta) } : {}),
    };
    const line = JSON.stringify(entry) + '\n';
    try {
      const file = this.fileFor();
      this.rotateIfNeeded(file);
      appendFileSync(file, line, 'utf8');
    } catch {
      // Never let logging break the application.
    }
    if (level === 'error' || level === 'warn') {
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : 'warn'](`[MERQO] ${message}`, meta ?? '');
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }
}
