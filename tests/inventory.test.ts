import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adjustStock,
  getStockLevel,
  lowStock,
  outOfStock,
  reconcileInventoryWithLedger,
  stockIn,
  stockMoves,
  stockOut,
  stockValuation,
  totalStockValue,
} from '../src/core/inventory/stock';
import { createSale } from '../src/core/sales/sales';
import { updateSettings } from '../src/core/services/settings';
import { makeHarness, seedFixtures, type Fixtures, type TestHarness } from './helpers';

let h: TestHarness;
let f: Fixtures;

beforeEach(async () => {
  h = await makeHarness();
  f = seedFixtures(h.ctx);
});

afterEach(() => h.close());

describe('moving average costing', () => {
  it('recomputes the average across receipts', () => {
    // Existing: 10 units @ 600 = 6,000
    stockIn(h.ctx, {
      productId: f.product.id,
      qty: 10000,
      totalValue: 400000, // 10 units @ 400
      movement: 'purchase',
      refType: 'test',
    });
    const level = getStockLevel(h.ctx, f.product.id);
    expect(level.qty).toBe(20000);
    expect(level.value).toBe(1000000);
    expect(level.unit_cost).toBe(50000); // (6000 + 4000) / 20 = 500
  });

  it('issues at the average and leaves no residual value when emptied', () => {
    // 10 units worth 6,000 — sell 3 at 1,000 then empty the rest.
    const first = stockOut(h.ctx, {
      productId: f.product.id,
      qty: 3000,
      movement: 'sale',
      refType: 'test',
    });
    expect(first.cogs).toBe(180000);
    const rest = stockOut(h.ctx, {
      productId: f.product.id,
      qty: 7000,
      movement: 'sale',
      refType: 'test',
    });
    expect(rest.cogs).toBe(420000);
    const level = getStockLevel(h.ctx, f.product.id);
    expect(level.qty).toBe(0);
    expect(level.value).toBe(0); // no phantom inventory value
  });

  it('keeps COGS + closing stock equal to the cost of goods available', () => {
    // 10 units @ 600 available = 6,000. Sell 4 => COGS 2,400, stock 3,600.
    stockOut(h.ctx, { productId: f.product.id, qty: 4000, movement: 'sale', refType: 'test' });
    const level = getStockLevel(h.ctx, f.product.id);
    expect(level.value).toBe(360000);
    expect(level.value + 240000).toBe(600000);
  });
});

describe('stock safety', () => {
  it('blocks selling more than is on hand by default', () => {
    expect(() =>
      stockOut(h.ctx, { productId: f.product.id, qty: 11000, movement: 'sale', refType: 'test' }),
    ).toThrow(/Not enough stock/);
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(10000);
  });

  it('allows negative stock only when explicitly enabled', () => {
    updateSettings(h.db, { 'inventory.allow_negative': true }, h.clock.nowIso());
    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 12 }],
      payments: [{ method: 'cash', amount: 1200000 }],
    });
    expect(sale.invoiceNo).toBe('INV-000001');
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(-2000);
  });

  it('requires a reason for manual adjustments', () => {
    expect(() =>
      adjustStock(h.ctx, { productId: f.product.id, newQty: 9000, reason: '' }),
    ).toThrow(/reason/i);
  });

  it('records downward adjustments as a loss of value', () => {
    const adj = adjustStock(h.ctx, {
      productId: f.product.id,
      newQty: 9000,
      reason: 'Damaged in store',
      movement: 'damage',
    });
    expect(adj.deltaQty).toBe(-1000);
    expect(adj.valueDelta).toBe(-60000);
    expect(adj.after.value).toBe(540000);
  });

  it('records upward adjustments at the current average cost', () => {
    const adj = adjustStock(h.ctx, {
      productId: f.product.id,
      deltaQty: 1000,
      reason: 'Physical count found extra unit',
    });
    expect(adj.deltaQty).toBe(1000);
    expect(adj.valueDelta).toBe(60000);
    expect(getStockLevel(h.ctx, f.product.id).qty).toBe(11000);
  });

  it('never changes stock silently — every move is in the ledger of movements', () => {
    adjustStock(h.ctx, { productId: f.product.id, newQty: 9000, reason: 'Count' });
    const moves = stockMoves(h.ctx, { productId: f.product.id });
    const manual = moves.find((m) => m.movement === 'adjustment' || m.movement === 'damage');
    expect(manual).toBeTruthy();
    expect(manual?.reason).toBe('Count');
    expect(manual?.qty).toBe(-1000);
  });
});

describe('stock reporting', () => {
  it('reports low and out-of-stock products', () => {
    // product min_stock = 2 units (2000 milli), currently 10 units
    expect(lowStock(h.ctx)).toHaveLength(0);
    adjustStock(h.ctx, { productId: f.product.id, newQty: 1500, reason: 'Shelf count' });
    const low = lowStock(h.ctx);
    expect(low.some((p) => p.id === f.product.id)).toBe(true);

    adjustStock(h.ctx, { productId: f.product.id, newQty: 0, reason: 'Sold out' });
    const empty = outOfStock(h.ctx);
    expect(empty.some((p) => p.id === f.product.id)).toBe(true);
  });

  it('produces a valuation report that matches the ledger', () => {
    const valuation = stockValuation(h.ctx);
    expect(valuation.totalValue).toBe(totalStockValue(h.ctx));
    expect(valuation.rows.every((r) => r.value >= 0)).toBe(true);
    const recon = reconcileInventoryWithLedger(h.ctx);
    expect(recon.ok).toBe(true);
    expect(recon.stockValue).toBe(1200000);
  });
});
