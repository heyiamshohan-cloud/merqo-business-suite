/**
 * Customers and suppliers (parties).
 *
 * Balances are NEVER stored as a mutable column — they are always derived from
 * the posted journal restricted to the party dimension. That guarantees the
 * customer due report, the party statement and the Accounts Receivable control
 * account always agree.
 */
import { AppError, BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import { toPaisaOrZero } from '../foundation/money';
import type { Ctx } from '../kernel';
import { ACC } from '../accounting/accounts';
import { ledger, type LedgerResult } from '../accounting/reports';
import type { CustomerRow, SupplierRow } from '../domain/types';
import { nextSequence } from '../services/settings';

function requireText(value: string | undefined | null, label: string, labelBn: string): string {
  const v = (value ?? '').trim();
  if (v === '') throw new ValidationError(`${label} is required`, `${labelBn} আবশ্যক।`);
  return v;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export interface CustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  note?: string | null;
  code?: string | null;
  creditLimit?: number;
}

export function createCustomer(ctx: Ctx, input: CustomerInput): CustomerRow {
  const name = requireText(input.name, 'Customer name', 'গ্রাহকের নাম');
  const at = ctx.clock.nowIso();
  return ctx.db.transaction(() => {
    const code = (input.code ?? '').trim() || nextSequence(ctx.db, 'customer').formatted;
    const dup = ctx.db.get<{ id: string }>('SELECT id FROM customers WHERE code = ?', [code]);
    if (dup) {
      throw new AppError(`Customer code "${code}" already exists`, {
        code: 'DUPLICATE',
        messageBn: 'এই গ্রাহক কোড আগেই ব্যবহৃত হয়েছে।',
      });
    }
    const id = newId();
    ctx.db.run(
      `INSERT INTO customers (id, code, name, phone, address, note, credit_limit, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        code,
        name,
        input.phone ?? null,
        input.address ?? null,
        input.note ?? null,
        input.creditLimit ?? 0,
        at,
        at,
      ],
    );
    return ctx.db.get<CustomerRow>('SELECT * FROM customers WHERE id = ?', [id]) as CustomerRow;
  });
}

export function updateCustomer(ctx: Ctx, id: string, patch: Partial<CustomerInput>): CustomerRow {
  const existing = ctx.db.get<CustomerRow>('SELECT * FROM customers WHERE id = ?', [id]);
  if (!existing) throw new NotFoundError('Customer not found', 'গ্রাহক পাওয়া যায়নি।');
  const name = patch.name !== undefined ? requireText(patch.name, 'Customer name', 'গ্রাহকের নাম') : existing.name;
  ctx.db.run(
    `UPDATE customers SET name = ?, phone = ?, address = ?, note = ?, credit_limit = ?, updated_at = ?
      WHERE id = ?`,
    [
      name,
      patch.phone !== undefined ? patch.phone : existing.phone,
      patch.address !== undefined ? patch.address : existing.address,
      patch.note !== undefined ? patch.note : existing.note,
      patch.creditLimit !== undefined ? patch.creditLimit : existing.credit_limit,
      ctx.clock.nowIso(),
      id,
    ],
  );
  return ctx.db.get<CustomerRow>('SELECT * FROM customers WHERE id = ?', [id]) as CustomerRow;
}

export function archiveCustomer(ctx: Ctx, id: string): void {
  const balance = customerBalance(ctx, id);
  if (balance !== 0) {
    throw new BusinessRuleError(
      'CONFLICT',
      'Cannot archive a customer with an outstanding balance',
      'বাকি থাকা গ্রাহককে আর্কাইভ করা যাবে না। আগে বাকি নিষ্পত্তি করুন।',
      { customerId: id, balance },
    );
  }
  ctx.db.run("UPDATE customers SET status = 'archived', updated_at = ? WHERE id = ?", [
    ctx.clock.nowIso(),
    id,
  ]);
}

export function restoreCustomer(ctx: Ctx, id: string): void {
  ctx.db.run("UPDATE customers SET status = 'active', updated_at = ? WHERE id = ?", [
    ctx.clock.nowIso(),
    id,
  ]);
}

export interface PartyQuery {
  search?: string;
  status?: 'active' | 'archived' | 'all';
  withDueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export function listCustomers(
  ctx: Ctx,
  q: PartyQuery = {},
): { rows: CustomerRow[]; total: number; page: number; pageSize: number; totalPages: number } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  const status = q.status ?? 'active';
  if (status !== 'all') {
    where.push('c.status = ?');
    params.push(status);
  }
  if (q.search && q.search.trim() !== '') {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push('(LOWER(c.name) LIKE ? OR LOWER(COALESCE(c.phone,\'\')) LIKE ? OR LOWER(c.code) LIKE ?)');
    params.push(term, term, term);
  }
  const balanceExpr = `(SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
                          FROM journal_lines jl
                          JOIN accounts a ON a.id = jl.account_id
                         WHERE jl.party_type = 'customer' AND jl.party_id = c.id AND a.code = '${ACC.AR}')`;
  if (q.withDueOnly) where.push(`${balanceExpr} > 0`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.sum(`SELECT COUNT(*) AS v FROM customers c ${whereSql}`, params);
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(Math.max(1, q.pageSize ?? 50), 500);
  const rows = ctx.db.all<CustomerRow>(
    `SELECT c.*, ${balanceExpr} AS balance FROM customers c ${whereSql}
     ORDER BY c.name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function getCustomer(ctx: Ctx, id: string): CustomerRow {
  const row = ctx.db.get<CustomerRow>('SELECT * FROM customers WHERE id = ?', [id]);
  if (!row) throw new NotFoundError('Customer not found', 'গ্রাহক পাওয়া যায়নি।', { id });
  return { ...row, balance: customerBalance(ctx, id) };
}

/** Positive = customer owes the business. */
export function customerBalance(ctx: Ctx, customerId: string): number {
  return ctx.db.sum(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.party_type = 'customer' AND jl.party_id = ? AND a.code = ?`,
    [customerId, ACC.AR],
  );
}

export function totalReceivables(ctx: Ctx): number {
  return ctx.db.sum(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.party_type = 'customer' AND a.code = ?`,
    [ACC.AR],
  );
}

export function customerStatement(
  ctx: Ctx,
  customerId: string,
  window: { from?: string; to?: string } = {},
): LedgerResult {
  const customer = getCustomer(ctx, customerId);
  return ledger(ctx, {
    partyType: 'customer',
    partyId: customer.id,
    accountCodes: [ACC.AR],
    from: window.from,
    to: window.to,
  });
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------
export interface SupplierInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  note?: string | null;
  code?: string | null;
}

export function createSupplier(ctx: Ctx, input: SupplierInput): SupplierRow {
  const name = requireText(input.name, 'Supplier name', 'সরবরাহকারীর নাম');
  const at = ctx.clock.nowIso();
  return ctx.db.transaction(() => {
    const code = (input.code ?? '').trim() || nextSequence(ctx.db, 'supplier').formatted;
    const dup = ctx.db.get<{ id: string }>('SELECT id FROM suppliers WHERE code = ?', [code]);
    if (dup) {
      throw new AppError(`Supplier code "${code}" already exists`, {
        code: 'DUPLICATE',
        messageBn: 'এই সরবরাহকারী কোড আগেই ব্যবহৃত হয়েছে।',
      });
    }
    const id = newId();
    ctx.db.run(
      `INSERT INTO suppliers (id, code, name, phone, address, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, code, name, input.phone ?? null, input.address ?? null, input.note ?? null, at, at],
    );
    return ctx.db.get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id]) as SupplierRow;
  });
}

export function updateSupplier(ctx: Ctx, id: string, patch: Partial<SupplierInput>): SupplierRow {
  const existing = ctx.db.get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!existing) throw new NotFoundError('Supplier not found', 'সরবরাহকারী পাওয়া যায়নি।');
  const name = patch.name !== undefined ? requireText(patch.name, 'Supplier name', 'সরবরাহকারীর নাম') : existing.name;
  ctx.db.run(
    'UPDATE suppliers SET name = ?, phone = ?, address = ?, note = ?, updated_at = ? WHERE id = ?',
    [
      name,
      patch.phone !== undefined ? patch.phone : existing.phone,
      patch.address !== undefined ? patch.address : existing.address,
      patch.note !== undefined ? patch.note : existing.note,
      ctx.clock.nowIso(),
      id,
    ],
  );
  return ctx.db.get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id]) as SupplierRow;
}

export function archiveSupplier(ctx: Ctx, id: string): void {
  const balance = supplierBalance(ctx, id);
  if (balance !== 0) {
    throw new BusinessRuleError(
      'CONFLICT',
      'Cannot archive a supplier with an outstanding payable',
      'পাওনা থাকা সরবরাহকারীকে আর্কাইভ করা যাবে না। আগে পাওনা পরিশোধ করুন।',
      { supplierId: id, balance },
    );
  }
  ctx.db.run("UPDATE suppliers SET status = 'archived', updated_at = ? WHERE id = ?", [
    ctx.clock.nowIso(),
    id,
  ]);
}

export function listSuppliers(
  ctx: Ctx,
  q: PartyQuery = {},
): { rows: SupplierRow[]; total: number; page: number; pageSize: number; totalPages: number } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  const status = q.status ?? 'active';
  if (status !== 'all') {
    where.push('s.status = ?');
    params.push(status);
  }
  if (q.search && q.search.trim() !== '') {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push("(LOWER(s.name) LIKE ? OR LOWER(COALESCE(s.phone,'')) LIKE ? OR LOWER(s.code) LIKE ?)");
    params.push(term, term, term);
  }
  const balanceExpr = `(SELECT COALESCE(SUM(jl.credit - jl.debit), 0)
                          FROM journal_lines jl
                          JOIN accounts a ON a.id = jl.account_id
                         WHERE jl.party_type = 'supplier' AND jl.party_id = s.id AND a.code = '${ACC.AP}')`;
  if (q.withDueOnly) where.push(`${balanceExpr} > 0`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.sum(`SELECT COUNT(*) AS v FROM suppliers s ${whereSql}`, params);
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(Math.max(1, q.pageSize ?? 50), 500);
  const rows = ctx.db.all<SupplierRow>(
    `SELECT s.*, ${balanceExpr} AS balance FROM suppliers s ${whereSql}
     ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function getSupplier(ctx: Ctx, id: string): SupplierRow {
  const row = ctx.db.get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!row) throw new NotFoundError('Supplier not found', 'সরবরাহকারী পাওয়া যায়নি।', { id });
  return { ...row, balance: supplierBalance(ctx, id) };
}

/** Positive = the business owes the supplier. */
export function supplierBalance(ctx: Ctx, supplierId: string): number {
  return ctx.db.sum(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS v
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.party_type = 'supplier' AND jl.party_id = ? AND a.code = ?`,
    [supplierId, ACC.AP],
  );
}

export function totalPayables(ctx: Ctx): number {
  return ctx.db.sum(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS v
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.party_type = 'supplier' AND a.code = ?`,
    [ACC.AP],
  );
}

export function supplierStatement(
  ctx: Ctx,
  supplierId: string,
  window: { from?: string; to?: string } = {},
): LedgerResult {
  const supplier = getSupplier(ctx, supplierId);
  return ledger(ctx, {
    partyType: 'supplier',
    partyId: supplier.id,
    accountCodes: [ACC.AP],
    from: window.from,
    to: window.to,
  });
}

/** Parse an opening balance amount for a party (taka string -> paisa). */
export function parsePartyAmount(value: string | number | undefined | null): number {
  return toPaisaOrZero(value);
}
