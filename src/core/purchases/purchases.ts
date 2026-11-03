/**
 * Purchase engine.
 *
 * Capitalisation rules:
 *   - Discounts received reduce the inventory cost (they are not revenue).
 *   - Additional costs (transport, unloading, labour) are capitalised and
 *     allocated across lines so the moving-average cost reflects true landed
 *     cost.
 *   - Recoverable input VAT is NOT capitalised; it is posted to VAT Input.
 *
 * Ledger for a purchase:      Dr Inventory (net + additional)
 *                             Dr VAT Input (tax)
 *                             Cr Accounts Payable (supplier)
 * Supplier payment (separate): Dr AP / Cr Cash|Bank|MFS
 */
import { BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import {
  allocate,
  applyBasisPoints,
  BP_SCALE,
  mulPriceQty,
  roundHalfUp,
  toQtyMilli,
} from '../foundation/money';
import type { Ctx } from '../kernel';
import { ACC, paymentMethodAccountCode, PAYMENT_METHODS } from '../accounting/accounts';
import { postJournal, reverseJournal, type JournalLineInput } from '../accounting/journal';
import type { ProductRow, PurchaseLineRow, PurchaseRow } from '../domain/types';
import { getStockLevel, stockIn, stockOutExact } from '../inventory/stock';
import { getSupplier, supplierBalance } from '../parties/parties';
import { getBoolSetting, nextSequence } from '../services/settings';
import { recordAudit } from '../services/audit';

export interface PurchaseLineInput {
  productId: string;
  qty: string | number;
  /** Unit cost in paisa (tax-exclusive). */
  unitCost: number;
  discount?: number;
  taxRateBp?: number;
}

export interface PurchasePaymentInput {
  method: string;
  amount: number;
}

export interface CreatePurchaseInput {
  supplierId?: string | null;
  lines: PurchaseLineInput[];
  invoiceDiscount?: number;
  additionalCost?: number;
  payments?: PurchasePaymentInput[];
  supplierRef?: string | null;
  note?: string | null;
  at?: string;
  bizDate?: string;
  clientToken?: string | null;
}

export interface PurchaseLineResult {
  id: string;
  productId: string;
  name: string;
  qty: number;
  unitCost: number;
  discount: number;
  taxRateBp: number;
  tax: number;
  lineTotal: number;
  landedUnitCost: number;
  stockValue: number;
}

export interface CreatePurchaseResult {
  purchaseId: string;
  purchaseNo: string;
  at: string;
  bizDate: string;
  grossTotal: number;
  itemDiscount: number;
  invoiceDiscount: number;
  additionalCost: number;
  taxTotal: number;
  total: number;
  paid: number;
  due: number;
  capitalized: number;
  lines: PurchaseLineResult[];
  journalId: string;
}

function validateMethod(method: string): string {
  const m = (method ?? '').trim().toLowerCase();
  const found = PAYMENT_METHODS.find((p) => p.key === m);
  if (!found) {
    throw new ValidationError(`Unknown payment method: "${method}"`, 'অজানা পেমেন্ট মাধ্যম।', { method });
  }
  return found.key;
}

/** Pure price computation for preview / tests. */
export function pricePurchase(
  ctx: Ctx,
  input: Pick<CreatePurchaseInput, 'lines' | 'invoiceDiscount' | 'additionalCost'>,
): {
  lines: Array<{
    product: ProductRow;
    qty: number;
    unitCost: number;
    discount: number;
    taxRateBp: number;
    gross: number;
    net: number;
    tax: number;
    lineTotal: number;
    additionalAllocated: number;
    stockValue: number;
    landedUnitCost: number;
  }>;
  grossTotal: number;
  itemDiscount: number;
  invoiceDiscount: number;
  additionalCost: number;
  taxTotal: number;
  total: number;
  capitalized: number;
} {
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('A purchase must contain at least one product', 'ক্রয়ে কমপক্ষে একটি পণ্য থাকতে হবে।');
  }
  const taxEnabled = getBoolSetting(ctx.db, 'tax.enabled');

  const base = input.lines.map((line, index) => {
    const product = ctx.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [line.productId]);
    if (!product) {
      throw new NotFoundError(`Product not found on line ${index + 1}`, 'পণ্যটি পাওয়া যায়নি।', {
        productId: line.productId,
      });
    }
    const qty = toQtyMilli(line.qty);
    if (qty <= 0) {
      throw new ValidationError(
        `Quantity on line ${index + 1} must be greater than zero`,
        'পরিমাণ শূন্যের বেশি হতে হবে।',
      );
    }
    if (!Number.isInteger(line.unitCost) || line.unitCost < 0) {
      throw new ValidationError(
        `Unit cost on line ${index + 1} is invalid`,
        'একক ক্রয়মূল্য সঠিকভাবে দিন।',
      );
    }
    const discount = line.discount ?? 0;
    if (!Number.isInteger(discount) || discount < 0) {
      throw new ValidationError('Line discount is invalid', 'লাইনের ছাড় সঠিক নয়।');
    }
    const gross = mulPriceQty(line.unitCost, qty);
    if (discount > gross) {
      throw new ValidationError(
        `Discount on line ${index + 1} cannot exceed the line amount`,
        'লাইনের ছাড় লাইনের মূল্যের বেশি হতে পারে না।',
      );
    }
    const taxRateBp = taxEnabled ? (line.taxRateBp ?? product.tax_rate_bp ?? 0) : 0;
    if (taxRateBp < 0 || taxRateBp > BP_SCALE) {
      throw new ValidationError('Tax rate is out of range', 'ভ্যাটের হার সঠিক নয়।');
    }
    const net = gross - discount;
    return { product, qty, unitCost: line.unitCost, discount, taxRateBp, gross, net };
  });

  const grossTotal = base.reduce((a, l) => a + l.gross, 0);
  const itemDiscount = base.reduce((a, l) => a + l.discount, 0);
  const invoiceDiscount = input.invoiceDiscount ?? 0;
  const additionalCost = input.additionalCost ?? 0;
  if (!Number.isInteger(invoiceDiscount) || invoiceDiscount < 0) {
    throw new ValidationError('Invoice discount is invalid', 'ইনভয়েস ছাড় সঠিক নয়।');
  }
  if (!Number.isInteger(additionalCost) || additionalCost < 0) {
    throw new ValidationError('Additional cost is invalid', 'অতিরিক্ত খরচ সঠিক নয়।');
  }
  const netBeforeInvoiceDiscount = base.reduce((a, l) => a + l.net, 0);
  if (invoiceDiscount > netBeforeInvoiceDiscount) {
    throw new ValidationError(
      'Invoice discount cannot exceed the purchase value',
      'ইনভয়েস ছাড় ক্রয়মূল্যের বেশি হতে পারে না।',
    );
  }

  const discountAlloc = allocate(
    invoiceDiscount,
    base.map((l) => l.net),
  );
  const additionalAlloc = allocate(
    additionalCost,
    base.map((l, i) => l.net - (discountAlloc[i] ?? 0)),
  );

  let taxTotal = 0;
  const lines = base.map((line, i) => {
    const net = line.net - (discountAlloc[i] ?? 0);
    const addl = additionalAlloc[i] ?? 0;
    const tax = applyBasisPoints(net, line.taxRateBp);
    const lineTotal = net + tax;
    const stockValue = net + addl;
    taxTotal += tax;
    return {
      product: line.product,
      qty: line.qty,
      unitCost: line.unitCost,
      discount: line.discount,
      taxRateBp: line.taxRateBp,
      gross: line.gross,
      net,
      tax,
      lineTotal,
      additionalAllocated: addl,
      stockValue,
      landedUnitCost: roundHalfUp(stockValue * 1000, line.qty),
    };
  });

  const total = lines.reduce((a, l) => a + l.lineTotal, 0) + additionalCost;
  const capitalized = lines.reduce((a, l) => a + l.stockValue, 0);

  return {
    lines,
    grossTotal,
    itemDiscount,
    invoiceDiscount,
    additionalCost,
    taxTotal,
    total,
    capitalized,
  };
}

export function createPurchase(ctx: Ctx, input: CreatePurchaseInput): CreatePurchaseResult {
  const { db, clock } = ctx;

  if (input.clientToken) {
    const existing = db.get<PurchaseRow>('SELECT * FROM purchases WHERE id = ?', [
      `token:${input.clientToken}`,
    ]);
    if (existing) {
      throw new BusinessRuleError(
        'CONFLICT',
        'Duplicate purchase submission detected',
        'একই ক্রয় দুইবার জমা হয়েছে — প্রতিরোধ করা হয়েছে।',
      );
    }
  }

  const priced = pricePurchase(ctx, input);
  const at = input.at ?? clock.nowIso();
  const bizDate = input.bizDate ?? clock.bizDateOf(at);

  const paymentInputs = (input.payments ?? []).filter((p) => p.amount > 0);
  const paidTotal = paymentInputs.reduce((a, p) => a + p.amount, 0);
  if (paidTotal > priced.total) {
    throw new ValidationError(
      'Paid amount exceeds the purchase total',
      'পরিশোধিত টাকা ক্রয়ের মোট মূল্যের বেশি হতে পারে না।',
      { paidTotal, total: priced.total },
    );
  }
  const dueTotal = priced.total - paidTotal;
  if (dueTotal > 0 && !input.supplierId) {
    throw new ValidationError(
      'A supplier must be selected when the purchase has an outstanding amount',
      'বাকি ক্রয়ের জন্য সরবরাহকারী নির্বাচন করতে হবে।',
    );
  }
  if (input.supplierId) {
    const supplier = getSupplier(ctx, input.supplierId);
    if (supplier.status !== 'active') {
      throw new BusinessRuleError('CONFLICT', 'The selected supplier is archived', 'নির্বাচিত সরবরাহকারী আর্কাইভ করা হয়েছে।');
    }
  }

  return db.transaction(() => {
    const purchaseNo = nextSequence(db, 'purchase').formatted;
    const purchaseId = newId();

    // 1. Capitalise stock at landed cost.
    const lineResults: PurchaseLineResult[] = [];
    for (const line of priced.lines) {
      stockIn(ctx, {
        productId: line.product.id,
        qty: line.qty,
        totalValue: line.stockValue,
        movement: 'purchase',
        refType: 'purchase',
        refId: purchaseId,
        at,
        bizDate,
      });
      // Keep the last purchase cost current for quick entry next time.
      if (line.product.purchase_price !== line.unitCost) {
        db.run('UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ?', [
          line.unitCost,
          clock.nowIso(),
          line.product.id,
        ]);
      }
      lineResults.push({
        id: newId(),
        productId: line.product.id,
        name: line.product.name,
        qty: line.qty,
        unitCost: line.unitCost,
        discount: line.discount,
        taxRateBp: line.taxRateBp,
        tax: line.tax,
        lineTotal: line.lineTotal,
        landedUnitCost: line.landedUnitCost,
        stockValue: line.stockValue,
      });
    }

    // 2. Journal for the purchase.
    const journalLines: JournalLineInput[] = [
      { accountCode: ACC.INVENTORY, debit: priced.capitalized, memo: 'Inventory received' },
    ];
    if (priced.taxTotal > 0) {
      journalLines.push({ accountCode: ACC.VAT_INPUT, debit: priced.taxTotal, memo: 'Input VAT' });
    }
    journalLines.push({
      accountCode: ACC.AP,
      credit: priced.total,
      party: input.supplierId ? { type: 'supplier', id: input.supplierId } : undefined,
      memo: 'Purchase payable',
    });
    const journal = postJournal(ctx, {
      memo: `Purchase ${purchaseNo}`,
      sourceType: 'purchase',
      sourceId: purchaseId,
      lines: journalLines,
      at,
      bizDate,
    });

    // 3. Purchase header + lines.
    db.run(
      `INSERT INTO purchases
        (id, purchase_no, at, biz_date, supplier_id, supplier_ref, status, gross_total, item_discount,
         additional_cost, tax_total, total, paid, due, journal_id, note, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseId,
        purchaseNo,
        at,
        bizDate,
        input.supplierId ?? null,
        input.supplierRef ?? null,
        priced.grossTotal,
        priced.itemDiscount,
        priced.additionalCost,
        priced.taxTotal,
        priced.total,
        paidTotal,
        dueTotal,
        journal.id,
        input.note ?? null,
        ctx.userId,
        clock.nowIso(),
        clock.nowIso(),
      ],
    );

    for (let i = 0; i < lineResults.length; i++) {
      const r = lineResults[i];
      db.run(
        `INSERT INTO purchase_lines
          (id, purchase_id, line_no, product_id, name_snapshot, qty, unit_cost, discount,
           tax_rate_bp, tax, line_total, landed_cost, stock_value, returned_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          r.id,
          purchaseId,
          i + 1,
          r.productId,
          r.name,
          r.qty,
          r.unitCost,
          r.discount,
          r.taxRateBp,
          r.tax,
          r.lineTotal,
          r.landedUnitCost,
          r.stockValue,
        ],
      );
    }

    // 4. Supplier payment (separate entry, same transaction).
    if (paidTotal > 0 && input.supplierId) {
      const payLines: JournalLineInput[] = [
        {
          accountCode: ACC.AP,
          debit: paidTotal,
          party: { type: 'supplier', id: input.supplierId },
          memo: 'Purchase payment',
        },
      ];
      for (const payment of paymentInputs) {
        payLines.push({ accountCode: paymentMethodAccountCode(payment.method), credit: payment.amount });
      }
      const payJournal = postJournal(ctx, {
        memo: `Supplier payment for purchase ${purchaseNo}`,
        sourceType: 'supplier_payment',
        sourceId: purchaseId,
        lines: payLines,
        at,
        bizDate,
      });
      for (const payment of paymentInputs) {
        const method = validateMethod(payment.method);
        const paymentId = newId();
        db.run(
          `INSERT INTO payments
            (id, receipt_no, at, biz_date, direction, party_type, party_id, method, amount, note,
             journal_id, client_token, user_id, created_at)
           VALUES (?, ?, ?, ?, 'out', 'supplier', ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [
            paymentId,
            nextSequence(db, 'payment').formatted,
            at,
            bizDate,
            input.supplierId,
            method,
            payment.amount,
            `Purchase ${purchaseNo}`,
            payJournal.id,
            ctx.userId,
            clock.nowIso(),
          ],
        );
        db.run(
          `INSERT INTO payment_allocations (id, payment_id, doc_type, doc_id, amount)
           VALUES (?, ?, 'purchase', ?, ?)`,
          [newId(), paymentId, purchaseId, payment.amount],
        );
      }
    }

    recordAudit(ctx, {
      action: 'purchase.create',
      entity: 'purchase',
      entityId: purchaseId,
      details: { purchaseNo, total: priced.total, paid: paidTotal, due: dueTotal },
    });

    return {
      purchaseId,
      purchaseNo,
      at,
      bizDate,
      grossTotal: priced.grossTotal,
      itemDiscount: priced.itemDiscount,
      invoiceDiscount: priced.invoiceDiscount,
      additionalCost: priced.additionalCost,
      taxTotal: priced.taxTotal,
      total: priced.total,
      paid: paidTotal,
      due: dueTotal,
      capitalized: priced.capitalized,
      lines: lineResults,
      journalId: journal.id,
    };
  });
}

export interface PurchaseDetail {
  purchase: PurchaseRow;
  lines: PurchaseLineRow[];
}

export function getPurchase(ctx: Ctx, purchaseId: string): PurchaseDetail {
  const purchase = ctx.db.get<PurchaseRow>(
    `SELECT p.*, s.name AS supplier_name FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
    [purchaseId],
  );
  if (!purchase) throw new NotFoundError('Purchase not found', 'ক্রয় পাওয়া যায়নি।', { purchaseId });
  const lines = ctx.db.all<PurchaseLineRow>(
    'SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY line_no',
    [purchaseId],
  );
  return { purchase, lines };
}

export interface PurchaseQuery {
  from?: string;
  to?: string;
  supplierId?: string;
  search?: string;
  withDueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export function listPurchases(
  ctx: Ctx,
  q: PurchaseQuery = {},
): { rows: PurchaseRow[]; total: number; page: number; pageSize: number; totalPages: number; totals: { total: number; paid: number; due: number } } {
  const where: string[] = ["p.status = 'completed'"];
  const params: Array<string | number> = [];
  if (q.from) {
    where.push('p.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('p.biz_date <= ?');
    params.push(q.to);
  }
  if (q.supplierId) {
    where.push('p.supplier_id = ?');
    params.push(q.supplierId);
  }
  if (q.withDueOnly) where.push('p.due > 0');
  if (q.search && q.search.trim() !== '') {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push("(LOWER(p.purchase_no) LIKE ? OR LOWER(COALESCE(s.name,'')) LIKE ? OR LOWER(COALESCE(p.supplier_ref,'')) LIKE ?)");
    params.push(term, term, term);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = ctx.db.sum(
    `SELECT COUNT(*) AS v FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id ${whereSql}`,
    params,
  );
  const sums = ctx.db.get<{ total: number; paid: number; due: number }>(
    `SELECT COALESCE(SUM(p.total),0) AS total, COALESCE(SUM(p.paid),0) AS paid, COALESCE(SUM(p.due),0) AS due
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id ${whereSql}`,
    params,
  );
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(Math.max(1, q.pageSize ?? 50), 500);
  const rows = ctx.db.all<PurchaseRow>(
    `SELECT p.*, s.name AS supplier_name FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       ${whereSql}
      ORDER BY p.at DESC, p.rowid DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    totals: { total: sums?.total ?? 0, paid: sums?.paid ?? 0, due: sums?.due ?? 0 },
  };
}

/**
 * Void a purchase: requires no recorded payments and no returns, so the cash
 * and supplier-payable trails stay audit-clean.
 */
export function voidPurchase(ctx: Ctx, purchaseId: string, reason: string): { reversalJournalId: string } {
  if (!reason || reason.trim() === '') {
    throw new ValidationError('A void reason is required', 'বাতিলের কারণ উল্লেখ করুন।');
  }
  const { db, clock } = ctx;
  return db.transaction(() => {
    const purchase = db.get<PurchaseRow>('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
    if (!purchase) throw new NotFoundError('Purchase not found', 'ক্রয় পাওয়া যায়নি।');
    if (purchase.status === 'voided') {
      throw new BusinessRuleError('CONFLICT', 'Purchase is already voided', 'ক্রয় ইতিমধ্যে বাতিল করা হয়েছে।');
    }
    if (purchase.paid > 0) {
      throw new BusinessRuleError(
        'IMMUTABLE_RECORD',
        'A purchase with payments cannot be voided — use a purchase return instead',
        'পরিশোধিত ক্রয় বাতিল করা যায় না — ক্রয় ফেরত ব্যবহার করুন।',
      );
    }
    const returns = db.count('purchase_returns', 'purchase_id = ?', [purchaseId]);
    if (returns > 0) {
      throw new BusinessRuleError('IMMUTABLE_RECORD', 'A purchase with returns cannot be voided', 'ফেরতযুক্ত ক্রয় বাতিল করা যায় না।');
    }
    if (!purchase.journal_id) {
      throw new BusinessRuleError('CONFLICT', 'Purchase has no journal entry', 'ক্রয়ের হিসাব এন্ট্রি নেই।');
    }
    const reversal = reverseJournal(ctx, purchase.journal_id, `Void purchase ${purchase.purchase_no}: ${reason}`);

    const lines = db.all<PurchaseLineRow>('SELECT * FROM purchase_lines WHERE purchase_id = ?', [purchaseId]);
    for (const line of lines) {
      const level = getStockLevel(ctx, line.product_id);
      if (level.qty < line.qty) {
        throw new BusinessRuleError(
          'INSUFFICIENT_STOCK',
          'Cannot void this purchase: some of the goods have already been sold',
          'এই ক্রয় বাতিল করা যাবে না — পণ্যের কিছু অংশ ইতিমধ্যে বিক্রি হয়েছে।',
          { productId: line.product_id, available: level.qty, needed: line.qty },
        );
      }
      // Reverse exactly the value that was capitalised for this line.
      stockOutExact(ctx, {
        productId: line.product_id,
        qty: line.qty,
        totalValue: line.stock_value,
        movement: 'purchase_return',
        refType: 'void_purchase',
        refId: purchaseId,
        reason: `Void of purchase ${purchase.purchase_no}`,
        at: clock.nowIso(),
      });
    }

    db.run("UPDATE purchases SET status = 'voided', due = 0, updated_at = ? WHERE id = ?", [
      clock.nowIso(),
      purchaseId,
    ]);
    recordAudit(ctx, {
      action: 'purchase.void',
      entity: 'purchase',
      entityId: purchaseId,
      severity: 'warning',
      details: { purchaseNo: purchase.purchase_no, reason, reversalJournalId: reversal.id },
    });
    return { reversalJournalId: reversal.id };
  });
}

export function purchaseTotals(
  ctx: Ctx,
  window: { from: string; to: string },
): { count: number; total: number; paid: number; due: number } {
  const row = ctx.db.get<{ count: number; total: number; paid: number; due: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(paid),0) AS paid, COALESCE(SUM(due),0) AS due
       FROM purchases
      WHERE status = 'completed' AND biz_date >= ? AND biz_date <= ?`,
    [window.from, window.to],
  );
  return row ?? { count: 0, total: 0, paid: 0, due: 0 };
}

/** Supplier payable check used by the payment screen. */
export function supplierOutstanding(ctx: Ctx, supplierId: string): number {
  return supplierBalance(ctx, supplierId);
}
