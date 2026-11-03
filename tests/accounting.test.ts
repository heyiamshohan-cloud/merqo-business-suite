import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACC } from '../src/core/accounting/accounts';
import { postJournal, reverseJournal, verifyAllJournalsBalanced } from '../src/core/accounting/journal';
import {
  accountBalances,
  balanceSheet,
  cashBalance,
  cashFlow,
  ledger,
  profitAndLoss,
  trialBalance,
} from '../src/core/accounting/reports';
import { reconcileInventoryWithLedger, totalStockValue } from '../src/core/inventory/stock';
import { customerBalance } from '../src/core/parties/parties';
import { createSale } from '../src/core/sales/sales';
import { receiveFromCustomer } from '../src/core/payments/payments';
import { currentSchemaVersion } from '../src/core/db/migrator';
import { makeHarness, seedFixtures, type Fixtures, type TestHarness } from './helpers';

let h: TestHarness;
let f: Fixtures;

beforeEach(async () => {
  h = await makeHarness();
  f = seedFixtures(h.ctx);
});

afterEach(() => h.close());

describe('database bootstrap', () => {
  it('applies the initial migration and records it', () => {
    expect(currentSchemaVersion(h.db)).toBe(1);
    const rows = h.db.all<{ version: number }>('SELECT version FROM schema_migrations');
    expect(rows).toHaveLength(1);
  });

  it('seeds a complete chart of accounts', () => {
    const count = h.db.count('accounts');
    expect(count).toBeGreaterThanOrEqual(28);
    const cash = h.db.get<{ id: string; name: string }>('SELECT * FROM accounts WHERE code = ?', [
      ACC.CASH,
    ]);
    expect(cash?.name).toBe('Cash in Hand');
  });

  it('seeds units, expense categories and document sequences', () => {
    expect(h.db.count('units')).toBeGreaterThanOrEqual(10);
    expect(h.db.count('expense_categories')).toBe(8);
    const seq = h.db.get<{ prefix: string }>(
      "SELECT prefix FROM document_sequences WHERE key = 'invoice'",
    );
    expect(seq?.prefix).toBe('INV-');
  });

  it('enables foreign key enforcement', () => {
    expect(() =>
      h.db.run(
        "INSERT INTO product_barcodes (id, product_id, code, kind, is_primary, created_at) VALUES ('x','missing','1','barcode',0,'now')",
      ),
    ).toThrow();
  });
});

describe('journal integrity', () => {
  it('posts a balanced entry and rejects an unbalanced one', () => {
    const ok = postJournal(h.ctx, {
      memo: 'Owner capital',
      sourceType: 'manual',
      lines: [
        { accountCode: ACC.CASH, debit: 500000 },
        { accountCode: ACC.CAPITAL, credit: 500000 },
      ],
    });
    expect(ok.totalDebit).toBe(ok.totalCredit);

    expect(() =>
      postJournal(h.ctx, {
        memo: 'Broken',
        sourceType: 'manual',
        lines: [
          { accountCode: ACC.CASH, debit: 500000 },
          { accountCode: ACC.CAPITAL, credit: 400000 },
        ],
      }),
    ).toThrow(/not balanced/i);
  });

  it('rejects a single-line entry, zero amounts and double-sided lines', () => {
    expect(() =>
      postJournal(h.ctx, {
        memo: 'single',
        sourceType: 'manual',
        lines: [{ accountCode: ACC.CASH, debit: 100 }],
      }),
    ).toThrow();

    expect(() =>
      postJournal(h.ctx, {
        memo: 'zero',
        sourceType: 'manual',
        lines: [
          { accountCode: ACC.CASH, debit: 0 },
          { accountCode: ACC.CAPITAL, credit: 0 },
        ],
      }),
    ).toThrow();

    expect(() =>
      postJournal(h.ctx, {
        memo: 'both',
        sourceType: 'manual',
        lines: [
          { accountCode: ACC.CASH, debit: 100, credit: 100 },
          { accountCode: ACC.CAPITAL, credit: 100 },
        ],
      }),
    ).toThrow();
  });

  it('rejects unknown accounts', () => {
    expect(() =>
      postJournal(h.ctx, {
        memo: 'unknown',
        sourceType: 'manual',
        lines: [
          { accountCode: '9999', debit: 100 },
          { accountCode: ACC.CAPITAL, credit: 100 },
        ],
      }),
    ).toThrow(/Unknown account/);
  });

  it('reverses an entry without mutating the original', () => {
    const entry = postJournal(h.ctx, {
      memo: 'Wrong entry',
      sourceType: 'manual',
      lines: [
        { accountCode: ACC.EXP_RENT, debit: 200000 },
        { accountCode: ACC.CASH, credit: 200000 },
      ],
    });
    const reversal = reverseJournal(h.ctx, entry.id, 'Correction');
    const original = h.db.get<{ reversed_by_entry_id: string }>(
      'SELECT reversed_by_entry_id FROM journal_entries WHERE id = ?',
      [entry.id],
    );
    expect(original?.reversed_by_entry_id).toBe(reversal.id);
    expect(cashBalance(h.ctx)).toBe(0);
    // A reversal can not be reversed again.
    expect(() => reverseJournal(h.ctx, entry.id, 'again')).toThrow();
  });

  it('keeps every journal entry balanced across the whole database', () => {
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 2 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 150000 }],
    });
    const check = verifyAllJournalsBalanced(h.ctx);
    expect(check.ok).toBe(true);
    expect(check.unbalanced).toHaveLength(0);
  });
});

describe('accounting scenario from the specification', () => {
  it('records revenue, COGS, cash and receivable correctly', () => {
    // Sell one unit for ৳1,000 whose cost is ৳600; customer pays ৳700.
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 70000 }],
    });

    expect(sale.total).toBe(100000);
    expect(sale.paid).toBe(70000);
    expect(sale.due).toBe(30000);
    expect(sale.cogs).toBe(60000);
    expect(sale.profit).toBe(40000);

    // Ledger
    expect(cashBalance(h.ctx)).toBe(70000);
    expect(customerBalance(h.ctx, f.customer.id)).toBe(30000);

    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.grossSales).toBe(100000);
    expect(pl.netSales).toBe(100000);
    expect(pl.costOfGoodsSold).toBe(60000);
    expect(pl.grossProfit).toBe(40000);
    expect(pl.netProfit).toBe(40000);

    // Trial balance and balance sheet agree.
    const tb = trialBalance(h.ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    const bs = balanceSheet(h.ctx, '2026-01-01');
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity);

    // Inventory in the books equals the stock valuation engine.
    const recon = reconcileInventoryWithLedger(h.ctx);
    expect(recon.difference).toBe(0);
    expect(recon.ok).toBe(true);
  });

  it('recognises cash receipts separately from revenue', () => {
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 70000 }],
    });
    const cf = cashFlow(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(cf.totalInflow).toBe(70000);
    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    // Revenue recognised is 1,000 although only 700 was received.
    expect(pl.netSales).toBe(100000);
    expect(cashBalance(h.ctx)).toBe(70000);
  });

  it('collects the remaining receivable and clears the customer balance', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 70000 }],
    });
    expect(sale.due).toBe(30000);
    expect(customerBalance(h.ctx, f.customer.id)).toBe(30000);

    const receipt = receiveFromCustomer(h.ctx, {
      customerId: f.customer.id,
      amount: 30000,
      method: 'cash',
    });
    expect(receipt.allocations).toHaveLength(1);
    expect(receipt.newBalance).toBe(0);
    expect(customerBalance(h.ctx, f.customer.id)).toBe(0);
    expect(cashBalance(h.ctx)).toBe(100000);

    const invoice = h.db.get<{ due: number; paid: number }>(
      'SELECT due, paid FROM sales_invoices WHERE id = ?',
      [sale.invoiceId],
    );
    expect(invoice?.due).toBe(0);
    expect(invoice?.paid).toBe(100000);
  });

  it('produces a ledger whose running balance equals the account balance', () => {
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 3 }],
      customerId: f.customer.id,
      payments: [{ method: 'bkash', amount: 100000 }],
    });
    const cashLedger = ledger(h.ctx, { accountCode: ACC.CASH });
    expect(cashLedger.closingBalance).toBe(0); // paid by bKash, not cash
    const mfs = ledger(h.ctx, { accountCode: ACC.MFS });
    expect(mfs.closingBalance).toBe(100000);

    const ar = ledger(h.ctx, { accountCode: ACC.AR, partyType: 'customer', partyId: f.customer.id });
    expect(ar.closingBalance).toBe(200000);
    expect(ar.closingBalance).toBe(customerBalance(h.ctx, f.customer.id));
  });

  it('reports account balances with natural direction', () => {
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 100000 }],
    });
    const balances = accountBalances(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    const sales = balances.find((b) => b.code === ACC.SALES);
    expect(sales?.balance).toBe(100000); // credit-normal revenue shown positive
    const cash = balances.find((b) => b.code === ACC.CASH);
    expect(cash?.balance).toBe(100000);
  });

  it('tracks stock value independently of selling price', () => {
    // Opening stock: 10 rice @ 600 + 20 oil @ 300 = 6000 + 6000 = 12,000
    expect(totalStockValue(h.ctx)).toBe(1200000);
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 100000 }],
    });
    expect(totalStockValue(h.ctx)).toBe(1140000);
    expect(reconcileInventoryWithLedger(h.ctx).ok).toBe(true);
  });
});
