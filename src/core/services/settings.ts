/**
 * Settings, business profile and document numbering.
 *
 * Settings live in a single key/value table so new options can be added
 * without schema migrations. Typed accessors keep call sites honest.
 */
import { AppError } from '../foundation/errors';
import { formatDocumentNumber } from '../foundation/ids';
import type { Db } from '../db/context';

export const DEFAULT_SETTINGS: Record<string, string> = {
  'business.name': 'MERQO Business',
  'business.name_bn': 'মার্কো বিজনেস',
  'business.address': '',
  'business.phone': '',
  'business.email': '',
  'business.owner_name': '',
  'business.vat_reg_no': '',

  'invoice.footer': 'ধন্যবাদ! আবার আসবেন।',
  'invoice.note': '',
  'invoice.prefix': 'INV-',
  'invoice.show_logo': '1',
  'invoice.terms': '',

  'currency.code': 'BDT',
  'currency.symbol': '৳',
  'date.format': 'dd/MM/yyyy',
  'time.format': 'hh:mm A',
  'number.grouping': 'lakh_crore',

  'tax.enabled': '0',
  'tax.default_rate_bp': '0',
  'tax.prices_include_tax': '0',
  'tax.label': 'VAT',

  'inventory.allow_negative': '0',
  'inventory.low_stock_threshold': '5',
  'inventory.costing_method': 'moving_average',

  'pos.default_payment_method': 'cash',
  'pos.quick_cash_amounts': '50,100,200,500,1000',
  'pos.auto_print_receipt': '1',
  'pos.barcode_auto_add': '1',
  'pos.default_customer_id': '',

  'printing.printer_name': '',
  'printing.paper_width_mm': '80',
  'printing.copies': '1',
  'printing.cash_drawer': '1',
  'printing.density': '2',
  'printing.margin_mm': '2',
  'printing.mode': 'windows', // windows | escpos-raw

  'backup.auto_enabled': '1',
  'backup.frequency': 'daily', // daily | weekly | manual
  'backup.location': '',
  'backup.retention_count': '14',
  'backup.last_run': '',

  'app.language': 'bn',
  'app.require_login': '0',
  'app.license_grace_days': '0',
  'app.biz_timezone_offset_minutes': '360',
};

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? DEFAULT_SETTINGS[key];
}

export function getSettingRequired(db: Db, key: string): string {
  const value = getSetting(db, key);
  if (value === undefined) {
    throw new AppError(`Missing setting: ${key}`, {
      code: 'NOT_FOUND',
      messageBn: 'সেটিংসে প্রয়োজনীয় তথ্য নেই।',
      details: { key },
    });
  }
  return value;
}

export function getBoolSetting(db: Db, key: string): boolean {
  const v = getSetting(db, key);
  return v === '1' || v === 'true';
}

export function getNumberSetting(db: Db, key: string, fallback = 0): number {
  const v = getSetting(db, key);
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function setSetting(db: Db, key: string, value: string, now: string): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

export function getSettings(db: Db): Record<string, string> {
  const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export interface UpdateSettingsResult {
  changed: string[];
}

/** Update a batch of settings, validating known keys. */
export function updateSettings(
  db: Db,
  patch: Record<string, string | number | boolean>,
  now: string,
): UpdateSettingsResult {
  const changed: string[] = [];
  db.transaction(() => {
    for (const [key, rawValue] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) {
        throw new AppError(`Unknown setting: ${key}`, {
          code: 'VALIDATION',
          messageBn: 'অজানা সেটিংস।',
          details: { key },
        });
      }
      const value =
        typeof rawValue === 'boolean' ? (rawValue ? '1' : '0') : String(rawValue);
      const old = getSetting(db, key);
      if (old !== value) {
        setSetting(db, key, value, now);
        changed.push(key);
      }
    }
  });
  return { changed };
}

export interface BusinessProfile {
  name: string;
  nameBn: string;
  address: string;
  phone: string;
  email: string;
  ownerName: string;
  vatRegNo: string;
  invoiceFooter: string;
  invoiceNote: string;
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  taxLabel: string;
  taxDefaultRateBp: number;
}

export function getBusinessProfile(db: Db): BusinessProfile {
  return {
    name: getSetting(db, 'business.name') ?? '',
    nameBn: getSetting(db, 'business.name_bn') ?? '',
    address: getSetting(db, 'business.address') ?? '',
    phone: getSetting(db, 'business.phone') ?? '',
    email: getSetting(db, 'business.email') ?? '',
    ownerName: getSetting(db, 'business.owner_name') ?? '',
    vatRegNo: getSetting(db, 'business.vat_reg_no') ?? '',
    invoiceFooter: getSetting(db, 'invoice.footer') ?? '',
    invoiceNote: getSetting(db, 'invoice.note') ?? '',
    currencyCode: getSetting(db, 'currency.code') ?? 'BDT',
    currencySymbol: getSetting(db, 'currency.symbol') ?? '৳',
    taxEnabled: getBoolSetting(db, 'tax.enabled'),
    taxLabel: getSetting(db, 'tax.label') ?? 'VAT',
    taxDefaultRateBp: getNumberSetting(db, 'tax.default_rate_bp', 0),
  };
}

export interface SequenceResult {
  value: number;
  formatted: string;
  key: string;
}

/**
 * Allocate the next document number for `key` (e.g. 'invoice').
 * MUST be called inside the surrounding transaction so a rolled-back
 * document does not burn a number.
 */
export function nextSequence(db: Db, key: string, overridePrefix?: string): SequenceResult {
  const row = db.get<{ prefix: string; next_value: number; padding: number }>(
    'SELECT prefix, next_value, padding FROM document_sequences WHERE key = ?',
    [key],
  );
  if (!row) {
    throw new AppError(`Unknown document sequence: ${key}`, {
      code: 'NOT_FOUND',
      messageBn: 'ডকুমেন্ট নম্বর সিরিজ পাওয়া যায়নি।',
      details: { key },
    });
  }
  const value = row.next_value;
  db.run('UPDATE document_sequences SET next_value = next_value + 1 WHERE key = ?', [key]);
  const prefix = overridePrefix ?? row.prefix;
  return { value, formatted: formatDocumentNumber(prefix, value, row.padding), key };
}

/** Peek at the next number without consuming it. */
export function peekSequence(db: Db, key: string): SequenceResult {
  const row = db.get<{ prefix: string; next_value: number; padding: number }>(
    'SELECT prefix, next_value, padding FROM document_sequences WHERE key = ?',
    [key],
  );
  if (!row) throw new AppError(`Unknown sequence ${key}`, { code: 'NOT_FOUND' });
  return {
    value: row.next_value,
    formatted: formatDocumentNumber(row.prefix, row.next_value, row.padding),
    key,
  };
}

/** Change the prefix/padding of a sequence (Settings screen), keeping the counter. */
export function configureSequence(
  db: Db,
  key: string,
  prefix: string,
  padding: number,
  nextValue?: number,
): void {
  if (padding < 1 || padding > 12) {
    throw new AppError('Sequence padding must be between 1 and 12', {
      code: 'VALIDATION',
      messageBn: 'ডকুমেন্ট নম্বরের দৈর্ঘ্য ১ থেকে ১২ এর মধ্যে হতে হবে।',
    });
  }
  const exists = db.get<{ key: string }>('SELECT key FROM document_sequences WHERE key = ?', [key]);
  if (!exists) {
    db.run(
      'INSERT INTO document_sequences (key, prefix, next_value, padding) VALUES (?, ?, ?, ?)',
      [key, prefix, nextValue ?? 1, padding],
    );
    return;
  }
  db.run('UPDATE document_sequences SET prefix = ?, padding = ? WHERE key = ?', [
    prefix,
    padding,
    key,
  ]);
  if (nextValue !== undefined && nextValue > 0) {
    db.run('UPDATE document_sequences SET next_value = ? WHERE key = ?', [nextValue, key]);
  }
}
