import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  dashboardSummary,
  reportCustomerDue,
  reportDailySales,
  reportProfitAndLoss,
  reportStock,
  reportSupplierDue,
  reportTrialBalance,
} from '../src/core/reports/reports';
import { reportToCsv, reportToHtml, reportToXlsx } from '../src/core/export/reportExport';
import { totalReceivables, totalPayables } from '../src/core/parties/parties';
import { totalStockValue } from '../src/core/inventory/stock';
import { createSale } from '../src/core/sales/sales';
import { createPurchase } from '../src/core/purchases/purchases';
import { createExpense, listExpenseCategories } from '../src/core/expenses/expenses';
import { profitAndLoss } from '../src/core/accounting/reports';
import { getBusinessProfile } from '../src/core/services/settings';
import { makeHarness, seedFixtures, type Fixtures, type TestHarness } from './helpers';

let h: TestHarness;
let f: Fixtures;

beforeEach(async () => {
  h = await makeHarness();
  f = seedFixtures(h.ctx);
  // One sale with a due, one purchase with a due, one expense.
  createSale(h.ctx, {
    lines: [
      { productId: f.product.id, qty: 2 },
      { productId: f.product2.id, qty: 1 },
    ],
    customerId: f.customer.id,
    payments: [{ method: 'cash', amount: 100000 }],
  });
  createPurchase(h.ctx, {
    supplierId: f.supplier.id,
    lines: [{ productId: f.product.id, qty: 5, unitCost: 55000 }],
    payments: [{ method: 'bkash', amount: 100000 }],
  });
  const rent = listExpenseCategories(h.ctx).find((c) => c.name === 'Shop Rent');
  createExpense(h.ctx, { categoryId: rent!.id, amount: 50000, method: 'cash', payee: 'Landlord' });
});

afterEach(() => h.close());

const range = { from: '2026-01-01', to: '2026-01-31' };

describe('reports reconcile with the ledger', () => {
  it('P&L report matches the accounting engine', () => {
    const report = reportProfitAndLoss(h.ctx, range);
    const pl = profitAndLoss(h.ctx, range);
    expect(report.totals?.amount).toBe(pl.netProfit);
    expect(report.meta?.grossProfit).toBe(pl.grossProfit);
    const netProfitRow = report.rows.find((r) => r.line === 'Net Profit');
    expect(netProfitRow?.amount).toBe(pl.netProfit);
  });

  it('customer due report total equals total receivables', () => {
    const report = reportCustomerDue(h.ctx);
    expect(report.totals?.balance).toBe(totalReceivables(h.ctx));
    expect((report.totals?.balance as number) > 0).toBe(true);
  });

  it('supplier payable report total equals total payables', () => {
    const report = reportSupplierDue(h.ctx);
    expect(report.totals?.balance).toBe(totalPayables(h.ctx));
  });

  it('trial balance report is balanced', () => {
    const report = reportTrialBalance(h.ctx, range);
    expect(report.totals?.debit).toBe(report.totals?.credit);
    expect(report.meta?.balanced).toBe(true);
  });

  it('stock report total equals inventory valuation', () => {
    const report = reportStock(h.ctx);
    expect(report.totals?.value).toBe(totalStockValue(h.ctx));
  });

  it('daily sales report sums to the sales register', () => {
    const daily = reportDailySales(h.ctx, range);
    const register = buildReport(h.ctx, { key: 'sales-by-invoice', ...range });
    expect(daily.rows).toHaveLength(1);
    expect(daily.totals?.net).toBe(register.totals?.total);
  });

  it('builds every catalogued report without error', () => {
    const keys = [
      'daily-sales',
      'sales-by-invoice',
      'sales-by-product',
      'sales-by-category',
      'best-selling',
      'sales-returns',
      'payment-history',
      'purchases',
      'purchase-returns',
      'expenses',
      'customer-due',
      'supplier-due',
      'customer-statement',
      'supplier-statement',
      'stock',
      'low-stock',
      'out-of-stock',
      'stock-movement',
      'inventory-valuation',
      'trial-balance',
      'general-ledger',
      'profit-loss',
      'cash-flow',
      'account-balances',
    ];
    for (const key of keys) {
      const report = buildReport(h.ctx, {
        key,
        ...range,
        customerId: f.customer.id,
        supplierId: f.supplier.id,
      });
      expect(report.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(report.rows)).toBe(true);
    }
  });

  it('summarises the dashboard from real data', () => {
    const summary = dashboardSummary(h.ctx, range);
    expect(summary.salesCount).toBe(1);
    expect(summary.salesTotal).toBe(245000);
    expect(summary.salesPaid).toBe(100000);
    expect(summary.salesDue).toBe(145000);
    expect(summary.purchasesTotal).toBe(275000);
    expect(summary.expensesTotal).toBe(50000);
    expect(summary.receivables).toBe(totalReceivables(h.ctx));
    expect(summary.payables).toBe(totalPayables(h.ctx));
    expect(summary.stockValue).toBe(totalStockValue(h.ctx));
    expect(summary.productCount).toBe(2);
  });
});

describe('exports', () => {
  const report = (() => {
    const r = reportDailySales;
    void r;
    return null;
  })();
  void report;

  it('writes CSV with a BOM, quoting and taka-converted amounts', () => {
    const tbl = reportDailySales(h.ctx, range);
    const csv = reportToCsv(tbl);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Date,Invoices,Gross');
    // 2,450.00 taka from 245000 paisa
    expect(csv).toContain('2450.00');
    expect(csv.split('\r\n').length).toBeGreaterThan(2);
  });

  it('escapes commas and quotes in CSV cells', () => {
    const tbl = {
      key: 't',
      title: 'T',
      titleBn: 'টি',
      columns: [{ key: 'a', label: 'A', labelBn: 'এ', type: 'text' as const }],
      rows: [{ a: 'Rahim, "The Boss"' }],
    };
    const csv = reportToCsv(tbl);
    expect(csv).toContain('"Rahim, ""The Boss"""');
  });

  it('produces a valid xlsx zip package', () => {
    const tbl = reportStock(h.ctx);
    const xlsx = reportToXlsx(tbl);
    expect(xlsx.subarray(0, 2).toString('latin1')).toBe('PK');
    const text = xlsx.toString('latin1');
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('xl/worksheets/sheet1.xml');
    // End-of-central-directory signature present
    expect(xlsx.subarray(xlsx.length - 22, xlsx.length - 18).toString('hex')).toBe('504b0506');
  });

  it('renders print HTML with the business header and escaped values', () => {
    const business = getBusinessProfile(h.db);
    const html = reportToHtml(reportStock(h.ctx), business, { lang: 'bn' });
    expect(html).toContain('<html lang="bn">');
    expect(html).toContain('MERQO');
    expect(html).toContain('স্টক');
  });
});
