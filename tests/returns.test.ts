import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSale } from '../src/core/sales/sales';
import {
  createPurchaseReturn,
  createSalesReturn,
  listPurchaseReturns,
  listSalesReturns,
  returnableInvoiceLines,
} from '../src/core/returns/returns';
import { createPurchase } from '../src/core/purchases/purchases';
import { customerBalance, supplierBalance } from '../src/core/parties/parties';
import { getStockLevel, reconcileInventoryWithLedger } from '../src/core/inventory/stock';
import { cashBalance, profitAndLoss } from '../src/core/accounting/reports';
import { makeHarness, seedFixtures, type Fixtures, type TestHarness } from './helpers';

let h: TestHarness;
let f: Fixtures;

beforeEach(async () => {
  h = await makeHarness();
  f = seedFixtures(h.ctx);
});

afterEach(() => h.close());

describe('sales returns', () => {
  it('refunds part of an invoice, restores stock and reverses the right amounts', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 5 }],
      payments: [{ method: 'cash', amount: 500000 }],
    });
    const lines = returnableInvoiceLines(h.ctx, sale.invoiceId);
    expect(lines[0].returnable).toBe(5000);

    const ret = createSalesReturn(h.ctx, {
      invoiceId: sale.invoiceId,
      lines: [{ saleLineId: lines[0].lineId, qty: 2 }],
      refundMethod: 'cash',
      restock: 'resalable',
      reason: 'Customer changed mind',
    });

    // 2 × 1,000.00 = 2,000.00 refunded; cost 2 × 600.00 restored
    expect(ret.total).toBe(200000);
    expect(ret.cogsReversed).toBe(120000);
    expect(cashBalance(h.ctx)).toBe(500000 - 200000);
    // 10 opening - 5 sold + 2 returned = 7 units (milli-units: 7,000)
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(7000);

    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.grossSales).toBe(500000);
    expect(pl.salesReturns).toBe(200000);
    expect(pl.netSales).toBe(300000);
    expect(pl.costOfGoodsSold).toBe(180000); // 5 × 600 - 2 × 600
    expect(pl.grossProfit).toBe(120000);

    expect(reconcileInventoryWithLedger(h.ctx).ok).toBe(true);
    expect(listSalesReturns(h.ctx)).toHaveLength(1);
  });

  it('does not restock damaged goods but still refunds the customer', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 2 }],
      payments: [{ method: 'cash', amount: 200000 }],
    });
    const lines = returnableInvoiceLines(h.ctx, sale.invoiceId);
    const ret = createSalesReturn(h.ctx, {
      invoiceId: sale.invoiceId,
      lines: [{ saleLineId: lines[0].lineId, qty: 1 }],
      refundMethod: 'cash',
      restock: 'damaged',
      reason: 'Pack damaged',
    });
    expect(ret.total).toBe(100000);
    expect(ret.cogsReversed).toBe(0);
    // Still 8 on hand: the damaged unit is not resalable.
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(8000);
    // Cost of the damaged unit stays in COGS (a real loss).
    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.costOfGoodsSold).toBe(120000);
    expect(reconcileInventoryWithLedger(h.ctx).ok).toBe(true);
  });

  it('blocks a return larger than the sold quantity', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 2 }],
      payments: [{ method: 'cash', amount: 200000 }],
    });
    const lines = returnableInvoiceLines(h.ctx, sale.invoiceId);
    expect(() =>
      createSalesReturn(h.ctx, {
        invoiceId: sale.invoiceId,
        lines: [{ saleLineId: lines[0].lineId, qty: 3 }],
        refundMethod: 'cash',
        reason: 'too many',
      }),
    ).toThrow(/exceeds the eligible quantity/i);
  });

  it('prevents returning the same quantity twice', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 2 }],
      payments: [{ method: 'cash', amount: 200000 }],
    });
    const lines = returnableInvoiceLines(h.ctx, sale.invoiceId);
    createSalesReturn(h.ctx, {
      invoiceId: sale.invoiceId,
      lines: [{ saleLineId: lines[0].lineId, qty: 2 }],
      refundMethod: 'cash',
      reason: 'all back',
    });
    const after = returnableInvoiceLines(h.ctx, sale.invoiceId);
    expect(after[0].returnable).toBe(0);
    expect(() =>
      createSalesReturn(h.ctx, {
        invoiceId: sale.invoiceId,
        lines: [{ saleLineId: lines[0].lineId, qty: 1 }],
        refundMethod: 'cash',
        reason: 'again',
      }),
    ).toThrow();
  });

  it('reduces the customer balance when refunded as credit', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 2 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 100000 }],
    });
    expect(customerBalance(h.ctx, f.customer.id)).toBe(100000);
    const lines = returnableInvoiceLines(h.ctx, sale.invoiceId);
    createSalesReturn(h.ctx, {
      invoiceId: sale.invoiceId,
      lines: [{ saleLineId: lines[0].lineId, qty: 1 }],
      refundMethod: 'credit',
      reason: 'Adjusted against due',
    });
    expect(customerBalance(h.ctx, f.customer.id)).toBe(0);
    const invoice = h.db.get<{ due: number }>('SELECT due FROM sales_invoices WHERE id = ?', [
      sale.invoiceId,
    ]);
    expect(invoice?.due).toBe(0);
  });

  it('refuses a cash refund while the invoice still has a due', () => {
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 2 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 100000 }],
    });
    const lines = returnableInvoiceLines(h.ctx, sale.invoiceId);
    expect(() =>
      createSalesReturn(h.ctx, {
        invoiceId: sale.invoiceId,
        lines: [{ saleLineId: lines[0].lineId, qty: 1 }],
        refundMethod: 'cash',
        reason: 'cash back',
      }),
    ).toThrow(/outstanding balance/i);
  });
});

describe('purchase returns', () => {
  it('returns goods to the supplier at landed cost and reduces the payable', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 10, unitCost: 50000 }],
      additionalCost: 10000,
      payments: [{ method: 'cash', amount: 200000 }],
    });
    expect(supplierBalance(h.ctx, f.supplier.id)).toBe(510000 - 200000);

    const valueBefore = getStockLevel(h.ctx, f.product.id).value;
    const ret = createPurchaseReturn(h.ctx, {
      purchaseId: purchase.purchaseId,
      lines: [{ purchaseLineId: purchase.lines[0].id, qty: 2 }],
      settlement: 'payable',
      reason: 'Damaged in transit',
    });

    // 2 units at landed cost 510.00 = 1,020.00
    expect(ret.total).toBe(102000);
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(18000);
    expect(valueBefore - getStockLevel(h.ctx, f.product.id).value).toBe(102000);
    expect(supplierBalance(h.ctx, f.supplier.id)).toBe(310000 - 102000);
    expect(listPurchaseReturns(h.ctx)).toHaveLength(1);
    expect(reconcileInventoryWithLedger(h.ctx).ok).toBe(true);
  });

  it('refuses to return more than was purchased', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 3, unitCost: 50000 }],
    });
    expect(() =>
      createPurchaseReturn(h.ctx, {
        purchaseId: purchase.purchaseId,
        lines: [{ purchaseLineId: purchase.lines[0].id, qty: 4 }],
        settlement: 'payable',
        reason: 'too many',
      }),
    ).toThrow(/exceeds the eligible quantity/i);
  });

  it('refuses to return goods that have already been sold', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product2.id, qty: 10, unitCost: 30000 }],
    });
    createSale(h.ctx, {
      lines: [{ productId: f.product2.id, qty: 25 }], // 20 opening + 10 purchased - 5 left
      payments: [{ method: 'cash', amount: 1125000 }],
    });
    expect(() =>
      createPurchaseReturn(h.ctx, {
        purchaseId: purchase.purchaseId,
        lines: [{ purchaseLineId: purchase.lines[0].id, qty: 8 }],
        settlement: 'payable',
        reason: 'already sold',
      }),
    ).toThrow(/enough stock/i);
  });
});
