/**
 * Sales returns and purchase returns.
 *
 * Returns never edit the original document. They create a new document, move
 * stock in the correct direction, and post a journal that reverses exactly the
 * portion being returned.
 *
 * Sales return, resalable goods:
 *   Dr Sales Returns (net)      Dr VAT Payable (tax)     Cr AR or Cash (total)
 *   Dr Inventory (cost)                                  Cr COGS (cost)
 *
 * Sales return, damaged goods: the cost is NOT put back into inventory, so
 * only the revenue-side reversal is posted (the loss stays in COGS).
 *
 * Purchase return:
 *   Dr Accounts Payable (or Cash)                        Cr Inventory (landed cost)
 */
import { BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import { roundHalfUp, toQtyMilli } from '../foundation/money';
import type { Ctx } from '../kernel';
import { ACC, paymentMethodAccountCode } from '../accounting/accounts';
import { postJournal, type JournalLineInput } from '../accounting/journal';
import type { PurchaseLineRow, PurchaseRow, SaleLineRow, SalesInvoiceRow } from '../domain/types';
import { getStockLevel, stockIn, stockOutExact } from '../inventory/stock';
import { getCustomer } from '../parties/parties';
import { getSupplier } from '../parties/parties';
import { nextSequence } from '../services/settings';
import { recordAudit } from '../services/audit';

export type RestockPolicy = 'resalable' | 'damaged' | 'none';

export interface SalesReturnLineInput {
  saleLineId: string;
  qty: string | number;
}

export interface CreateSalesReturnInput {
  invoiceId: string;
  lines: SalesReturnLineInput[];
  /** 'credit' reduces the customer balance; any payment method refunds cash out. */
  refundMethod: string;
  restock?: RestockPolicy;
  reason: string;
  at?: string;
  bizDate?: string;
}

export interface SalesReturnLineResult {
  id: string;
  saleLineId: string;
  productId: string;
  qty: number;
  unitPrice: number;
  net: number;
  tax: number;
  total: number;
  cogsReversed: number;
}

export interface SalesReturnResult {
  returnId: string;
  returnNo: string;
  netSales: number;
  tax: number;
  total: number;
  cogsReversed: number;
  journalId: string;
  lines: SalesReturnLineResult[];
}

export function createSalesReturn(ctx: Ctx, input: CreateSalesReturnInput): SalesReturnResult {
  const { db, clock } = ctx;
  const restock: RestockPolicy = input.restock ?? 'resalable';
  if (!input.reason || input.reason.trim() === '') {
    throw new ValidationError('A return reason is required', 'ফেরতের কারণ উল্লেখ করুন।');
  }
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('Select at least one product to return', 'ফেরতের জন্য অন্তত একটি পণ্য নির্বাচন করুন।');
  }
  const refundMethod = (input.refundMethod ?? '').trim().toLowerCase();
  if (refundMethod === '') {
    throw new ValidationError('A refund method is required', 'ফেরতের মাধ্যম নির্বাচন করুন।');
  }

  return db.transaction(() => {
    const invoice = db.get<SalesInvoiceRow>('SELECT * FROM sales_invoices WHERE id = ?', [
      input.invoiceId,
    ]);
    if (!invoice) throw new NotFoundError('Invoice not found', 'ইনভয়েস পাওয়া যায়নি।', { invoiceId: input.invoiceId });
    if (invoice.status === 'voided') {
      throw new BusinessRuleError('CONFLICT', 'A voided invoice cannot be returned', 'বাতিল ইনভয়েসে ফেরত সম্ভব নয়।');
    }
    if (refundMethod !== 'credit' && invoice.due > 0) {
      throw new BusinessRuleError(
        'INSUFFICIENT_PAYMENT',
        'This invoice still has an outstanding balance — settle it with a credit adjustment instead of a cash refund',
        'এই ইনভয়েসে বাকি আছে — নগদ ফেরতের বদলে হিসাব সমন্বয় (ক্রেডিট) ব্যবহার করুন।',
        { invoiceId: invoice.id, due: invoice.due },
      );
    }
    if (refundMethod === 'credit' && !invoice.customer_id) {
      throw new BusinessRuleError(
        'CONFLICT',
        'A credit adjustment requires a registered customer',
        'ক্রেডিট সমন্বয়ের জন্য নিবন্ধিত গ্রাহক প্রয়োজন।',
      );
    }
    if (invoice.customer_id) getCustomer(ctx, invoice.customer_id);

    const at = input.at ?? clock.nowIso();
    const bizDate = input.bizDate ?? clock.bizDateOf(at);
    const returnId = newId();
    const returnNo = nextSequence(db, 'sales_return').formatted;

    let netSales = 0;
    let taxTotal = 0;
    let total = 0;
    let cogsReversed = 0;
    const lineResults: SalesReturnLineResult[] = [];

    for (const lineInput of input.lines) {
      const line = db.get<SaleLineRow>('SELECT * FROM sale_lines WHERE id = ? AND invoice_id = ?', [
        lineInput.saleLineId,
        invoice.id,
      ]);
      if (!line) {
        throw new NotFoundError('Invoice line not found', 'ইনভয়েসের লাইন পাওয়া যায়নি।', {
          saleLineId: lineInput.saleLineId,
        });
      }
      const requested = toQtyMilli(lineInput.qty);
      if (requested <= 0) continue;
      const eligible = line.qty - line.returned_qty;
      if (requested > eligible) {
        throw new BusinessRuleError(
          'OVER_RETURN',
          `Return quantity for "${line.name_snapshot}" exceeds the eligible quantity (${eligible / 1000})`,
          'ফেরতের পরিমাণ বিক্রীত পরিমাণের বেশি হতে পারে না।',
          { saleLineId: line.id, requested, eligible },
        );
      }

      const isFull = requested === eligible;
      const netBeforeTax = line.line_total - line.tax;
      const net = isFull ? netBeforeTax : roundHalfUp(netBeforeTax * requested, line.qty);
      const tax = isFull ? line.tax : roundHalfUp(line.tax * requested, line.qty);
      const lineTotal = net + tax;
      const cogs = isFull ? line.cogs : roundHalfUp(line.cogs * requested, line.qty);

      // Put resalable goods back into stock at their original cost.
      if (restock === 'resalable') {
        stockIn(ctx, {
          productId: line.product_id,
          qty: requested,
          totalValue: cogs,
          movement: 'sale_return',
          refType: 'sales_return',
          refId: returnId,
          reason: input.reason,
          at,
          bizDate,
        });
      } else {
        // Record the movement for the audit trail without changing quantity.
        db.run(
          `INSERT INTO stock_moves
            (id, at, biz_date, product_id, qty, unit_cost, value, movement, ref_type, ref_id, reason, note, user_id)
           VALUES (?, ?, ?, ?, 0, ?, 0, 'sale_return', 'sales_return', ?, ?, ?, ?)`,
          [
            newId(),
            at,
            bizDate,
            line.product_id,
            line.unit_cost,
            returnId,
            input.reason,
            restock === 'damaged' ? 'Returned damaged — not restocked' : 'Not restocked',
            ctx.userId,
          ],
        );
      }

      db.run('UPDATE sale_lines SET returned_qty = returned_qty + ? WHERE id = ?', [
        requested,
        line.id,
      ]);

      netSales += net;
      taxTotal += tax;
      total += lineTotal;
      cogsReversed += restock === 'resalable' ? cogs : 0;
      lineResults.push({
        id: newId(),
        saleLineId: line.id,
        productId: line.product_id,
        qty: requested,
        unitPrice: line.unit_price,
        net,
        tax,
        total: lineTotal,
        cogsReversed: restock === 'resalable' ? cogs : 0,
      });
    }

    if (lineResults.length === 0) {
      throw new ValidationError('No returnable quantity was entered', 'ফেরতের কোনো পরিমাণ দেওয়া হয়নি।');
    }

    // Journal
    const journalLines: JournalLineInput[] = [];
    if (refundMethod === 'credit') {
      journalLines.push({
        accountCode: ACC.AR,
        credit: total,
        party: { type: 'customer', id: invoice.customer_id as string },
        memo: 'Sales return credit',
      });
    } else {
      journalLines.push({ accountCode: paymentMethodAccountCode(refundMethod), credit: total });
    }
    journalLines.push({ accountCode: ACC.SALES_RETURNS, debit: netSales });
    if (taxTotal > 0) journalLines.push({ accountCode: ACC.VAT_PAYABLE, debit: taxTotal });
    if (cogsReversed > 0) {
      journalLines.push({ accountCode: ACC.INVENTORY, debit: cogsReversed });
      journalLines.push({ accountCode: ACC.COGS, credit: cogsReversed });
    }

    const journal = postJournal(ctx, {
      memo: `Sales return ${returnNo} against ${invoice.invoice_no}`,
      sourceType: 'sales_return',
      sourceId: returnId,
      lines: journalLines,
      at,
      bizDate,
    });

    db.run(
      `INSERT INTO sales_returns
        (id, return_no, at, biz_date, invoice_id, customer_id, net_sales, tax, total, cogs,
         restock, refund_method, journal_id, reason, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnId,
        returnNo,
        at,
        bizDate,
        invoice.id,
        invoice.customer_id,
        netSales,
        taxTotal,
        total,
        cogsReversed,
        restock,
        refundMethod,
        journal.id,
        input.reason,
        ctx.userId,
        clock.nowIso(),
      ],
    );

    for (const r of lineResults) {
      db.run(
        `INSERT INTO sales_return_lines
          (id, return_id, sale_line_id, product_id, qty, unit_price, tax, line_total, unit_cost, cogs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, returnId, r.saleLineId, r.productId, r.qty, r.unitPrice, r.tax, r.total, 0, r.cogsReversed],
      );
    }

    // Keep the invoice-level due in step when the customer is credited.
    if (refundMethod === 'credit' && invoice.due > 0) {
      const reduction = Math.min(invoice.due, total);
      db.run('UPDATE sales_invoices SET due = due - ?, updated_at = ? WHERE id = ?', [
        reduction,
        clock.nowIso(),
        invoice.id,
      ]);
    }

    recordAudit(ctx, {
      action: 'sale.return',
      entity: 'sales_return',
      entityId: returnId,
      severity: 'warning',
      details: { returnNo, invoiceNo: invoice.invoice_no, total, restock, refundMethod, reason: input.reason },
    });

    return {
      returnId,
      returnNo,
      netSales,
      tax: taxTotal,
      total,
      cogsReversed,
      journalId: journal.id,
      lines: lineResults,
    };
  });
}

export interface PurchaseReturnLineInput {
  purchaseLineId: string;
  qty: string | number;
}

export interface CreatePurchaseReturnInput {
  purchaseId: string;
  lines: PurchaseReturnLineInput[];
  /** 'payable' reduces the supplier payable; a payment method refunds cash. */
  settlement: string;
  reason: string;
  at?: string;
  bizDate?: string;
}

export interface PurchaseReturnResult {
  returnId: string;
  returnNo: string;
  total: number;
  journalId: string;
}

export function createPurchaseReturn(
  ctx: Ctx,
  input: CreatePurchaseReturnInput,
): PurchaseReturnResult {
  const { db, clock } = ctx;
  if (!input.reason || input.reason.trim() === '') {
    throw new ValidationError('A return reason is required', 'ফেরতের কারণ উল্লেখ করুন।');
  }
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('Select at least one product to return', 'ফেরতের জন্য অন্তত একটি পণ্য নির্বাচন করুন।');
  }
  const settlement = (input.settlement ?? '').trim().toLowerCase();
  if (settlement === '') {
    throw new ValidationError('A settlement method is required', 'নিষ্পত্তির মাধ্যম নির্বাচন করুন।');
  }

  return db.transaction(() => {
    const purchase = db.get<PurchaseRow>('SELECT * FROM purchases WHERE id = ?', [input.purchaseId]);
    if (!purchase) throw new NotFoundError('Purchase not found', 'ক্রয় পাওয়া যায়নি।');
    if (purchase.status === 'voided') {
      throw new BusinessRuleError('CONFLICT', 'A voided purchase cannot be returned', 'বাতিল ক্রয়ে ফেরত সম্ভব নয়।');
    }
    if (settlement !== 'payable' && purchase.due > 0) {
      throw new BusinessRuleError(
        'INSUFFICIENT_PAYMENT',
        'This purchase still has an outstanding payable — adjust the payable instead of taking a cash refund',
        'এই ক্রয়ে পাওনা আছে — নগদ ফেরতের বদলে পাওনা সমন্বয় করুন।',
      );
    }
    if (settlement === 'payable' && !purchase.supplier_id) {
      throw new BusinessRuleError('CONFLICT', 'A payable adjustment requires a supplier', 'পাওনা সমন্বয়ের জন্য সরবরাহকারী প্রয়োজন।');
    }
    if (purchase.supplier_id) getSupplier(ctx, purchase.supplier_id);

    const at = input.at ?? clock.nowIso();
    const bizDate = input.bizDate ?? clock.bizDateOf(at);
    const returnId = newId();
    const returnNo = nextSequence(db, 'purchase_return').formatted;

    // ---- Pass 1: validate every line and compute its exact value ----------
    interface PreparedReturnLine {
      line: PurchaseLineRow;
      qty: number;
      value: number;
    }
    const prepared: PreparedReturnLine[] = [];
    let total = 0;

    for (const lineInput of input.lines) {
      const line = db.get<PurchaseLineRow>(
        'SELECT * FROM purchase_lines WHERE id = ? AND purchase_id = ?',
        [lineInput.purchaseLineId, purchase.id],
      );
      if (!line) throw new NotFoundError('Purchase line not found', 'ক্রয়ের লাইন পাওয়া যায়নি।');
      const requested = toQtyMilli(lineInput.qty);
      if (requested <= 0) continue;
      const eligible = line.qty - line.returned_qty;
      if (requested > eligible) {
        throw new BusinessRuleError(
          'OVER_RETURN',
          `Return quantity for "${line.name_snapshot}" exceeds the eligible quantity (${eligible / 1000})`,
          'ফেরতের পরিমাণ ক্রয়ের পরিমাণের বেশি হতে পারে না।',
          { purchaseLineId: line.id, requested, eligible },
        );
      }
      const level = getStockLevel(ctx, line.product_id);
      if (level.qty < requested) {
        throw new BusinessRuleError(
          'INSUFFICIENT_STOCK',
          `"${line.name_snapshot}" does not have enough stock on hand to return to the supplier`,
          'সরবরাহকারীকে ফেরত দেওয়ার মতো পর্যাপ্ত স্টক নেই।',
          { productId: line.product_id, available: level.qty, requested },
        );
      }
      const isFull = requested === eligible;
      // Value the returned portion at its exact capitalised (landed) cost.
      const alreadyReturnedValue = line.returned_qty > 0
        ? Math.round((line.stock_value * line.returned_qty) / line.qty)
        : 0;
      const value = isFull
        ? line.stock_value - alreadyReturnedValue
        : roundHalfUp(line.stock_value * requested, line.qty);
      prepared.push({ line, qty: requested, value });
      total += value;
    }

    if (prepared.length === 0 || total <= 0) {
      throw new ValidationError('No returnable quantity was entered', 'ফেরতের কোনো পরিমাণ দেওয়া হয়নি।');
    }

    // ---- Pass 2: journal ---------------------------------------------------
    const journalLines: JournalLineInput[] = [];
    if (settlement === 'payable') {
      journalLines.push({
        accountCode: ACC.AP,
        debit: total,
        party: { type: 'supplier', id: purchase.supplier_id as string },
        memo: 'Purchase return adjustment',
      });
    } else {
      journalLines.push({ accountCode: paymentMethodAccountCode(settlement), debit: total });
    }
    journalLines.push({ accountCode: ACC.INVENTORY, credit: total });

    const journal = postJournal(ctx, {
      memo: `Purchase return ${returnNo} against ${purchase.purchase_no}`,
      sourceType: 'purchase_return',
      sourceId: returnId,
      lines: journalLines,
      at,
      bizDate,
    });

    // ---- Pass 3: header, stock movements and lines -------------------------
    db.run(
      `INSERT INTO purchase_returns
        (id, return_no, at, biz_date, purchase_id, supplier_id, total, journal_id, reason, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnId,
        returnNo,
        at,
        bizDate,
        purchase.id,
        purchase.supplier_id,
        total,
        journal.id,
        input.reason,
        ctx.userId,
        clock.nowIso(),
      ],
    );

    for (const item of prepared) {
      // Remove exactly the capitalised value being returned to the supplier so
      // the inventory account and the stock valuation stay identical.
      stockOutExact(ctx, {
        productId: item.line.product_id,
        qty: item.qty,
        totalValue: item.value,
        movement: 'purchase_return',
        refType: 'purchase_return',
        refId: returnId,
        reason: input.reason,
        at,
        bizDate,
      });
      db.run('UPDATE purchase_lines SET returned_qty = returned_qty + ? WHERE id = ?', [
        item.qty,
        item.line.id,
      ]);
      db.run(
        `INSERT INTO purchase_return_lines
          (id, return_id, purchase_line_id, product_id, qty, unit_cost, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          returnId,
          item.line.id,
          item.line.product_id,
          item.qty,
          roundHalfUp(item.value * 1000, item.qty),
          item.value,
        ],
      );
    }

    if (settlement === 'payable' && purchase.due > 0) {
      const reduction = Math.min(purchase.due, total);
      db.run('UPDATE purchases SET due = due - ?, updated_at = ? WHERE id = ?', [
        reduction,
        clock.nowIso(),
        purchase.id,
      ]);
    }

    recordAudit(ctx, {
      action: 'purchase.return',
      entity: 'purchase_return',
      entityId: returnId,
      severity: 'warning',
      details: { returnNo, purchaseNo: purchase.purchase_no, total, settlement, reason: input.reason },
    });

    return { returnId, returnNo, total, journalId: journal.id };
  });
}

export interface SalesReturnListRow {
  id: string;
  return_no: string;
  at: string;
  biz_date: string;
  invoice_id: string;
  invoice_no: string;
  customer_name: string | null;
  net_sales: number;
  tax: number;
  total: number;
  restock: string;
  reason: string | null;
}

export function listSalesReturns(
  ctx: Ctx,
  q: { from?: string; to?: string; limit?: number } = {},
): SalesReturnListRow[] {
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (q.from) {
    where.push('r.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('r.biz_date <= ?');
    params.push(q.to);
  }
  params.push(Math.min(q.limit ?? 200, 1000));
  return ctx.db.all<SalesReturnListRow>(
    `SELECT r.id, r.return_no, r.at, r.biz_date, r.invoice_id, i.invoice_no,
            c.name AS customer_name, r.net_sales, r.tax, r.total, r.restock, r.reason
       FROM sales_returns r
       JOIN sales_invoices i ON i.id = r.invoice_id
       LEFT JOIN customers c ON c.id = r.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.at DESC LIMIT ?`,
    params,
  );
}

export interface PurchaseReturnListRow {
  id: string;
  return_no: string;
  at: string;
  biz_date: string;
  purchase_id: string;
  purchase_no: string;
  supplier_name: string | null;
  total: number;
  reason: string | null;
}

export function listPurchaseReturns(
  ctx: Ctx,
  q: { from?: string; to?: string; limit?: number } = {},
): PurchaseReturnListRow[] {
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (q.from) {
    where.push('r.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('r.biz_date <= ?');
    params.push(q.to);
  }
  params.push(Math.min(q.limit ?? 200, 1000));
  return ctx.db.all<PurchaseReturnListRow>(
    `SELECT r.id, r.return_no, r.at, r.biz_date, r.purchase_id, p.purchase_no,
            s.name AS supplier_name, r.total, r.reason
       FROM purchase_returns r
       JOIN purchases p ON p.id = r.purchase_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.at DESC LIMIT ?`,
    params,
  );
}

/** Returnable quantities for a sale invoice (POS return screen). */
export function returnableInvoiceLines(
  ctx: Ctx,
  invoiceId: string,
): Array<{ lineId: string; productId: string; name: string; qty: number; returned: number; returnable: number; unitPrice: number; lineTotal: number }> {
  const rows = ctx.db.all<SaleLineRow>(
    'SELECT * FROM sale_lines WHERE invoice_id = ? ORDER BY line_no',
    [invoiceId],
  );
  return rows.map((r) => ({
    lineId: r.id,
    productId: r.product_id,
    name: r.name_snapshot,
    qty: r.qty,
    returned: r.returned_qty,
    returnable: r.qty - r.returned_qty,
    unitPrice: r.unit_price,
    lineTotal: r.line_total,
  }));
}

/** Returnable quantities for a purchase (supplier return screen). */
export function returnablePurchaseLines(
  ctx: Ctx,
  purchaseId: string,
): Array<{ lineId: string; productId: string; name: string; qty: number; returned: number; returnable: number; unitCost: number; stockValue: number }> {
  const rows = ctx.db.all<PurchaseLineRow>(
    'SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY line_no',
    [purchaseId],
  );
  return rows.map((r) => ({
    lineId: r.id,
    productId: r.product_id,
    name: r.name_snapshot,
    qty: r.qty,
    returned: r.returned_qty,
    returnable: r.qty - r.returned_qty,
    unitCost: r.unit_cost,
    stockValue: r.stock_value,
  }));
}
