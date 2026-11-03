import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPurchase, listPurchases, voidPurchase } from '../src/core/purchases/purchases';
import { paySupplier, receiveFromCustomer } from '../src/core/payments/payments';
import { customerBalance, supplierBalance } from '../src/core/parties/parties';
import { getStockLevel, reconcileInventoryWithLedger } from '../src/core/inventory/stock';
import { cashBalance, profitAndLoss } from '../src/core/accounting/reports';
import { createSale } from '../src/core/sales/sales';
import { createExpense, listExpenseCategories } from '../src/core/expenses/expenses';
import { makeHarness, seedFixtures, type Fixtures, type TestHarness } from './helpers';

let h: TestHarness;
let f: Fixtures;

beforeEach(async () => {
  h = await makeHarness();
  f = seedFixtures(h.ctx);
});

afterEach(() => h.close());

describe('purchases: costing and payables', () => {
  it('capitalises additional cost into the moving average', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 10, unitCost: 50000 }],
      additionalCost: 10000, // ৳100 transport for the whole lot
      payments: [{ method: 'cash', amount: 100000 }],
    });
    // 10 × 500.00 = 5,000 + 100 transport = 5,100
    expect(purchase.total).toBe(510000);
    expect(purchase.capitalized).toBe(510000);
    expect(purchase.due).toBe(410000);

    const level = getStockLevel(h.ctx, f.product.id);
    expect(level.qty).toBe(20000); // 10 opening + 10 purchased
    expect(level.value).toBe(600000 + 510000);
    // (600000 + 510000) / 20 units = 555.00 per unit
    expect(level.unit_cost).toBe(55500);

    expect(reconcileInventoryWithLedger(h.ctx).ok).toBe(true);
  });

  it('records the supplier payable and settles it partially', () => {
    createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 5, unitCost: 55000 }],
      payments: [{ method: 'cash', amount: 100000 }],
    });
    expect(supplierBalance(h.ctx, f.supplier.id)).toBe(275000 - 100000);

    const payment = paySupplier(h.ctx, {
      supplierId: f.supplier.id,
      amount: 100000,
      method: 'bank',
    });
    expect(payment.newBalance).toBe(75000);
    expect(supplierBalance(h.ctx, f.supplier.id)).toBe(75000);
  });

  it('refuses to pay a supplier more than the outstanding payable', () => {
    createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 1, unitCost: 50000 }],
    });
    expect(() =>
      paySupplier(h.ctx, { supplierId: f.supplier.id, amount: 60000, method: 'cash' }),
    ).toThrow(/exceeds the payable/i);
  });

  it('distributes an invoice discount across purchase lines', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [
        { productId: f.product.id, qty: 1, unitCost: 100000 },
        { productId: f.product2.id, qty: 1, unitCost: 100000 },
      ],
      invoiceDiscount: 50000,
      payments: [{ method: 'cash', amount: 150000 }],
    });
    expect(purchase.total).toBe(150000);
    expect(purchase.lines[0].stockValue + purchase.lines[1].stockValue).toBe(150000);
  });

  it('uses landed cost for COGS when the goods are sold', () => {
    createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 10, unitCost: 50000 }],
      additionalCost: 10000,
      payments: [{ method: 'cash', amount: 510000 }],
    });
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 4 }],
      payments: [{ method: 'cash', amount: 400000 }],
    });
    // Average cost 555.00 × 4 = 2,220
    expect(sale.cogs).toBe(222000);
    expect(reconcileInventoryWithLedger(h.ctx).ok).toBe(true);
  });

  it('lists purchases with totals', () => {
    createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 2, unitCost: 50000 }],
      payments: [{ method: 'cash', amount: 50000 }],
    });
    const list = listPurchases(h.ctx, {});
    expect(list.total).toBe(1);
    expect(list.totals.total).toBe(100000);
    expect(list.totals.due).toBe(50000);
  });
});

describe('purchases: voiding', () => {
  it('voids an unpaid purchase and removes the stock', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 5, unitCost: 50000 }],
    });
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(15000);
    voidPurchase(h.ctx, purchase.purchaseId, 'Wrong quantity entered');
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(10000);
    expect(supplierBalance(h.ctx, f.supplier.id)).toBe(0);
    expect(reconcileInventoryWithLedger(h.ctx).ok).toBe(true);
  });

  it('refuses to void a purchase that has already been paid', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product.id, qty: 5, unitCost: 50000 }],
      payments: [{ method: 'cash', amount: 250000 }],
    });
    expect(() => voidPurchase(h.ctx, purchase.purchaseId, 'mistake')).toThrow(/cannot be voided/i);
  });

  it('refuses to void a purchase whose goods were sold', () => {
    const purchase = createPurchase(h.ctx, {
      supplierId: f.supplier.id,
      lines: [{ productId: f.product2.id, qty: 20, unitCost: 30000 }],
    });
    createSale(h.ctx, {
      lines: [{ productId: f.product2.id, qty: 25 }],
      payments: [{ method: 'cash', amount: 1125000 }],
    });
    expect(() => voidPurchase(h.ctx, purchase.purchaseId, 'too late')).toThrow(/already been sold/i);
  });
});

describe('expenses affect profit and cash', () => {
  it('posts an expense to the ledger and P&L', () => {
    const category = listExpenseCategories(h.ctx).find((c) => c.name === 'Shop Rent');
    expect(category).toBeTruthy();
    createExpense(h.ctx, { categoryId: category!.id, amount: 200000, method: 'cash' });
    expect(cashBalance(h.ctx)).toBe(-200000);
    const pl = profitAndLoss(h.ctx, { from: '2026-01-01', to: '2026-01-01' });
    expect(pl.totalOperatingExpenses).toBe(200000);
    expect(pl.netProfit).toBe(-200000);
  });
});

describe('customer receipts', () => {
  it('allocates a receipt across the oldest open invoices first', () => {
    const sale1 = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 60000 }],
    });
    h.clock.advanceMinutes(60);
    const sale2 = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      customerId: f.customer.id,
      payments: [{ method: 'cash', amount: 50000 }],
    });
    const receipt = receiveFromCustomer(h.ctx, {
      customerId: f.customer.id,
      amount: 70000,
      method: 'cash',
    });
    expect(receipt.allocations).toHaveLength(2);
    const inv1 = h.db.get<{ due: number }>('SELECT due FROM sales_invoices WHERE id = ?', [
      sale1.invoiceId,
    ]);
    const inv2 = h.db.get<{ due: number }>('SELECT due FROM sales_invoices WHERE id = ?', [
      sale2.invoiceId,
    ]);
    expect(inv1?.due).toBe(0); // 40,000 fully settled
    expect(inv2?.due).toBe(20000); // 50,000 - 30,000
    expect(customerBalance(h.ctx, f.customer.id)).toBe(20000);
  });
});
