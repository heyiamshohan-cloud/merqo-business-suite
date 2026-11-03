/**
 * Structured application errors.
 *
 * Every user-facing failure carries a machine code plus Bengali and English
 * messages so the presentation layer can render a precise, localised error
 * without leaking stack traces or SQL to the operator.
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'NEGATIVE_STOCK_BLOCKED'
  | 'UNBALANCED_JOURNAL'
  | 'ACCOUNT_NOT_FOUND'
  | 'IMMUTABLE_RECORD'
  | 'INSUFFICIENT_PAYMENT'
  | 'OVER_RETURN'
  | 'LICENSE_INVALID'
  | 'LICENSE_MISSING'
  | 'LICENSE_EXPIRED'
  | 'LICENSE_DEVICE_MISMATCH'
  | 'BACKUP_INVALID'
  | 'MIGRATION_FAILED'
  | 'DB_ERROR'
  | 'IO_ERROR'
  | 'PERMISSION_DENIED'
  | 'INTERNAL';

export interface AppErrorOptions {
  code?: ErrorCode;
  messageBn?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly messageBn: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = opts.code ?? 'VALIDATION';
    this.messageBn = opts.messageBn ?? message;
    this.details = opts.details ?? {};
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      messageBn: this.messageBn,
      details: this.details,
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export class ValidationError extends AppError {
  constructor(message: string, messageBn: string, details: Record<string, unknown> = {}) {
    super(message, { code: 'VALIDATION', messageBn, details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, messageBn: string, details: Record<string, unknown> = {}) {
    super(message, { code: 'NOT_FOUND', messageBn, details });
    this.name = 'NotFoundError';
  }
}

export class BusinessRuleError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    messageBn: string,
    details: Record<string, unknown> = {},
  ) {
    super(message, { code, messageBn, details });
    this.name = 'BusinessRuleError';
  }
}

/** Convert any thrown value into a serialisable AppError for the UI/IPC boundary. */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(message, { code: 'INTERNAL', messageBn: 'অপ্রত্যাশিত ত্রুটি ঘটেছে।' });
}
