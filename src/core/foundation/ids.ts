import { randomUUID } from 'node:crypto';

/** Generate a new entity identifier (UUID v4). */
export function newId(): string {
  return randomUUID();
}

/**
 * Deterministic-ish document number, e.g. prefix "INV-" + 7 => "INV-0000007".
 * Sequences are persisted in `document_sequences`; the service layer owns
 * allocation inside the surrounding transaction.
 */
export function formatDocumentNumber(prefix: string, value: number, padding = 6): string {
  return `${prefix}${String(value).padStart(padding, '0')}`;
}
