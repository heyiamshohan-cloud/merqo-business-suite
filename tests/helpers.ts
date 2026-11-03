import { Db } from '../src/core/db/context';
import { openDatabase, type SqlDatabase } from '../src/core/db/driver';
import { bootstrapDatabase } from '../src/core/db/bootstrap';
import { FixedClock } from '../src/core/foundation/clock';
import { createCtx, type Ctx } from '../src/core/kernel';
import { createProduct } from '../src/core/catalog/catalog';
import { createCustomer, createSupplier } from '../src/core/parties/parties';
import { stockIn } from '../src/core/inventory/stock';
import { postJournal } from '../src/core/accounting/journal';
import { ACC } from '../src/core/accounting/accounts';
import type { CustomerRow, ProductRow, SupplierRow } from '../src/core/domain/types';

export interface TestHarness {
  db: Db;
  ctx: Ctx;
  clock: FixedClock;
  raw: SqlDatabase;
  close(): void;
}

/** Fresh in-memory database with migrations + seed data applied. */
export async function makeHarness(startIso = '2026-01-01T06:00:00.000Z'): Promise<TestHarness> {
  const raw = await openDatabase(':memory:');
  const db = new Db(raw);
  const clock = new FixedClock(new Date(startIso));
  bootstrapDatabase(db, { clock, appVersion: '1.0.0-test' });
  const ctx = createCtx(db, { clock });
  return {
    db,
    ctx,
    clock,
    raw,
    close: () => db.close(),
  };
}

export interface Fixtures {
  product: ProductRow;
  product2: ProductRow;
  customer: CustomerRow;
  supplier: SupplierRow;
}

export function salePrice(paisa: number): number {
  return paisa;
}

/**
 * Standard fixture set:
 *   product  "Rice 5kg"  purchase 600.00, sale 1000.00, opening stock 10
 *   product2 "Oil 1L"    purchase 300.00, sale  450.00, opening stock 20
 */
export function seedFixtures(ctx: Ctx): Fixtures {
  const product = createProduct(ctx, {
    name: 'Rice 5kg',
    nameBn: 'চাল ৫ কেজি',
    purchasePrice: 60000,
    salePrice: 100000,
    minStock: 2000,
    barcodes: ['8901234567890'],
  });
  const product2 = createProduct(ctx, {
    name: 'Soybean Oil 1L',
    nameBn: 'সয়াবিন তেল ১ লিটার',
    purchasePrice: 30000,
    salePrice: 45000,
    minStock: 3000,
  });

  // Opening stock posted through the ledger so the books start balanced.
  const openingValue = 60000 * 10 + 30000 * 20; // ৳6,000 + ৳6,000 = ৳12,000
  ctx.db.transaction(() => {
    stockIn(ctx, {
      productId: product.id,
      qty: 10_000,
      totalValue: 60000 * 10,
      movement: 'opening',
      refType: 'opening',
      reason: 'Opening stock',
    });
    stockIn(ctx, {
      productId: product2.id,
      qty: 20_000,
      totalValue: 30000 * 20,
      movement: 'opening',
      refType: 'opening',
      reason: 'Opening stock',
    });
    postJournal(ctx, {
      memo: 'Opening stock',
      sourceType: 'opening',
      lines: [
        { accountCode: ACC.INVENTORY, debit: openingValue },
        { accountCode: ACC.OPENING_BALANCE_EQUITY, credit: openingValue },
      ],
    });
  });

  const customer = createCustomer(ctx, { name: 'Karim Traders', phone: '01711111111' });
  const supplier = createSupplier(ctx, { name: 'Dhaka Wholesale', phone: '01822222222' });

  return { product, product2, customer, supplier };
}

/** Move the fixed clock forward and return the resulting business date. */
export function nextDay(clock: FixedClock, days = 1): string {
  clock.advanceMinutes(days * 24 * 60);
  return clock.todayBizDate();
}
