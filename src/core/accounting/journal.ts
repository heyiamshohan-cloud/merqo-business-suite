/**
 * Double-entry journal engine.
 *
 * Invariants enforced here (not in the UI):
 *  1. A journal entry has at least two lines.
 *  2. Each line carries exactly one of debit / credit, and it is positive.
 *  3. Total debits === total credits, exactly, in integer paisa.
 *  4. Every referenced account exists, is active and is a system-known code.
 *  5. Posted entries are immutable — corrections happen by posting a reversal
 *     entry, never by editing history.
 */
import { AppError, BusinessRuleError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import type { Ctx } from '../kernel';
import { nextSequence } from '../services/settings';

export type PartyType = 'customer' | 'supplier';

export interface PartyRef {
  type: PartyType;
  id: string;
}

export interface JournalLineInput {
  /** Account code from ACC (preferred) or a raw account id. */
  accountCode?: string;
  accountId?: string;
  debit?: number;
  credit?: number;
  party?: PartyRef;
  memo?: string;
}

export interface PostJournalInput {
  memo: string;
  sourceType: string;
  sourceId?: string | null;
  lines: JournalLineInput[];
  /** Explicit instant (defaults to clock.nowIso()). */
  at?: string;
  bizDate?: string;
}

export interface PostedJournal {
  id: string;
  entryNo: number;
  at: string;
  bizDate: string;
  totalDebit: number;
  totalCredit: number;
}

function accountIdByCode(ctx: Ctx, code: string): string {
  const row = ctx.db.get<{ id: string; is_active: number }>(
    'SELECT id, is_active FROM accounts WHERE code = ?',
    [code],
  );
  if (!row) {
    throw new AppError(`Unknown account code: ${code}`, {
      code: 'ACCOUNT_NOT_FOUND',
      messageBn: 'হিসাব খাত পাওয়া যায়নি।',
      details: { code },
    });
  }
  if (row.is_active !== 1) {
    throw new BusinessRuleError(
      'ACCOUNT_NOT_FOUND',
      `Account ${code} is inactive`,
      'এই হিসাব খাতটি নিষ্ক্রিয় করা হয়েছে।',
      { code },
    );
  }
  return row.id;
}

export function resolveAccountId(ctx: Ctx, opts: { code?: string; id?: string }): string {
  if (opts.id) {
    const row = ctx.db.get<{ id: string }>('SELECT id FROM accounts WHERE id = ?', [opts.id]);
    if (!row) {
      throw new AppError(`Unknown account id: ${opts.id}`, {
        code: 'ACCOUNT_NOT_FOUND',
        messageBn: 'হিসাব খাত পাওয়া যায়নি।',
      });
    }
    return row.id;
  }
  if (!opts.code) {
    throw new ValidationError('An account code is required', 'হিসাব খাত নির্দিষ্ট করা হয়নি।');
  }
  return accountIdByCode(ctx, opts.code);
}

/**
 * Validate a set of journal lines and post them atomically.
 * Callers are expected to already be inside a transaction; this function does
 * not open one so it can compose with the sale/purchase workflows.
 */
export function postJournal(ctx: Ctx, input: PostJournalInput): PostedJournal {
  const { db, clock } = ctx;
  const at = input.at ?? clock.nowIso();
  const bizDate = input.bizDate ?? clock.bizDateOf(at);

  if (!input.memo || input.memo.trim() === '') {
    throw new ValidationError('Journal memo is required', 'জার্নালের বিবরণ প্রয়োজন।');
  }
  if (input.lines.length < 2) {
    throw new BusinessRuleError(
      'UNBALANCED_JOURNAL',
      'A journal entry requires at least two lines',
      'জার্নাল এন্ট্রিতে কমপক্ষে দুইটি লাইন থাকতে হবে।',
      { lines: input.lines.length },
    );
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const prepared = input.lines.map((line, index) => {
    const debit = line.debit ?? 0;
    const credit = line.credit ?? 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
      throw new ValidationError(
        `Journal line ${index + 1} must be a whole number of paisa`,
        'জার্নালের প্রতিটি টাকার পরিমাণ পূর্ণ সংখ্যা হতে হবে।',
        { line: index + 1, debit, credit },
      );
    }
    if (debit < 0 || credit < 0) {
      throw new ValidationError(
        `Journal line ${index + 1} cannot be negative`,
        'জার্নালে ঋণাত্মক পরিমাণ গ্রহণযোগ্য নয়।',
        { line: index + 1 },
      );
    }
    if (debit > 0 && credit > 0) {
      throw new ValidationError(
        `Journal line ${index + 1} cannot be both debit and credit`,
        'একই লাইনে ডেবিট ও ক্রেডিট একসাথে হতে পারে না।',
        { line: index + 1 },
      );
    }
    if (debit === 0 && credit === 0) {
      throw new ValidationError(
        `Journal line ${index + 1} has no amount`,
        'জার্নাল লাইনে কোনো টাকার পরিমাণ নেই।',
        { line: index + 1 },
      );
    }
    if (line.party && !line.party.id) {
      throw new ValidationError(
        `Journal line ${index + 1} has an empty party reference`,
        'পক্ষের তথ্য অসম্পূর্ণ।',
        { line: index + 1 },
      );
    }
    totalDebit += debit;
    totalCredit += credit;
    return {
      accountId: resolveAccountId(ctx, { code: line.accountCode, id: line.accountId }),
      debit,
      credit,
      party: line.party ?? null,
      memo: line.memo ?? null,
    };
  });

  if (totalDebit !== totalCredit) {
    throw new BusinessRuleError(
      'UNBALANCED_JOURNAL',
      `Journal is not balanced: debits ${totalDebit} != credits ${totalCredit}`,
      'জার্নালের ডেবিট ও ক্রেডিট সমান নয় — এন্ট্রি সংরক্ষণ করা হয়নি।',
      { totalDebit, totalCredit, difference: totalDebit - totalCredit },
    );
  }
  if (totalDebit === 0) {
    throw new BusinessRuleError(
      'UNBALANCED_JOURNAL',
      'Journal entry has no monetary value',
      'জার্নাল এন্ট্রিতে কোনো টাকার পরিমাণ নেই।',
    );
  }

  const entryId = newId();
  const entryNo = nextSequence(db, 'journal').value;
  db.run(
    `INSERT INTO journal_entries
      (id, entry_no, at, biz_date, memo, source_type, source_id, user_id, created_at, is_reversal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      entryId,
      entryNo,
      at,
      bizDate,
      input.memo.trim(),
      input.sourceType,
      input.sourceId ?? null,
      ctx.userId,
      clock.nowIso(),
    ],
  );

  let lineNo = 0;
  for (const line of prepared) {
    lineNo++;
    db.run(
      `INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit, credit, party_type, party_id, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        entryId,
        lineNo,
        line.accountId,
        line.debit,
        line.credit,
        line.party?.type ?? null,
        line.party?.id ?? null,
        line.memo,
      ],
    );
  }

  return { id: entryId, entryNo, at, bizDate, totalDebit, totalCredit };
}

/**
 * Post the mirror image of an existing entry and link both directions.
 * Used for voids, reversals and corrections. The original entry is never
 * mutated apart from the back-reference.
 */
export function reverseJournal(ctx: Ctx, entryId: string, memo: string): PostedJournal {
  const { db, clock } = ctx;
  const entry = db.get<{
    id: string;
    at: string;
    biz_date: string;
    is_reversal: number;
    reversed_by_entry_id: string | null;
  }>('SELECT id, at, biz_date, is_reversal, reversed_by_entry_id FROM journal_entries WHERE id = ?', [
    entryId,
  ]);
  if (!entry) {
    throw new AppError(`Journal entry not found: ${entryId}`, {
      code: 'NOT_FOUND',
      messageBn: 'জার্নাল এন্ট্রি পাওয়া যায়নি।',
    });
  }
  if (entry.is_reversal === 1) {
    throw new BusinessRuleError(
      'IMMUTABLE_RECORD',
      'A reversal entry cannot itself be reversed',
      'বিপরীত এন্ট্রিকে পুনরায় বিপরীত করা যায় না।',
      { entryId },
    );
  }
  if (entry.reversed_by_entry_id) {
    throw new BusinessRuleError(
      'IMMUTABLE_RECORD',
      'This entry has already been reversed',
      'এই এন্ট্রি ইতিমধ্যে বিপরীত করা হয়েছে।',
      { entryId },
    );
  }

  const lines = db.all<{
    account_id: string;
    debit: number;
    credit: number;
    party_type: PartyType | null;
    party_id: string | null;
    memo: string | null;
  }>('SELECT account_id, debit, credit, party_type, party_id, memo FROM journal_lines WHERE entry_id = ? ORDER BY line_no', [
    entryId,
  ]);

  const at = clock.nowIso();
  const reversal = postJournal(ctx, {
    memo: `Reversal: ${memo}`,
    sourceType: 'reversal',
    sourceId: entryId,
    at,
    bizDate: clock.bizDateOf(at),
    lines: lines.map((l) => ({
      accountId: l.account_id,
      debit: l.credit,
      credit: l.debit,
      party: l.party_type && l.party_id ? { type: l.party_type, id: l.party_id } : undefined,
      memo: l.memo ?? undefined,
    })),
  });

  db.run('UPDATE journal_entries SET is_reversal = 1, reverses_entry_id = ? WHERE id = ?', [
    entryId,
    reversal.id,
  ]);
  db.run('UPDATE journal_entries SET reversed_by_entry_id = ? WHERE id = ?', [
    reversal.id,
    entryId,
  ]);

  return reversal;
}

export interface JournalEntryRow {
  id: string;
  entry_no: number;
  at: string;
  biz_date: string;
  memo: string;
  source_type: string;
  source_id: string | null;
  is_reversal: number;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
}

export interface JournalLineRow {
  id: string;
  entry_id: string;
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  account_name_bn: string;
  debit: number;
  credit: number;
  party_type: PartyType | null;
  party_id: string | null;
  memo: string | null;
}

export function getJournalEntry(ctx: Ctx, entryId: string): {
  entry: JournalEntryRow;
  lines: JournalLineRow[];
} {
  const entry = ctx.db.get<JournalEntryRow>('SELECT * FROM journal_entries WHERE id = ?', [entryId]);
  if (!entry) {
    throw new AppError(`Journal entry not found: ${entryId}`, {
      code: 'NOT_FOUND',
      messageBn: 'জার্নাল এন্ট্রি পাওয়া যায়নি।',
    });
  }
  const lines = ctx.db.all<JournalLineRow>(
    `SELECT jl.*, a.code AS account_code, a.name AS account_name, a.name_bn AS account_name_bn
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = ?
      ORDER BY jl.line_no`,
    [entryId],
  );
  return { entry, lines };
}

/** Verify every journal entry in the database balances. Used by health checks. */
export function verifyAllJournalsBalanced(ctx: Ctx): {
  ok: boolean;
  unbalanced: Array<{ entryId: string; debit: number; credit: number }>;
} {
  const rows = ctx.db.all<{ entry_id: string; debit: number; credit: number }>(
    `SELECT entry_id, SUM(debit) AS debit, SUM(credit) AS credit
       FROM journal_lines GROUP BY entry_id
      HAVING SUM(debit) != SUM(credit)`,
  );
  return {
    ok: rows.length === 0,
    unbalanced: rows.map((r) => ({ entryId: r.entry_id, debit: r.debit, credit: r.credit })),
  };
}
