/**
 * Expenses.
 *
 * Posting: Dr <expense category account> / Cr <payment method account>.
 * Editing an expense never mutates its journal: the original entry is reversed
 * and a corrected entry is posted, so the audit trail keeps both versions.
 */
import { BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import type { Ctx } from '../kernel';
import { paymentMethodAccountCode, PAYMENT_METHODS } from '../accounting/accounts';
import { postJournal, reverseJournal } from '../accounting/journal';
import type { ExpenseCategoryRow, ExpenseRow } from '../domain/types';
import { nextSequence } from '../services/settings';
import { recordAudit } from '../services/audit';

function validateMethod(method: string): string {
  const m = (method ?? '').trim().toLowerCase();
  const found = PAYMENT_METHODS.find((p) => p.key === m);
  if (!found) {
    throw new ValidationError(`Unknown payment method: "${method}"`, 'অজানা পেমেন্ট মাধ্যম।', { method });
  }
  return found.key;
}

export function listExpenseCategories(ctx: Ctx): ExpenseCategoryRow[] {
  return ctx.db.all<ExpenseCategoryRow>(
    `SELECT ec.*, a.code AS account_code
       FROM expense_categories ec
       JOIN accounts a ON a.id = ec.account_id
      WHERE ec.status = 'active'
      ORDER BY ec.name COLLATE NOCASE`,
  );
}

export function createExpenseCategory(
  ctx: Ctx,
  input: { name: string; nameBn?: string | null; accountCode: string },
): ExpenseCategoryRow {
  const name = (input.name ?? '').trim();
  if (name === '') {
    throw new ValidationError('Category name is required', 'ক্যাটাগরির নাম আবশ্যক।');
  }
  const account = ctx.db.get<{ id: string }>('SELECT id FROM accounts WHERE code = ?', [
    input.accountCode,
  ]);
  if (!account) {
    throw new NotFoundError('Expense account not found', 'খরচের হিসাব খাত পাওয়া যায়নি।');
  }
  const dup = ctx.db.get<{ id: string }>(
    'SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE',
    [name],
  );
  if (dup) {
    throw new BusinessRuleError('DUPLICATE', 'Expense category already exists', 'এই খরচের ক্যাটাগরি আগেই আছে।');
  }
  const id = newId();
  ctx.db.run(
    `INSERT INTO expense_categories (id, name, name_bn, account_id, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [id, name, input.nameBn ?? null, account.id, ctx.clock.nowIso()],
  );
  return ctx.db.get<ExpenseCategoryRow>('SELECT * FROM expense_categories WHERE id = ?', [
    id,
  ]) as ExpenseCategoryRow;
}

export interface CreateExpenseInput {
  categoryId: string;
  amount: number; // paisa
  method: string;
  payee?: string | null;
  reference?: string | null;
  note?: string | null;
  at?: string;
  bizDate?: string;
}

export interface ExpenseResult {
  expenseId: string;
  voucherNo: string;
  journalId: string;
  amount: number;
}

export function createExpense(ctx: Ctx, input: CreateExpenseInput): ExpenseResult {
  const { db, clock } = ctx;
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new ValidationError('Expense amount must be greater than zero', 'খরচের পরিমাণ শূন্যের বেশি হতে হবে।');
  }
  const method = validateMethod(input.method);
  const category = db.get<ExpenseCategoryRow & { account_id: string }>(
    'SELECT * FROM expense_categories WHERE id = ? AND status = ?',
    [input.categoryId, 'active'],
  );
  if (!category) {
    throw new NotFoundError('Expense category not found', 'খরচের ক্যাটাগরি পাওয়া যায়নি।');
  }

  return db.transaction(() => {
    const at = input.at ?? clock.nowIso();
    const bizDate = input.bizDate ?? clock.bizDateOf(at);
    const voucherNo = nextSequence(db, 'expense').formatted;
    const expenseId = newId();

    const journal = postJournal(ctx, {
      memo: `Expense ${voucherNo}: ${category.name}`,
      sourceType: 'expense',
      sourceId: expenseId,
      lines: [
        {
          accountId: category.account_id,
          debit: input.amount,
          memo: input.note ?? category.name,
        },
        { accountCode: paymentMethodAccountCode(method), credit: input.amount },
      ],
      at,
      bizDate,
    });

    db.run(
      `INSERT INTO expenses
        (id, voucher_no, at, biz_date, category_id, account_id, amount, method, payee, reference,
         note, journal_id, user_id, created_at, updated_at, edited_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        expenseId,
        voucherNo,
        at,
        bizDate,
        category.id,
        category.account_id,
        input.amount,
        method,
        input.payee ?? null,
        input.reference ?? null,
        input.note ?? null,
        journal.id,
        ctx.userId,
        clock.nowIso(),
        clock.nowIso(),
      ],
    );

    recordAudit(ctx, {
      action: 'expense.create',
      entity: 'expense',
      entityId: expenseId,
      details: { voucherNo, amount: input.amount, category: category.name, method },
    });

    return { expenseId, voucherNo, journalId: journal.id, amount: input.amount };
  });
}

export interface UpdateExpenseInput {
  amount?: number;
  categoryId?: string;
  method?: string;
  payee?: string | null;
  reference?: string | null;
  note?: string | null;
  reason: string;
}

/**
 * Correct an expense. The previous journal entry is reversed and a new one is
 * posted; the expense row keeps an `edited_count` and the audit log records the
 * before/after values.
 */
export function updateExpense(ctx: Ctx, expenseId: string, input: UpdateExpenseInput): ExpenseResult {
  const { db, clock } = ctx;
  if (!input.reason || input.reason.trim() === '') {
    throw new ValidationError('A reason is required when editing an expense', 'খরচ সম্পাদনার কারণ লিখুন।');
  }
  return db.transaction(() => {
    const existing = db.get<ExpenseRow>('SELECT * FROM expenses WHERE id = ?', [expenseId]);
    if (!existing) throw new NotFoundError('Expense not found', 'খরচ পাওয়া যায়নি।');
    if (!existing.journal_id) {
      throw new BusinessRuleError('CONFLICT', 'Expense has no journal entry', 'খরচের হিসাব এন্ট্রি নেই।');
    }

    const amount = input.amount ?? existing.amount;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ValidationError('Expense amount must be greater than zero', 'খরচের পরিমাণ শূন্যের বেশি হতে হবে।');
    }
    const method = input.method ? validateMethod(input.method) : existing.method;
    const categoryId = input.categoryId ?? existing.category_id;
    const category = db.get<ExpenseCategoryRow>('SELECT * FROM expense_categories WHERE id = ?', [
      categoryId,
    ]);
    if (!category) throw new NotFoundError('Expense category not found', 'খরচের ক্যাটাগরি পাওয়া যায়নি।');

    const reversal = reverseJournal(ctx, existing.journal_id, `Expense ${existing.voucher_no} correction`);

    const journal = postJournal(ctx, {
      memo: `Expense ${existing.voucher_no} (corrected)`,
      sourceType: 'expense',
      sourceId: expenseId,
      lines: [
        {
          accountId: category.account_id,
          debit: amount,
          memo: input.note ?? category.name,
        },
        { accountCode: paymentMethodAccountCode(method), credit: amount },
      ],
    });

    db.run(
      `UPDATE expenses SET category_id = ?, account_id = ?, amount = ?, method = ?, payee = ?,
              reference = ?, note = ?, journal_id = ?, updated_at = ?, edited_count = edited_count + 1
        WHERE id = ?`,
      [
        category.id,
        category.account_id,
        amount,
        method,
        input.payee !== undefined ? input.payee : existing.payee,
        input.reference !== undefined ? input.reference : existing.reference,
        input.note !== undefined ? input.note : existing.note,
        journal.id,
        clock.nowIso(),
        expenseId,
      ],
    );

    recordAudit(ctx, {
      action: 'expense.update',
      entity: 'expense',
      entityId: expenseId,
      severity: 'warning',
      details: {
        reason: input.reason,
        before: { amount: existing.amount, method: existing.method, categoryId: existing.category_id },
        after: { amount, method, categoryId: category.id },
        reversalJournalId: reversal.id,
        newJournalId: journal.id,
      },
    });

    return { expenseId, voucherNo: existing.voucher_no, journalId: journal.id, amount };
  });
}

export interface ExpenseQuery {
  from?: string;
  to?: string;
  categoryId?: string;
  method?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function listExpenses(
  ctx: Ctx,
  q: ExpenseQuery = {},
): { rows: ExpenseRow[]; total: number; page: number; pageSize: number; totalPages: number; totalAmount: number } {
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (q.from) {
    where.push('e.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('e.biz_date <= ?');
    params.push(q.to);
  }
  if (q.categoryId) {
    where.push('e.category_id = ?');
    params.push(q.categoryId);
  }
  if (q.method) {
    where.push('e.method = ?');
    params.push(q.method);
  }
  if (q.search && q.search.trim() !== '') {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push("(LOWER(COALESCE(e.payee,'')) LIKE ? OR LOWER(COALESCE(e.note,'')) LIKE ? OR LOWER(e.voucher_no) LIKE ?)");
    params.push(term, term, term);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = ctx.db.sum(`SELECT COUNT(*) AS v FROM expenses e ${whereSql}`, params);
  const totalAmount = ctx.db.sum(`SELECT COALESCE(SUM(e.amount),0) AS v FROM expenses e ${whereSql}`, params);
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(Math.max(1, q.pageSize ?? 50), 500);
  const rows = ctx.db.all<ExpenseRow>(
    `SELECT e.*, ec.name AS category_name, a.name AS account_name
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       JOIN accounts a ON a.id = e.account_id
       ${whereSql}
      ORDER BY e.at DESC, e.rowid DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), totalAmount };
}

export function getExpense(ctx: Ctx, id: string): ExpenseRow {
  const row = ctx.db.get<ExpenseRow>(
    `SELECT e.*, ec.name AS category_name, a.name AS account_name
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       JOIN accounts a ON a.id = e.account_id
      WHERE e.id = ?`,
    [id],
  );
  if (!row) throw new NotFoundError('Expense not found', 'খরচ পাওয়া যায়নি।');
  return row;
}

export function expenseTotals(
  ctx: Ctx,
  window: { from: string; to: string },
): { count: number; total: number; byCategory: Array<{ category: string; total: number }> } {
  const row = ctx.db.get<{ count: number; total: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
       FROM expenses WHERE biz_date >= ? AND biz_date <= ?`,
    [window.from, window.to],
  );
  const byCategory = ctx.db.all<{ category: string; total: number }>(
    `SELECT ec.name AS category, COALESCE(SUM(e.amount),0) AS total
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
      WHERE e.biz_date >= ? AND e.biz_date <= ?
      GROUP BY ec.name ORDER BY total DESC`,
    [window.from, window.to],
  );
  return { count: row?.count ?? 0, total: row?.total ?? 0, byCategory };
}

/** Void an expense by reversing its journal (used for mistaken entries). */
export function voidExpense(ctx: Ctx, expenseId: string, reason: string): { reversalJournalId: string } {
  if (!reason || reason.trim() === '') {
    throw new ValidationError('A reason is required', 'কারণ লিখুন।');
  }
  return ctx.db.transaction(() => {
    const existing = ctx.db.get<ExpenseRow>('SELECT * FROM expenses WHERE id = ?', [expenseId]);
    if (!existing) throw new NotFoundError('Expense not found', 'খরচ পাওয়া যায়নি।');
    if (!existing.journal_id) {
      throw new BusinessRuleError('CONFLICT', 'Expense has no journal entry', 'খরচের হিসাব এন্ট্রি নেই।');
    }
    const reversal = reverseJournal(ctx, existing.journal_id, `Void expense ${existing.voucher_no}: ${reason}`);
    ctx.db.run('UPDATE expenses SET amount = 0, updated_at = ? WHERE id = ?', [
      ctx.clock.nowIso(),
      expenseId,
    ]);
    recordAudit(ctx, {
      action: 'expense.void',
      entity: 'expense',
      entityId: expenseId,
      severity: 'critical',
      details: { reason, reversalJournalId: reversal.id, amount: existing.amount },
    });
    return { reversalJournalId: reversal.id };
  });
}
