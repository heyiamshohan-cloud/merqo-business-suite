/**
 * Inventory engine — MOVING WEIGHTED AVERAGE (documented in
 * docs/architecture/INVENTORY.md).
 *
 * The authoritative state is `stock_levels(qty, value)`:
 *   qty   — quantity on hand in milli-units
 *   value — total inventory value on hand in paisa (not a per-unit price)
 *
 * Moving average unit cost = value / qty. Because we always derive cost from
 * the aggregate value (never from a rounded per-unit price), total inventory
 * value stays exactly consistent with the ledger's Inventory account, and
 * COGS across the life of the business equals purchases minus closing stock
 * with zero rounding drift.
 *
 * Every movement is written to `stock_moves` — stock never changes silently.
 */
import { AppError, BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import { mulPriceQty, roundHalfUp, QTY_SCALE } from '../foundation/money';
import type { Ctx } from '../kernel';
import type { ProductRow, StockMoveRow, StockMovementType } from '../domain/types';
import { getBoolSetting } from '../services/settings';

export interface StockLevel {
  product_id: string;
  qty: number;
  value: number;
  unit_cost: number;
}

export interface MovementInput {
  productId: string;
  qty: number; // positive milli-units
  movement: StockMovementType;
  refType?: string | null;
  refId?: string | null;
  reason?: string | null;
  note?: string | null;
  at?: string;
  /** Override the movement date (stock-in valued at actual cost). */
  bizDate?: string;
}

export interface StockOutResult {
  qty: number;
  cogs: number;
  unitCost: number;
  product: ProductRow;
}

export interface StockInResult {
  qty: number;
  valueAdded: number;
  unitCost: number;
  newQty: number;
  newValue: number;
}

export function getProductOrThrow(ctx: Ctx, productId: string): ProductRow {
  const product = ctx.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) {
    throw new NotFoundError(`Product not found: ${productId}`, 'পণ্যটি পাওয়া যায়নি।', { productId });
  }
  return product;
}

export function getStockLevel(ctx: Ctx, productId: string): StockLevel {
  const row = ctx.db.get<{ qty: number; value: number }>(
    'SELECT qty, value FROM stock_levels WHERE product_id = ?',
    [productId],
  );
  const qty = row?.qty ?? 0;
  const value = row?.value ?? 0;
  return {
    product_id: productId,
    qty,
    value,
    unit_cost: qty !== 0 ? roundHalfUp(value * QTY_SCALE, qty) : 0,
  };
}

function ensureStockRow(ctx: Ctx, productId: string, now: string): void {
  ctx.db.run(
    `INSERT INTO stock_levels (product_id, qty, value, updated_at) VALUES (?, 0, 0, ?)
     ON CONFLICT(product_id) DO NOTHING`,
    [productId, now],
  );
}

function writeMove(
  ctx: Ctx,
  input: MovementInput & { unitCost: number; value: number; signedQty: number; at: string; bizDate: string },
): string {
  const id = newId();
  ctx.db.run(
    `INSERT INTO stock_moves
      (id, at, biz_date, product_id, qty, unit_cost, value, movement, ref_type, ref_id, reason, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.at,
      input.bizDate,
      input.productId,
      input.signedQty,
      input.unitCost,
      input.value,
      input.movement,
      input.refType ?? null,
      input.refId ?? null,
      input.reason ?? null,
      input.note ?? null,
      ctx.userId,
    ],
  );
  return id;
}

/**
 * Receive stock at a known total cost (purchase / return / opening).
 * `totalValue` is the landed cost of the received quantity in paisa.
 */
export function stockIn(
  ctx: Ctx,
  input: MovementInput & { totalValue: number },
): StockInResult {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw new ValidationError('Stock-in quantity must be a positive number', 'স্টক ইন পরিমাণ শূন্যের বেশি হতে হবে।');
  }
  if (!Number.isInteger(input.totalValue) || input.totalValue < 0) {
    throw new ValidationError('Stock-in value cannot be negative', 'স্টক ইন মূল্য ঋণাত্মক হতে পারে না।');
  }
  const product = getProductOrThrow(ctx, input.productId);
  const at = input.at ?? ctx.clock.nowIso();
  const bizDate = input.bizDate ?? ctx.clock.bizDateOf(at);
  const now = ctx.clock.nowIso();

  if (product.track_stock !== 1) {
    // Non-stock items do not carry quantity but still record a movement for audit.
    writeMove(ctx, {
      ...input,
      unitCost: mulPriceQty(roundHalfUp(input.totalValue * QTY_SCALE, input.qty), 1),
      value: input.totalValue,
      signedQty: input.qty,
      at,
      bizDate,
    });
    return {
      qty: input.qty,
      valueAdded: input.totalValue,
      unitCost: 0,
      newQty: 0,
      newValue: 0,
    };
  }

  ensureStockRow(ctx, product.id, now);
  const level = getStockLevel(ctx, product.id);
  const newQty = level.qty + input.qty;
  const newValue = level.value + input.totalValue;
  const unitCost = roundHalfUp(input.totalValue * QTY_SCALE, input.qty);

  ctx.db.run('UPDATE stock_levels SET qty = ?, value = ?, updated_at = ? WHERE product_id = ?', [
    newQty,
    newValue,
    now,
    product.id,
  ]);
  writeMove(ctx, {
    ...input,
    unitCost,
    value: input.totalValue,
    signedQty: input.qty,
    at,
    bizDate,
  });

  return { qty: input.qty, valueAdded: input.totalValue, unitCost, newQty, newValue };
}

/**
 * Issue stock and compute COGS at the moving average cost at the moment of
 * issue. Returns the exact COGS recognised, which the caller posts to the
 * ledger (Dr COGS / Cr Inventory).
 */
export function stockOut(
  ctx: Ctx,
  input: MovementInput & { allowNegative?: boolean },
): StockOutResult {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw new ValidationError('Stock-out quantity must be a positive number', 'স্টক আউট পরিমাণ শূন্যের বেশি হতে হবে।');
  }
  const product = getProductOrThrow(ctx, input.productId);
  const at = input.at ?? ctx.clock.nowIso();
  const bizDate = input.bizDate ?? ctx.clock.bizDateOf(at);
  const now = ctx.clock.nowIso();

  if (product.track_stock !== 1) {
    const unitCost = product.purchase_price;
    const cogs = mulPriceQty(unitCost, input.qty);
    writeMove(ctx, { ...input, unitCost, value: -cogs, signedQty: -input.qty, at, bizDate });
    return { qty: input.qty, cogs, unitCost, product };
  }

  ensureStockRow(ctx, product.id, now);
  const level = getStockLevel(ctx, product.id);
  const allowNegative = input.allowNegative ?? getBoolSetting(ctx.db, 'inventory.allow_negative');

  if (!allowNegative && level.qty < input.qty) {
    throw new BusinessRuleError(
      'INSUFFICIENT_STOCK',
      `Not enough stock for "${product.name}": available ${level.qty / QTY_SCALE}, requested ${input.qty / QTY_SCALE}`,
      `"${product.name_bn || product.name}" এর পর্যাপ্ত স্টক নেই।`,
      { productId: product.id, available: level.qty, requested: input.qty },
    );
  }

  let cogs: number;
  let unitCost: number;
  if (level.qty > 0) {
    const remaining = level.qty - input.qty;
    if (remaining === 0) {
      // Absorb any rounding residual so inventory never keeps a phantom value.
      cogs = level.value;
    } else {
      cogs = roundHalfUp(level.value * input.qty, level.qty);
    }
    unitCost = roundHalfUp(cogs * QTY_SCALE, input.qty);
  } else {
    // Selling into negative stock: value the issue at the last known cost.
    const fallbackUnit = getStockLevel(ctx, product.id).unit_cost || product.purchase_price;
    unitCost = fallbackUnit;
    cogs = mulPriceQty(fallbackUnit, input.qty);
    if (cogs < 0) cogs = 0;
  }

  const newQty = level.qty - input.qty;
  const newValue = level.value - cogs;

  ctx.db.run('UPDATE stock_levels SET qty = ?, value = ?, updated_at = ? WHERE product_id = ?', [
    newQty,
    newValue,
    now,
    product.id,
  ]);
  writeMove(ctx, { ...input, unitCost, value: -cogs, signedQty: -input.qty, at, bizDate });

  return { qty: input.qty, cogs, unitCost, product };
}

/**
 * Issue stock while removing an EXACT total value (not the current average
 * cost). Used when a specific receipt must be reversed — voiding a purchase —
 * so the inventory value returns to precisely the capitalised amount in the
 * ledger and no revaluation drift is introduced.
 */
export function stockOutExact(
  ctx: Ctx,
  input: MovementInput & { totalValue: number },
): { qty: number; value: number; newQty: number; newValue: number } {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw new ValidationError('Stock-out quantity must be positive', 'স্টক আউট পরিমাণ শূন্যের বেশি হতে হবে।');
  }
  if (!Number.isInteger(input.totalValue) || input.totalValue < 0) {
    throw new ValidationError('Stock-out value cannot be negative', 'স্টক আউট মূল্য ঋণাত্মক হতে পারে না।');
  }
  const product = getProductOrThrow(ctx, input.productId);
  const at = input.at ?? ctx.clock.nowIso();
  const bizDate = input.bizDate ?? ctx.clock.bizDateOf(at);
  const now = ctx.clock.nowIso();
  ensureStockRow(ctx, product.id, now);
  const level = getStockLevel(ctx, product.id);
  if (level.qty < input.qty) {
    throw new BusinessRuleError(
      'INSUFFICIENT_STOCK',
      `Not enough stock for "${product.name}" to complete this reversal`,
      `"${product.name_bn || product.name}" এর পর্যাপ্ত স্টক নেই।`,
      { productId: product.id, available: level.qty, requested: input.qty },
    );
  }
  const newQty = level.qty - input.qty;
  // When the last unit leaves, clear any residual value so inventory nets to 0.
  const newValue = newQty === 0 ? 0 : level.value - input.totalValue;
  ctx.db.run('UPDATE stock_levels SET qty = ?, value = ?, updated_at = ? WHERE product_id = ?', [
    newQty,
    newValue,
    now,
    product.id,
  ]);
  writeMove(ctx, {
    ...input,
    unitCost: roundHalfUp(input.totalValue * QTY_SCALE, input.qty),
    value: -input.totalValue,
    signedQty: -input.qty,
    at,
    bizDate,
  });
  return { qty: input.qty, value: input.totalValue, newQty, newValue };
}

export interface AdjustmentInput {
  productId: string;
  /** Target quantity after adjustment (milli-units). */
  newQty?: number;
  /** Delta to apply (milli-units) — alternative to newQty. */
  deltaQty?: number;
  reason: string;
  movement?: StockMovementType;
  note?: string | null;
  at?: string;
}

export interface AdjustmentResult {
  product: ProductRow;
  deltaQty: number;
  valueDelta: number;
  before: StockLevel;
  after: StockLevel;
}

/**
 * Manual stock adjustment (damage, expiry, count correction, opening stock).
 * The value delta is returned so the caller can post the corresponding
 * inventory-adjustment journal entry.
 */
export function adjustStock(ctx: Ctx, input: AdjustmentInput): AdjustmentResult {
  if (input.newQty === undefined && input.deltaQty === undefined) {
    throw new ValidationError('An adjustment requires newQty or deltaQty', 'স্টক সমন্বয়ের পরিমাণ নির্দিষ্ট করুন।');
  }
  if (!input.reason || input.reason.trim() === '') {
    throw new ValidationError('A stock adjustment reason is required', 'স্টক সমন্বয়ের কারণ উল্লেখ করুন।');
  }
  const product = getProductOrThrow(ctx, input.productId);
  const at = input.at ?? ctx.clock.nowIso();
  const bizDate = ctx.clock.bizDateOf(at);
  const now = ctx.clock.nowIso();
  ensureStockRow(ctx, product.id, now);
  const before = getStockLevel(ctx, product.id);
  const targetQty = input.newQty !== undefined ? input.newQty : before.qty + (input.deltaQty ?? 0);
  const deltaQty = targetQty - before.qty;

  if (deltaQty === 0) {
    return { product, deltaQty: 0, valueDelta: 0, before, after: before };
  }

  const movement = input.movement ?? (deltaQty > 0 ? 'adjustment' : 'damage');

  if (deltaQty > 0) {
    // Increase: value at current average cost, falling back to purchase price.
    const unitCost = before.unit_cost || product.purchase_price;
    const valueDelta = mulPriceQty(unitCost, deltaQty);
    ctx.db.run('UPDATE stock_levels SET qty = ?, value = ?, updated_at = ? WHERE product_id = ?', [
      targetQty,
      before.value + valueDelta,
      now,
      product.id,
    ]);
    writeMove(ctx, {
      productId: product.id,
      qty: deltaQty,
      movement,
      reason: input.reason,
      note: input.note ?? null,
      refType: 'adjustment',
      at,
      bizDate,
      unitCost,
      value: valueDelta,
      signedQty: deltaQty,
    });
    const after = getStockLevel(ctx, product.id);
    return { product, deltaQty, valueDelta, before, after };
  }

  // Decrease: remove value proportionally at the current average cost.
  const outQty = -deltaQty;
  const remaining = before.qty - outQty;
  const valueDelta =
    remaining <= 0 ? -before.value : -roundHalfUp(before.value * outQty, before.qty);
  const unitCost = outQty > 0 ? roundHalfUp(-valueDelta * QTY_SCALE, outQty) : 0;
  ctx.db.run('UPDATE stock_levels SET qty = ?, value = ?, updated_at = ? WHERE product_id = ?', [
    targetQty,
    before.value + valueDelta,
    now,
    product.id,
  ]);
  writeMove(ctx, {
    productId: product.id,
    qty: outQty,
    movement,
    reason: input.reason,
    note: input.note ?? null,
    refType: 'adjustment',
    at,
    bizDate,
    unitCost,
    value: valueDelta,
    signedQty: deltaQty,
  });
  const after = getStockLevel(ctx, product.id);
  return { product, deltaQty, valueDelta, before, after };
}

/** Award opening stock at a stated cost. Returns cost value for the journal. */
export function openingStock(
  ctx: Ctx,
  input: { productId: string; qty: number; unitCost: number; note?: string },
): StockInResult {
  const product = getProductOrThrow(ctx, input.productId);
  const level = getStockLevel(ctx, product.id);
  if (level.qty !== 0) {
    throw new BusinessRuleError(
      'CONFLICT',
      `Opening stock can only be set for a product with zero stock ("${product.name}")`,
      'শুধুমাত্র শূন্য স্টকের পণ্যে প্রারম্ভিক স্টক নির্ধারণ করা যায়।',
      { productId: product.id, currentQty: level.qty },
    );
  }
  return stockIn(ctx, {
    productId: input.productId,
    qty: input.qty,
    totalValue: mulPriceQty(input.unitCost, input.qty),
    movement: 'opening',
    refType: 'opening',
    note: input.note ?? null,
    reason: 'Opening stock',
  });
}

export interface StockValuationRow {
  product_id: string;
  sku: string;
  name: string;
  name_bn: string | null;
  qty: number;
  value: number;
  unit_cost: number;
  category_name: string | null;
}

export function stockValuation(ctx: Ctx): {
  rows: StockValuationRow[];
  totalValue: number;
  totalQty: number;
} {
  const rows = ctx.db.all<StockValuationRow>(
    `SELECT p.id AS product_id, p.sku, p.name, p.name_bn,
            COALESCE(sl.qty, 0) AS qty, COALESCE(sl.value, 0) AS value,
            CASE WHEN COALESCE(sl.qty,0) = 0 THEN 0
                 ELSE CAST(ROUND(COALESCE(sl.value,0) * 1000.0 / sl.qty) AS INTEGER) END AS unit_cost,
            c.name AS category_name
       FROM products p
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.track_stock = 1 AND p.status = 'active'
      ORDER BY p.name COLLATE NOCASE`,
  );
  return {
    rows,
    totalValue: rows.reduce((a, r) => a + r.value, 0),
    totalQty: rows.reduce((a, r) => a + r.qty, 0),
  };
}

/** Total inventory value on hand (paisa) — must equal the Inventory account. */
export function totalStockValue(ctx: Ctx): number {
  return ctx.db.sum('SELECT COALESCE(SUM(value), 0) AS v FROM stock_levels');
}

export interface StockQuery {
  productId?: string;
  movement?: StockMovementType;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function stockMoves(ctx: Ctx, q: StockQuery = {}): StockMoveRow[] {
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (q.productId) {
    where.push('sm.product_id = ?');
    params.push(q.productId);
  }
  if (q.movement) {
    where.push('sm.movement = ?');
    params.push(q.movement);
  }
  if (q.from) {
    where.push('sm.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('sm.biz_date <= ?');
    params.push(q.to);
  }
  params.push(Math.min(q.limit ?? 200, 2000));
  params.push(q.offset ?? 0);
  return ctx.db.all<StockMoveRow>(
    `SELECT sm.*, p.name AS product_name, p.sku AS product_sku
       FROM stock_moves sm
       JOIN products p ON p.id = sm.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY sm.at DESC, sm.rowid DESC
      LIMIT ? OFFSET ?`,
    params,
  );
}

export interface LowStockRow {
  id: string;
  sku: string;
  name: string;
  name_bn: string | null;
  qty: number;
  min_stock: number;
  reorder_qty: number;
}

export function lowStock(ctx: Ctx, thresholdOverride?: number): LowStockRow[] {
  const threshold = thresholdOverride ?? 0;
  return ctx.db.all<LowStockRow>(
    `SELECT p.id, p.sku, p.name, p.name_bn,
            COALESCE(sl.qty, 0) AS qty,
            p.min_stock,
            MAX(p.min_stock - COALESCE(sl.qty, 0), 0) AS reorder_qty
       FROM products p
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
      WHERE p.track_stock = 1 AND p.status = 'active'
        AND COALESCE(sl.qty, 0) <= CASE WHEN p.min_stock > 0 THEN p.min_stock ELSE ? END
      ORDER BY (COALESCE(sl.qty,0) - p.min_stock) ASC, p.name COLLATE NOCASE`,
    [threshold],
  );
}

export function outOfStock(ctx: Ctx): LowStockRow[] {
  return ctx.db.all<LowStockRow>(
    `SELECT p.id, p.sku, p.name, p.name_bn, COALESCE(sl.qty,0) AS qty, p.min_stock,
            p.min_stock AS reorder_qty
       FROM products p
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
      WHERE p.track_stock = 1 AND p.status = 'active' AND COALESCE(sl.qty, 0) <= 0
      ORDER BY p.name COLLATE NOCASE`,
  );
}

/**
 * Inventory health check: verifies that the aggregate inventory value in
 * `stock_levels` equals the Inventory account balance in the ledger.
 */
export function reconcileInventoryWithLedger(ctx: Ctx): {
  stockValue: number;
  ledgerValue: number;
  difference: number;
  ok: boolean;
} {
  const stockValue = totalStockValue(ctx);
  const ledgerValue =
    ctx.db.sum(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
        WHERE a.code = '1200'`,
    ) ?? 0;
  const difference = stockValue - ledgerValue;
  return { stockValue, ledgerValue, difference, ok: difference === 0 };
}

export function assertPositiveQty(qty: number, label = 'Quantity'): void {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new AppError(`${label} must be a positive number`, {
      code: 'VALIDATION',
      messageBn: 'পরিমাণ শূন্যের বেশি হতে হবে।',
    });
  }
}
