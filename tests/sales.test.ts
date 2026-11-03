import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSale, holdSale, listHeldSales, listInvoices, salesTotals, voidSale } from '../src/core/sales/sales';
import { customerBalance } from '../src/core/parties/parties';
import { getStockLevel } from '../src/core/inventory/stock';
import { cashBalance, profitAndLoss } from '../src/core/accounting/reports';
import { findByBarcode, archiveProduct, createProduct } from '../src/core/catalog/catalog';
import { updateSettings } from '../src/core/services/settings';
import { makeHarness, seedFixtures, type Fixtures, type TestHarness } from './helpers';

let h: TestHarness;
let f: Fixtures;

beforeEach(async () => {
  h = await makeHarness();
  f = seedFixtures(h.ctx);
});

afterEach(() => h.close());

describe('sales: totals and arithmetic', () => {
  it('prices a multi-line cart exactly', () => {
    const sale = createSale(h.ctx, {
      lines: [
        { productId: f.product.id, qty: 2 }, // 2 × 1000.00
        { productId: f.product2.id, qty: 3 }, // 3 × 450.00
      ],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 335000 }],
    });
    expect(sale.grossTotal).toBe(335000);
    expect(sale.total).toBe(335000);
    expect(sale.due).toBe(0);
    expect(sale.lines).toHaveLength(2);
    expect(sale.cogs).toBe(2 * 60000 + 3 * 30000);
    expect(sale.profit).toBe(335000 - 210000);
  });

  it('supports fractional quantities for kg items', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: '1.5' }],
      payments: [{ method: 'cash', amount: 150000 }],
    });
    expect(sale.lines[0].qty).toBe(1500);
    expect(sale.total).toBe(150000);
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(8500);
  });

  it('applies item discounts and an invoice discount', () => {
    const sale = createSale(h.ctx, {
      lines: [
        { productId: f.product.id, qty: 1, discount: 10000 },
        { productId: f.product2.id, qty: 1 },
      ],
      invoiceDiscount: 50000,
      payments: [{ method: 'cash', amount: 85000 }],
    });
    expect(sale.itemDiscount).toBe(10000);
    expect(sale.invoiceDiscount).toBe(50000);
    expect(sale.total).toBe(145000 - 60000);
    expect(sale.due).toBe(0);

    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.grossSales).toBe(145000);
    expect(pl.salesDiscount).toBe(60000);
    expect(pl.netSales).toBe(85000);
    expect(pl.costOfGoodsSold).toBe(90000);
    expect(pl.grossProfit).toBe(-5000);
  });

  it('computes VAT when taxation is enabled', () => {
    updateSettings(h.db, { 'tax.enabled': true }, h.clock.nowIso());
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1, taxRateBp: 500 }],
      payments: [{ method: 'cash', amount: 105000 }],
    });
    expect(sale.taxTotal).toBe(5000);
    expect(sale.total).toBe(105000);

    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.netSales).toBe(100000); // VAT is not revenue
    const vat = h.db.sum(
      "SELECT COALESCE(SUM(jl.credit - jl.debit),0) AS v FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.code='2100'",
    );
    expect(vat).toBe(5000);
  });

  it('handles tax-inclusive pricing without changing revenue', () => {
    updateSettings(
      h.db,
      { 'tax.enabled': true, 'tax.prices_include_tax': true },
      h.clock.nowIso(),
    );
    const sale = createSale(h.ctx, {
      // 1,050.00 entered as the shelf price, VAT included.
      lines: [{ productId: f.product.id, qty: 1, unitPrice: 105000, taxRateBp: 500 }],
      payments: [{ method: 'cash', amount: 105000 }],
    });
    expect(sale.total).toBe(105000);
    expect(sale.taxTotal).toBe(5000);
    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.grossSales).toBe(100000);
  });
});

describe('sales: validation and safety', () => {
  it('blocks a sale that exceeds available stock', () => {
    expect(() =>
      createSale(h.ctx, {
        lines: [{ productId: f.product.id, qty: 11 }],
        payments: [{ method: 'cash', amount: 1100000 }],
      }),
    ).toThrow(/Not enough stock/);
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(10000);
  });

  it('requires a customer when the invoice carries a due', () => {
    expect(() =>
      createSale(h.ctx, {
        lines: [{ productId: f.product.id, qty: 1 }],
        payments: [{ method: 'cash', amount: 40000 }],
      }),
    ).toThrow(/customer must be selected/i);
  });

  it('rejects an overpayment', () => {
    expect(() =>
      createSale(h.ctx, {
        lines: [{ productId: f.product.id, qty: 1 }],
        payments: [{ method: 'cash', amount: 150000 }],
      }),
    ).toThrow(/exceeds the invoice total/i);
  });

  it('rejects an empty cart and zero quantities', () => {
    expect(() => createSale(h.ctx, { lines: [], payments: [] })).toThrow();
    expect(() =>
      createSale(h.ctx, { lines: [{ productId: f.product.id, qty: 0 }], payments: [] }),
    ).toThrow();
  });

  it('rejects unknown payment methods', () => {
    expect(() =>
      createSale(h.ctx, {
        lines: [{ productId: f.product.id, qty: 1 }],
        payments: [{ method: 'crypto', amount: 100000 }],
      }),
    ).toThrow();
  });

  it('does not sell archived products', () => {
    archiveProduct(h.ctx, f.product.id);
    expect(() =>
      createSale(h.ctx, {
        lines: [{ productId: f.product.id, qty: 1 }],
        payments: [{ method: 'cash', amount: 100000 }],
      }),
    ).toThrow(/archived/i);
  });

  it('enforces the customer credit limit', () => {
    const customer = h.db.get<{ id: string }>('SELECT id FROM customers WHERE id = ?', [
      f.customer.id,
    ]);
    expect(customer).toBeTruthy();
    h.db.run('UPDATE customers SET credit_limit = 50000 WHERE id = ?', [f.customer.id]);
    expect(() =>
      createSale(h.ctx, {
        lines: [{ productId: f.product.id, qty: 1 }],
        customerId: f.customer.id,
        payments: [{ method: 'cash', amount: 40000 }],
      }),
    ).toThrow(/Credit limit exceeded/i);
  });

  it('prevents duplicate submission with an idempotency token', () => {
    const token = 'pos-submit-1';
    const first = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      payments: [{ method: 'cash', amount: 100000 }],
      clientToken: token,
    });
    const second = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      payments: [{ method: 'cash', amount: 100000 }],
      clientToken: token,
    });
    expect(second.idempotentReplay).toBe(true);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect(h.db.count('sales_invoices')).toBe(1);
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(9000);
  });

  it('resolves products by barcode and by SKU', () => {
    const byBarcode = findByBarcode(h.ctx, '8901234567890');
    expect(byBarcode?.id).toBe(f.product.id);
    const bySku = findByBarcode(h.ctx, f.product.sku);
    expect(bySku?.id).toBe(f.product.id);
    expect(findByBarcode(h.ctx, 'does-not-exist')).toBeUndefined();
  });
});

describe('sales: voiding', () => {
  it('voids an unpaid, unreturned invoice and restores stock and books', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 2 }],
      customerId: f.customer.id,
    });
    expect(customerBalance(h.ctx, f.customer.id)).toBe(200000);
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(8000);

    voidSale(h.ctx, sale.invoiceId, 'Customer cancelled before payment');

    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(10000);
    expect(customerBalance(h.ctx, f.customer.id)).toBe(0);
    const invoice = h.db.get<{ status: string; due: number }>(
      'SELECT status, due FROM sales_invoices WHERE id = ?',
      [sale.invoiceId],
    );
    expect(invoice?.status).toBe('voided');
    expect(invoice?.due).toBe(0);

    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.netSales).toBe(0);
    expect(pl.costOfGoodsSold).toBe(0);
  });

  it('refuses to void an invoice that has payments', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      payments: [{ method: 'cash', amount: 100000 }],
    });
    expect(() => voidSale(h.ctx, sale.invoiceId, 'mistake')).toThrow(/cannot be voided/i);
  });
});

describe('sales: listing and held carts', () => {
  it('lists invoices with aggregated totals', () => {
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 60000 }],
    });
    createSale(h.ctx, {
      lines: [{ productId: f.product2.id, qty: 2 }],
      payments: [{ method: 'bkash', amount: 90000 }],
    });
    const list = listInvoices(h.ctx, {});
    expect(list.total).toBe(2);
    expect(list.totals.total).toBe(190000);
    expect(list.totals.paid).toBe(150000);
    expect(list.totals.due).toBe(40000);
  });

  it('parks and resumes a cart', () => {
    holdSale(h.ctx, { label: 'Table 3', payload: { lines: [{ productId: f.product.id, qty: 1 }] } });
    const held = listHeldSales(h.ctx);
    expect(held).toHaveLength(1);
    expect(held[0].label).toBe('Table 3');
  });

  it('summarises the trading day for the dashboard', () => {
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      payments: [{ method: 'cash', amount: 100000 }],
    });
    const totals = salesTotals(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(totals.count).toBe(1);
    expect(totals.total).toBe(100000);
    expect(totals.profit).toBe(40000);
    expect(cashBalance(h.ctx)).toBe(100000);
  });
});
