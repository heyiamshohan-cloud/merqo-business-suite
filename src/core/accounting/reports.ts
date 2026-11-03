/**
 * Accounting reports derived directly from the posted journal.
 * These are the authoritative financial statements; every operational report
 * (sales, stock, dues) is reconciled against them in the test suite.
 */
import type { Ctx } from '../kernel';
import type { AccountType } from './accounts';
import { ACC, DEBIT_NORMAL_TYPES } from './accounts';

export interface AccountBalanceRow {
  account_id: string;
  code: string;
  name: string;
  name_bn: string;
  type: AccountType;
  subtype: string | null;
  debit: number;
  credit: number;
  /** Raw journal balance = debit - credit. */
  raw: number;
  /** Balance expressed in the account's natural direction. */
  balance: number;
}

export interface DateWindow {
  from?: string;
  to?: string;
}

function windowClause(w: DateWindow, alias = 'je'): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (w.from) {
    parts.push(`${alias}.biz_date >= ?`);
    params.push(w.from);
  }
  if (w.to) {
    parts.push(`${alias}.biz_date <= ?`);
    params.push(w.to);
  }
  return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

/** Balances for every account with activity in the window. */
export function accountBalances(ctx: Ctx, window: DateWindow = {}): AccountBalanceRow[] {
  const { sql, params } = windowClause(window);
  const rows = ctx.db.all<{
    account_id: string;
    code: string;
    name: string;
    name_bn: string;
    type: AccountType;
    subtype: string | null;
    debit: number;
    credit: number;
  }>(
    `SELECT a.id AS account_id, a.code, a.name, a.name_bn, a.type, a.subtype,
            COALESCE(SUM(jl.debit), 0)  AS debit,
            COALESCE(SUM(jl.credit), 0) AS credit
       FROM accounts a
       JOIN journal_lines jl ON jl.account_id = a.id
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE 1=1 ${sql}
      GROUP BY a.id
      ORDER BY a.code`,
    params,
  );
  return rows.map((r) => {
    const raw = r.debit - r.credit;
    // Contra-revenue accounts (sales discount, sales returns) are debited when
    // they increase, so their natural direction follows the debit side even
    // though the account type is revenue.
    const debitNormal =
      DEBIT_NORMAL_TYPES.includes(r.type) || r.subtype === 'contra_revenue';
    const natural = (debitNormal ? raw : -raw) || 0;
    return { ...r, raw: raw || 0, balance: natural };
  });
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  name_bn: string;
  type: AccountType;
  debit: number;
  credit: number;
}

export interface TrialBalanceResult {
  from?: string;
  to?: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

export function trialBalance(ctx: Ctx, window: DateWindow = {}): TrialBalanceResult {
  const balances = accountBalances(ctx, window);
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const b of balances) {
    if (b.raw === 0) continue;
    if (b.raw > 0) {
      rows.push({ code: b.code, name: b.name, name_bn: b.name_bn, type: b.type, debit: b.raw, credit: 0 });
      totalDebit += b.raw;
    } else {
      rows.push({ code: b.code, name: b.name, name_bn: b.name_bn, type: b.type, debit: 0, credit: -b.raw });
      totalCredit += -b.raw;
    }
  }
  return {
    from: window.from,
    to: window.to,
    rows,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  };
}

export interface LedgerLine {
  entry_id: string;
  entry_no: number;
  at: string;
  biz_date: string;
  memo: string;
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  balance: number;
  party_type: string | null;
  party_id: string | null;
  party_name: string | null;
  source_type: string;
  source_id: string | null;
}

export interface LedgerQuery extends DateWindow {
  accountCode?: string;
  accountCodes?: string[];
  partyType?: 'customer' | 'supplier';
  partyId?: string;
  /** Opening balance date (exclusive start) — computed automatically from `from`. */
  includeOpening?: boolean;
}

function buildLedgerWhere(q: LedgerQuery): { sql: string; params: Array<string | number> } {
  const parts: string[] = [];
  const params: Array<string | number> = [];
  if (q.accountCode) {
    parts.push('a.code = ?');
    params.push(q.accountCode);
  }
  if (q.accountCodes && q.accountCodes.length > 0) {
    parts.push(`a.code IN (${q.accountCodes.map(() => '?').join(',')})`);
    params.push(...q.accountCodes);
  }
  if (q.partyType) {
    parts.push('jl.party_type = ?');
    params.push(q.partyType);
  }
  if (q.partyId) {
    parts.push('jl.party_id = ?');
    params.push(q.partyId);
  }
  if (q.from) {
    parts.push('je.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    parts.push('je.biz_date <= ?');
    params.push(q.to);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}

export interface LedgerResult {
  lines: LedgerLine[];
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
}

/**
 * General / account / party ledger with a running balance.
 * `balance` is expressed as debit-minus-credit so it is meaningful for any
 * account type (negative = credit balance).
 */
export function ledger(ctx: Ctx, q: LedgerQuery): LedgerResult {
  const opening = q.from
    ? ctx.db.sum(
        `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.biz_date < ? ${q.accountCode ? 'AND a.code = ?' : ''}
            ${q.accountCodes && q.accountCodes.length ? `AND a.code IN (${q.accountCodes.map(() => '?').join(',')})` : ''}
            ${q.partyId ? 'AND jl.party_id = ?' : ''}
            ${q.partyType ? 'AND jl.party_type = ?' : ''}`,
        [
          q.from,
          ...(q.accountCode ? [q.accountCode] : []),
          ...(q.accountCodes ?? []),
          ...(q.partyId ? [q.partyId] : []),
          ...(q.partyType ? [q.partyType] : []),
        ],
      )
    : 0;

  const { sql, params } = buildLedgerWhere(q);
  const rows = ctx.db.all<Omit<LedgerLine, 'balance' | 'party_name'>>(
    `SELECT je.id AS entry_id, je.entry_no, je.at, je.biz_date, je.memo,
            a.code AS account_code, a.name AS account_name,
            jl.debit, jl.credit,
            jl.party_type, jl.party_id,
            je.source_type, je.source_id
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE ${sql}
      ORDER BY je.biz_date ASC, je.entry_no ASC, jl.line_no ASC`,
    params,
  );

  let running = opening;
  let totalDebit = 0;
  let totalCredit = 0;
  const lines: LedgerLine[] = rows.map((r) => {
    running += r.debit - r.credit;
    totalDebit += r.debit;
    totalCredit += r.credit;
    return { ...r, balance: running, party_name: null };
  });

  return {
    lines,
    openingBalance: opening,
    closingBalance: running,
    totalDebit,
    totalCredit,
  };
}

export interface ProfitAndLossResult {
  from: string;
  to: string;
  grossSales: number;
  salesDiscount: number;
  salesReturns: number;
  netSales: number;
  costOfGoodsSold: number;
  grossProfit: number;
  operatingExpenseLines: Array<{ code: string; name: string; name_bn: string; amount: number }>;
  totalOperatingExpenses: number;
  otherIncomeLines: Array<{ code: string; name: string; name_bn: string; amount: number }>;
  totalOtherIncome: number;
  netProfit: number;
}

/**
 * Profit & Loss from posted entries.
 * Revenue accounts are credit-normal; contra-revenue (discount, returns) are
 * presented as reductions of gross sales so the statement reconciles with the
 * ledger to the paisa.
 */
export function profitAndLoss(ctx: Ctx, window: { from: string; to: string }): ProfitAndLossResult {
  const balances = accountBalances(ctx, window);
  const byCode = new Map(balances.map((b) => [b.code, b]));

  const natural = (code: string): number => byCode.get(code)?.balance ?? 0;

  // Revenue accounts: credit-normal => balance is positive when credit.
  const grossSales = natural(ACC.SALES);
  const salesDiscount = natural(ACC.SALES_DISCOUNT);
  const salesReturns = natural(ACC.SALES_RETURNS);
  const netSales = grossSales - salesDiscount - salesReturns;

  const costOfGoodsSold = natural(ACC.COGS);
  const grossProfit = netSales - costOfGoodsSold;

  const operatingExpenseLines = balances
    .filter((b) => b.type === 'expense' && b.subtype !== 'cogs')
    .map((b) => ({ code: b.code, name: b.name, name_bn: b.name_bn, amount: b.balance }))
    .filter((r) => r.amount !== 0);

  const otherIncomeLines = balances
    .filter((b) => b.type === 'revenue' && b.subtype === 'other')
    .map((b) => ({ code: b.code, name: b.name, name_bn: b.name_bn, amount: b.balance }))
    .filter((r) => r.amount !== 0);

  const totalOperatingExpenses = operatingExpenseLines.reduce((a, b) => a + b.amount, 0);
  const totalOtherIncome = otherIncomeLines.reduce((a, b) => a + b.amount, 0);
  const netProfit = grossProfit - totalOperatingExpenses + totalOtherIncome;

  return {
    from: window.from,
    to: window.to,
    grossSales,
    salesDiscount,
    salesReturns,
    netSales,
    costOfGoodsSold,
    grossProfit,
    operatingExpenseLines,
    totalOperatingExpenses,
    otherIncomeLines,
    totalOtherIncome,
    netProfit,
  };
}

export interface BalanceSheetGroup {
  code: string;
  name: string;
  name_bn: string;
  amount: number;
}

export interface BalanceSheetResult {
  asOf: string;
  assets: BalanceSheetGroup[];
  liabilities: BalanceSheetGroup[];
  equity: BalanceSheetGroup[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Net profit not yet closed to equity. */
  currentEarnings: number;
  totalLiabilitiesAndEquity: number;
  balanced: boolean;
}

export function balanceSheet(ctx: Ctx, asOf: string): BalanceSheetResult {
  const balances = accountBalances(ctx, { to: asOf });
  const assets = balances
    .filter((b) => b.type === 'asset')
    .map((b) => ({ code: b.code, name: b.name, name_bn: b.name_bn, amount: b.balance }))
    .filter((r) => r.amount !== 0);
  const liabilities = balances
    .filter((b) => b.type === 'liability')
    .map((b) => ({ code: b.code, name: b.name, name_bn: b.name_bn, amount: b.balance }))
    .filter((r) => r.amount !== 0);
  const equity = balances
    .filter((b) => b.type === 'equity')
    .map((b) => ({ code: b.code, name: b.name, name_bn: b.name_bn, amount: b.balance }))
    .filter((r) => r.amount !== 0);

  const revenueTotal = balances
    .filter((b) => b.type === 'revenue')
    .reduce((a, b) => a + b.balance, 0);
  const expenseTotal = balances
    .filter((b) => b.type === 'expense')
    .reduce((a, b) => a + b.balance, 0);
  const currentEarnings = revenueTotal - expenseTotal;

  const totalAssets = assets.reduce((a, b) => a + b.amount, 0);
  const totalLiabilities = liabilities.reduce((a, b) => a + b.amount, 0);
  const totalEquity = equity.reduce((a, b) => a + b.amount, 0) + currentEarnings;

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    currentEarnings,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

export const CASH_ACCOUNT_CODES: string[] = [
  ACC.CASH,
  ACC.BANK,
  ACC.MFS,
  ACC.CARD_CLEARING,
];

export interface CashFlowRow {
  sourceType: string;
  inflow: number;
  outflow: number;
  net: number;
}

export interface CashFlowResult {
  from: string;
  to: string;
  openingBalance: number;
  rows: CashFlowRow[];
  totalInflow: number;
  totalOutflow: number;
  closingBalance: number;
}

export function cashFlow(ctx: Ctx, window: { from: string; to: string }): CashFlowResult {
  const opening = ctx.db.sum(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.biz_date < ? AND a.code IN (${CASH_ACCOUNT_CODES.map(() => '?').join(',')})`,
    [window.from, ...CASH_ACCOUNT_CODES],
  );

  const rows = ctx.db.all<{ source_type: string; debit: number; credit: number }>(
    `SELECT je.source_type,
            COALESCE(SUM(jl.debit), 0) AS debit,
            COALESCE(SUM(jl.credit), 0) AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.biz_date >= ? AND je.biz_date <= ?
        AND a.code IN (${CASH_ACCOUNT_CODES.map(() => '?').join(',')})
      GROUP BY je.source_type
      ORDER BY je.source_type`,
    [window.from, window.to, ...CASH_ACCOUNT_CODES],
  );

  const mapped: CashFlowRow[] = rows.map((r) => ({
    sourceType: r.source_type,
    inflow: r.debit,
    outflow: r.credit,
    net: r.debit - r.credit,
  }));

  const totalInflow = mapped.reduce((a, b) => a + b.inflow, 0);
  const totalOutflow = mapped.reduce((a, b) => a + b.outflow, 0);

  return {
    from: window.from,
    to: window.to,
    openingBalance: opening,
    rows: mapped,
    totalInflow,
    totalOutflow,
    closingBalance: opening + totalInflow - totalOutflow,
  };
}

/** Cash + bank + MFS balance as of a date. */
export function cashBalance(ctx: Ctx, asOf?: string): number {
  return ctx.db.sum(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE a.code IN (${CASH_ACCOUNT_CODES.map(() => '?').join(',')})
        ${asOf ? 'AND je.biz_date <= ?' : ''}`,
    [...CASH_ACCOUNT_CODES, ...(asOf ? [asOf] : [])],
  );
}
