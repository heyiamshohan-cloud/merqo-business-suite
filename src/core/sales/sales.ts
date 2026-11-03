/**
 * Sales / POS engine.
 *
 * A completed sale is a single atomic unit of work covering:
 *   1. invoice header + lines
 *   2. stock issue and COGS at moving-average cost
 *   3. payment receipts (optionally split across methods)
 *   4. customer receivable
 *   5. double-entry journal (revenue, discount, VAT, COGS, cash/AR)
 *   6. audit trail
 *
 * If any step fails the entire transaction rolls back — no invoice can exist
 * without its stock movement, payment and ledger posting.
 *
 * Pricing model:
 *   - Amounts are integer paisa. Tax rates are basis points (10 000 = 100%).
 *   - When `tax.prices_include_tax` is enabled, entered unit prices are
 *     converted to a tax-exclusive basis first, so every subsequent
 *     calculation (discounts, revenue, VAT) is consistent either way.
 *   - Item discounts and the invoice-level discount are tax-exclusive amounts
 *     and are allocated proportionally across lines before VAT is computed.
 */
import { AppError, BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
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
import type { ProductRow, SaleLineRow, SalesInvoiceRow } from '../domain/types';
import { getStockLevel, stockIn, stockOut } from '../inventory/stock';
import { getCustomer, customerBalance } from '../parties/parties';
import { getBoolSetting, getBusinessProfile, getSetting, nextSequence } from '../services/settings';
import { recordAudit } from '../services/audit';

export interface SaleLineInput {
  productId: string;
  /** Quantity in whole units; may be a decimal string for kg/litre items. */
  qty: string | number;
  /** Unit selling price in paisa. Defaults to the product's sale price. */
  unitPrice?: number;
  /** Per-line discount in paisa (tax-exclusive). */
  discount?: number;
  /** VAT rate in basis points. Defaults to the product's configured rate. */
  taxRateBp?: number;
}

export interface SalePaymentInput {
  method: string;
  amount: number; // paisa
  note?: string | null;
}

export interface CreateSaleInput {
  lines: SaleLineInput[];
  customerId?: string | null;
  /** Invoice-level discount in paisa (tax-exclusive). */
  invoiceDiscount?: number;
  payments?: SalePaymentInput[];
  note?: string | null;
  /** Override the sale instant (defaults to now). */
  at?: string;
  /** Explicit invoice date (biz_date) override. */
  bizDate?: string;
  /** Idempotency token from the UI to prevent double submission on Enter. */
  clientToken?: string | null;
  /** Allow selling below cost (still recorded; used for clearance sales). */
  allowNegativeStock?: boolean;
}

export interface SaleLineResult {
  id: string;
  productId: string;
  name: string;
  qty: number;
  unitPrice: number;
  discount: number;
  taxRateBp: number;
  tax: number;
  lineTotal: number;
  unitCost: number;
  cogs: number;
}

export interface CreateSaleResult {
  invoiceId: string;
  invoiceNo: string;
  at: string;
  bizDate: string;
  grossTotal: number;
  itemDiscount: number;
  invoiceDiscount: number;
  taxTotal: number;
  total: number;
  paid: number;
  due: number;
  cogs: number;
  profit: number;
  lines: SaleLineResult[];
  paymentIds: string[];
  journalId: string;
  /** True when an idempotency token matched an existing invoice. */
  idempotentReplay: boolean;
}

interface PreparedLine {
  product: ProductRow;
  qty: number;
  unitPrice: number;
  discount: number;
  taxRateBp: number;
  gross: number;
  netAfterItemDiscount: number;
  invoiceDiscount: number;
  net: number;
  tax: number;
  lineTotal: number;
}

function validateMethod(method: string): string {
  const m = (method ?? '').trim().toLowerCase();
  const found = PAYMENT_METHODS.find((p) => p.key === m);
  if (!found) {
    throw new ValidationError(`Unknown payment method: "${method}"`, 'অজানা পেমেন্ট মাধ্যম।', { method });
  }
  return found.key;
}

/**
 * Compute the whole invoice (pure function of inputs + catalogue) without
 * writing anything. Exposed so the POS screen can preview totals and the test
 * suite can assert arithmetic independently of persistence.
 */
export function priceSale(
  ctx: Ctx,
  input: Pick<CreateSaleInput, 'lines' | 'invoiceDiscount'>,
): {
  lines: Array<{
    product: ProductRow;
    qty: number;
    unitPrice: number;
    discount: number;
    taxRateBp: number;
    gross: number;
    net: number;
    tax: number;
    lineTotal: number;
  }>;
  grossTotal: number;
  itemDiscount: number;
  invoiceDiscount: number;
  taxTotal: number;
  total: number;
} {
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('A sale must contain at least one product', 'বিক্রয়ে কমপক্ষে একটি পণ্য থাকতে হবে।');
  }
  const pricesIncludeTax = getBoolSetting(ctx.db, 'tax.prices_include_tax');
  const taxEnabled = getBoolSetting(ctx.db, 'tax.enabled');

  const prepared: PreparedLine[] = input.lines.map((line, index) => {
    const product = ctx.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [line.productId]);
    if (!product) {
      throw new NotFoundError(`Product not found on line ${index + 1}`, 'পণ্যটি পাওয়া যায়নি।', {
        productId: line.productId,
        line: index + 1,
      });
    }
    if (product.status !== 'active') {
      throw new BusinessRuleError(
        'CONFLICT',
        `Product "${product.name}" is archived and cannot be sold`,
        'আর্কাইভ করা পণ্য বিক্রয় করা যাবে না।',
        { productId: product.id },
      );
    }
    const qty = toQtyMilli(line.qty);
    if (qty <= 0) {
      throw new ValidationError(
        `Quantity on line ${index + 1} must be greater than zero`,
        'পরিমাণ শূন্যের বেশি হতে হবে।',
        { line: index + 1 },
      );
    }
    const rawUnitPrice = line.unitPrice ?? product.sale_price;
    if (!Number.isInteger(rawUnitPrice) || rawUnitPrice < 0) {
      throw new ValidationError(
        `Unit price on line ${index + 1} is invalid`,
        'একক মূল্য সঠিকভাবে দিন।',
        { line: index + 1 },
      );
    }
    const taxRateBp = taxEnabled
      ? (line.taxRateBp ?? product.tax_rate_bp ?? 0)
      : 0;
    if (taxRateBp < 0 || taxRateBp > BP_SCALE) {
      throw new ValidationError('Tax rate is out of range', 'ভ্যাটের হার সঠিক নয়।');
    }

    const unitPrice =
      pricesIncludeTax && taxRateBp > 0
        ? roundHalfUp(rawUnitPrice * BP_SCALE, BP_SCALE + taxRateBp)
        : rawUnitPrice;

    const gross = mulPriceQty(unitPrice, qty);
    const discount = line.discount ?? 0;
    if (!Number.isInteger(discount) || discount < 0) {
      throw new ValidationError(
        `Discount on line ${index + 1} is invalid`,
        'ছাড়ের পরিমাণ সঠিক নয়।',
        { line: index + 1 },
      );
    }
    if (discount > gross) {
      throw new ValidationError(
        `Discount on line ${index + 1} cannot exceed the line amount`,
        'লাইনের ছাড় লাইনের মূল্যের বেশি হতে পারে না।',
        { line: index + 1, discount, gross },
      );
    }
    const netAfterItemDiscount = gross - discount;

    return {
      product,
      qty,
      unitPrice,
      discount,
      taxRateBp,
      gross,
      netAfterItemDiscount,
      invoiceDiscount: 0,
      net: netAfterItemDiscount,
      tax: 0,
      lineTotal: 0,
    };
  });

  const itemDiscount = prepared.reduce((a, l) => a + l.discount, 0);
  const grossTotal = prepared.reduce((a, l) => a + l.gross, 0);
  const invoiceDiscount = input.invoiceDiscount ?? 0;
  if (!Number.isInteger(invoiceDiscount) || invoiceDiscount < 0) {
    throw new ValidationError('Invoice discount is invalid', 'ইনভয়েস ছাড়ের পরিমাণ সঠিক নয়।');
  }
  const discountable = prepared.reduce((a, l) => a + l.netAfterItemDiscount, 0);
  if (invoiceDiscount > discountable) {
    throw new ValidationError(
      'Invoice discount cannot exceed the invoice amount',
      'ইনভয়েস ছাড় মোট মূল্যের বেশি হতে পারে না।',
      { invoiceDiscount, discountable },
    );
  }

  // Allocate the invoice discount proportionally (exactly, no rounding drift).
  const allocations = allocate(
    invoiceDiscount,
    prepared.map((l) => l.netAfterItemDiscount),
  );

  let taxTotal = 0;
  let total = 0;
  const lines = prepared.map((line, i) => {
    const invDisc = allocations[i] ?? 0;
    const net = line.netAfterItemDiscount - invDisc;
    const tax = applyBasisPoints(net, line.taxRateBp);
    const lineTotal = net + tax;
    taxTotal += tax;
    total += lineTotal;
    return {
      product: line.product,
      qty: line.qty,
      unitPrice: line.unitPrice,
      discount: line.discount,
      taxRateBp: line.taxRateBp,
      gross: line.gross,
      net,
      tax,
      lineTotal,
      invoiceDiscount: invDisc,
    };
  });

  return { lines, grossTotal, itemDiscount, invoiceDiscount, taxTotal, total };
}

export function createSale(ctx: Ctx, input: CreateSaleInput): CreateSaleResult {
  const { db, clock } = ctx;

  // --- Idempotency: return the existing invoice for a repeated token --------
  if (input.clientToken) {
    const existing = db.get<SalesInvoiceRow>('SELECT * FROM sales_invoices WHERE client_token = ?', [
      input.clientToken,
    ]);
    if (existing) {
      const lines = db.all<SaleLineRow>(
        'SELECT * FROM sale_lines WHERE invoice_id = ? ORDER BY line_no',
        [existing.id],
      );
      const payments = db.all<{ id: string }>('SELECT id FROM payments WHERE id IN (SELECT payment_id FROM payment_allocations WHERE doc_type = ? AND doc_id = ?)', [
        'sales_invoice',
        existing.id,
      ]);
      return {
        invoiceId: existing.id,
        invoiceNo: existing.invoice_no,
        at: existing.at,
        bizDate: existing.biz_date,
        grossTotal: existing.gross_total,
        itemDiscount: existing.item_discount,
        invoiceDiscount: existing.invoice_discount,
        taxTotal: existing.tax_total,
        total: existing.total,
        paid: existing.paid,
        due: existing.due,
        cogs: existing.cogs,
        profit: existing.profit,
        lines: lines.map((l) => ({
          id: l.id,
          productId: l.product_id,
          name: l.name_snapshot,
          qty: l.qty,
          unitPrice: l.unit_price,
          discount: l.discount,
          taxRateBp: l.tax_rate_bp,
          tax: l.tax,
          lineTotal: l.line_total,
          unitCost: l.unit_cost,
          cogs: l.cogs,
        })),
        paymentIds: payments.map((p) => p.id),
        journalId: existing.journal_id ?? '',
        idempotentReplay: true,
      };
    }
  }

  const priced = priceSale(ctx, input);
  const at = input.at ?? clock.nowIso();
  const bizDate = input.bizDate ?? clock.bizDateOf(at);

  // --- Payments & credit checks -------------------------------------------
  const paymentInputs = (input.payments ?? []).filter((p) => p.amount > 0);
  const paidTotal = paymentInputs.reduce((a, p) => a + p.amount, 0);
  if (paidTotal > priced.total) {
    throw new ValidationError(
      `Paid amount (${paidTotal}) exceeds the invoice total (${priced.total})`,
      'পরিশোধিত টাকা মোট মূল্যের বেশি হতে পারে না।',
      { paidTotal, total: priced.total },
    );
  }
  const dueTotal = priced.total - paidTotal;
  if (dueTotal > 0 && !input.customerId) {
    throw new ValidationError(
      'A customer must be selected when the invoice has an outstanding amount',
      'বাকি বিক্রয়ের জন্য গ্রাহক নির্বাচন করতে হবে।',
      { dueTotal },
    );
  }
  if (input.customerId) {
    const customer = getCustomer(ctx, input.customerId);
    if (customer.status !== 'active') {
      throw new BusinessRuleError(
        'CONFLICT',
        'The selected customer is archived',
        'নির্বাচিত গ্রাহক আর্কাইভ করা হয়েছে।',
      );
    }
    if (customer.credit_limit > 0) {
      const currentBalance = customerBalance(ctx, customer.id);
      if (currentBalance + dueTotal > customer.credit_limit) {
        throw new BusinessRuleError(
          'CONFLICT',
          `Credit limit exceeded for ${customer.name}: limit ${customer.credit_limit}, projected balance ${currentBalance + dueTotal}`,
          'গ্রাহকের বাকির সীমা অতিক্রম করেছে।',
          { customerId: customer.id, creditLimit: customer.credit_limit, projected: currentBalance + dueTotal },
        );
      }
    }
  }

  return db.transaction(() => {
    // Re-check idempotency inside the transaction to close the race window.
    if (input.clientToken) {
      const again = db.get<{ id: string }>('SELECT id FROM sales_invoices WHERE client_token = ?', [
        input.clientToken,
      ]);
      if (again) {
        throw new AppError('Duplicate sale submission detected', {
          code: 'CONFLICT',
          messageBn: 'একই বিক্রয় দুইবার জমা হয়েছে — প্রতিরোধ করা হয়েছে।',
          details: { invoiceId: again.id },
        });
      }
    }

    const invoiceNo = nextSequence(db, 'invoice', getSetting(db, 'invoice.prefix')).formatted;
    const invoiceId = newId();

    // 1. Issue stock and compute COGS line by line.
    let cogsTotal = 0;
    const lineResults: Array<SaleLineResult & { unitCost: number }> = [];
    let lineNo = 0;
    for (const line of priced.lines) {
      lineNo++;
      const issued = stockOut(ctx, {
        productId: line.product.id,
        qty: line.qty,
        movement: 'sale',
        refType: 'sales_invoice',
        refId: invoiceId,
        at,
        bizDate,
        allowNegative: input.allowNegativeStock,
      });
      cogsTotal += issued.cogs;
      lineResults.push({
        id: newId(),
        productId: line.product.id,
        name: line.product.name,
        qty: line.qty,
        unitPrice: line.unitPrice,
        discount: line.discount,
        taxRateBp: line.taxRateBp,
        tax: line.tax,
        lineTotal: line.lineTotal,
        unitCost: issued.unitCost,
        cogs: issued.cogs,
      });
    }
    const revenueTotal = priced.lines.reduce((a, l) => a + l.net, 0);
    const profit = revenueTotal - cogsTotal;

    // 2. Journal: revenue, discounts, VAT, receivables and COGS.
    const profile = getBusinessProfile(db);
    const journalLines: JournalLineInput[] = [];
    for (const payment of paymentInputs) {
      journalLines.push({
        accountCode: paymentMethodAccountCode(payment.method),
        debit: payment.amount,
        memo: `Sale receipt (${payment.method})`,
      });
    }
    if (dueTotal > 0 && input.customerId) {
      journalLines.push({
        accountCode: ACC.AR,
        debit: dueTotal,
        party: { type: 'customer' as const, id: input.customerId },
        memo: 'Invoice due',
      });
    }
    if (priced.itemDiscount + priced.invoiceDiscount > 0) {
      journalLines.push({
        accountCode: ACC.SALES_DISCOUNT,
        debit: priced.itemDiscount + priced.invoiceDiscount,
      });
    }
    journalLines.push({ accountCode: ACC.SALES, credit: priced.grossTotal });
    if (priced.taxTotal > 0) {
      journalLines.push({
        accountCode: ACC.VAT_PAYABLE,
        credit: priced.taxTotal,
        memo: `${profile.taxLabel} on sales`,
      });
    }
    if (cogsTotal > 0) {
      journalLines.push({ accountCode: ACC.COGS, debit: cogsTotal });
      journalLines.push({ accountCode: ACC.INVENTORY, credit: cogsTotal });
    }

    const journal = postJournal(ctx, {
      memo: `Sales invoice ${invoiceNo}`,
      sourceType: 'sale',
      sourceId: invoiceId,
      lines: journalLines,
      at,
      bizDate,
    });

    // 3. Invoice header + lines.
    db.run(
      `INSERT INTO sales_invoices
        (id, invoice_no, at, biz_date, customer_id, status, gross_total, item_discount,
         invoice_discount, tax_total, total, paid, due, cogs, profit, payment_method,
         journal_id, note, client_token, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId,
        invoiceNo,
        at,
        bizDate,
        input.customerId ?? null,
        priced.grossTotal,
        priced.itemDiscount,
        priced.invoiceDiscount,
        priced.taxTotal,
        priced.total,
        paidTotal,
        dueTotal,
        cogsTotal,
        profit,
        paymentInputs[0]?.method ?? (dueTotal > 0 ? 'credit' : 'cash'),
        journal.id,
        input.note ?? null,
        input.clientToken ?? null,
        ctx.userId,
        clock.nowIso(),
        clock.nowIso(),
      ],
    );

    for (let i = 0; i < lineResults.length; i++) {
      const r = lineResults[i];
      db.run(
        `INSERT INTO sale_lines
          (id, invoice_id, line_no, product_id, name_snapshot, qty, unit_price, discount,
           tax_rate_bp, tax, line_total, unit_cost, cogs, returned_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          r.id,
          invoiceId,
          i + 1,
          r.productId,
          r.name,
          r.qty,
          r.unitPrice,
          r.discount,
          r.taxRateBp,
          r.tax,
          r.lineTotal,
          r.unitCost,
          r.cogs,
        ],
      );
    }

    // 4. Payments (one row per method) with allocations to this invoice.
    const paymentIds: string[] = [];
    for (const payment of paymentInputs) {
      const method = validateMethod(payment.method);
      const paymentId = newId();
      const receiptNo = nextSequence(db, 'receipt').formatted;
      db.run(
        `INSERT INTO payments
          (id, receipt_no, at, biz_date, direction, party_type, party_id, method, amount, note,
           journal_id, client_token, user_id, created_at)
         VALUES (?, ?, ?, ?, 'in', 'customer', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          paymentId,
          receiptNo,
          at,
          bizDate,
          input.customerId ?? WALK_IN_CUSTOMER_ID,
          method,
          payment.amount,
          payment.note ?? null,
          journal.id,
          ctx.userId,
          clock.nowIso(),
        ],
      );
      db.run(
        `INSERT INTO payment_allocations (id, payment_id, doc_type, doc_id, amount)
         VALUES (?, ?, 'sales_invoice', ?, ?)`,
        [newId(), paymentId, invoiceId, payment.amount],
      );
      paymentIds.push(paymentId);
    }

    recordAudit(ctx, {
      action: 'sale.create',
      entity: 'sales_invoice',
      entityId: invoiceId,
      details: {
        invoiceNo,
        total: priced.total,
        paid: paidTotal,
        due: dueTotal,
        cogs: cogsTotal,
        profit,
      },
    });

    return {
      invoiceId,
      invoiceNo,
      at,
      bizDate,
      grossTotal: priced.grossTotal,
      itemDiscount: priced.itemDiscount,
      invoiceDiscount: priced.invoiceDiscount,
      taxTotal: priced.taxTotal,
      total: priced.total,
      paid: paidTotal,
      due: dueTotal,
      cogs: cogsTotal,
      profit,
      lines: lineResults,
      paymentIds,
      journalId: journal.id,
      idempotentReplay: false,
    };
  });
}

/**
 * Walk-in sales without a registered customer still need a party reference on
 * receipts. A reserved id keeps the journal clean without inventing a fake
 * customer row that would appear in the customer list.
 */
export const WALK_IN_CUSTOMER_ID = 'walk-in';

export interface VoidSaleResult {
  invoiceId: string;
  reversalJournalId: string;
}

/**
 * Void a completed invoice.
 * Only invoices with no payments and no returns can be voided; anything with
 * money attached must go through a sales return so the cash trail stays intact.
 */
export function voidSale(ctx: Ctx, invoiceId: string, reason: string): VoidSaleResult {
  if (!reason || reason.trim() === '') {
    throw new ValidationError('A void reason is required', 'বাতিলের কারণ উল্লেখ করুন।');
  }
  const { db, clock } = ctx;
  return db.transaction(() => {
    const invoice = db.get<SalesInvoiceRow>('SELECT * FROM sales_invoices WHERE id = ?', [invoiceId]);
    if (!invoice) throw new NotFoundError('Invoice not found', 'ইনভয়েস পাওয়া যায়নি।', { invoiceId });
    if (invoice.status === 'voided') {
      throw new BusinessRuleError('CONFLICT', 'Invoice is already voided', 'ইনভয়েস ইতিমধ্যে বাতিল করা হয়েছে।');
    }
    if (invoice.paid > 0) {
      throw new BusinessRuleError(
        'IMMUTABLE_RECORD',
        'An invoice with payments cannot be voided — record a sales return instead',
        'পরিশোধিত ইনভয়েস বাতিল করা যায় না — বিক্রয় ফেরত ব্যবহার করুন।',
        { invoiceId, paid: invoice.paid },
      );
    }
    const returns = db.count('sales_returns', 'invoice_id = ?', [invoiceId]);
    if (returns > 0) {
      throw new BusinessRuleError(
        'IMMUTABLE_RECORD',
        'An invoice with returns cannot be voided',
        'ফেরতযুক্ত ইনভয়েস বাতিল করা যায় না।',
        { invoiceId, returns },
      );
    }
    if (!invoice.journal_id) {
      throw new BusinessRuleError('CONFLICT', 'Invoice has no journal entry', 'ইনভয়েসের হিসাব এন্ট্রি নেই।');
    }

    const reversal = reverseJournal(ctx, invoice.journal_id, `Void invoice ${invoice.invoice_no}: ${reason}`);

    // Return the goods to stock at their original cost price.
    const lines = db.all<SaleLineRow>('SELECT * FROM sale_lines WHERE invoice_id = ?', [invoiceId]);
    for (const line of lines) {
      const level = getStockLevel(ctx, line.product_id);
      // Only restore stock for products that are still stock-tracked.
      const product = db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [line.product_id]);
      if (!product || product.track_stock !== 1) continue;
      if (level.qty < 0) continue; // negative-stock sale: reversing would double count
      stockIn(ctx, {
        productId: line.product_id,
        qty: line.qty,
        totalValue: line.cogs,
        movement: 'adjustment',
        refType: 'void_sale',
        refId: invoiceId,
        reason: `Void of invoice ${invoice.invoice_no}`,
        at: clock.nowIso(),
      });
    }

    db.run(
      "UPDATE sales_invoices SET status = 'voided', due = 0, updated_at = ? WHERE id = ?",
      [clock.nowIso(), invoiceId],
    );
    recordAudit(ctx, {
      action: 'sale.void',
      entity: 'sales_invoice',
      entityId: invoiceId,
      severity: 'warning',
      details: { invoiceNo: invoice.invoice_no, reason, reversalJournalId: reversal.id },
    });
    return { invoiceId, reversalJournalId: reversal.id };
  });
}

export interface InvoiceDetail {
  invoice: SalesInvoiceRow;
  lines: SaleLineRow[];
  payments: Array<{
    id: string;
    receipt_no: string;
    at: string;
    method: string;
    amount: number;
  }>;
  returns: Array<{
    id: string;
    return_no: string;
    at: string;
    total: number;
    restock: string;
  }>;
}

export function getInvoice(ctx: Ctx, invoiceId: string): InvoiceDetail {
  const invoice = ctx.db.get<SalesInvoiceRow>(
    `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone
       FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = ?`,
    [invoiceId],
  );
  if (!invoice) throw new NotFoundError('Invoice not found', 'ইনভয়েস পাওয়া যায়নি।', { invoiceId });
  const lines = ctx.db.all<SaleLineRow>(
    'SELECT * FROM sale_lines WHERE invoice_id = ? ORDER BY line_no',
    [invoiceId],
  );
  const payments = ctx.db.all<{
    id: string;
    receipt_no: string;
    at: string;
    method: string;
    amount: number;
  }>(
    `SELECT p.id, p.receipt_no, p.at, p.method, pa.amount
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
      WHERE pa.doc_type = 'sales_invoice' AND pa.doc_id = ?
      ORDER BY p.at`,
    [invoiceId],
  );
  const returns = ctx.db.all<{ id: string; return_no: string; at: string; total: number; restock: string }>(
    'SELECT id, return_no, at, total, restock FROM sales_returns WHERE invoice_id = ? ORDER BY at',
    [invoiceId],
  );
  return { invoice, lines, payments, returns };
}

export function findInvoiceByNo(ctx: Ctx, invoiceNo: string): SalesInvoiceRow | undefined {
  return ctx.db.get<SalesInvoiceRow>('SELECT * FROM sales_invoices WHERE invoice_no = ?', [
    invoiceNo.trim(),
  ]);
}

export interface InvoiceQuery {
  from?: string;
  to?: string;
  customerId?: string;
  search?: string;
  status?: 'completed' | 'voided' | 'all';
  withDueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export function listInvoices(
  ctx: Ctx,
  q: InvoiceQuery = {},
): { rows: SalesInvoiceRow[]; total: number; page: number; pageSize: number; totalPages: number; totals: { total: number; paid: number; due: number } } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.from) {
    where.push('i.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('i.biz_date <= ?');
    params.push(q.to);
  }
  if (q.customerId) {
    where.push('i.customer_id = ?');
    params.push(q.customerId);
  }
  const status = q.status ?? 'all';
  if (status !== 'all') {
    where.push('i.status = ?');
    params.push(status);
  }
  if (q.withDueOnly) where.push('i.due > 0');
  if (q.search && q.search.trim() !== '') {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push('(LOWER(i.invoice_no) LIKE ? OR LOWER(COALESCE(c.name,\'\')) LIKE ?)');
    params.push(term, term);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.sum(
    `SELECT COUNT(*) AS v FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id ${whereSql}`,
    params,
  );
  const sums = ctx.db.get<{ total: number; paid: number; due: number }>(
    `SELECT COALESCE(SUM(i.total),0) AS total, COALESCE(SUM(i.paid),0) AS paid, COALESCE(SUM(i.due),0) AS due
       FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id ${whereSql}`,
    params,
  );
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(Math.max(1, q.pageSize ?? 50), 500);
  const rows = ctx.db.all<SalesInvoiceRow>(
    `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone
       FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id
       ${whereSql}
     ORDER BY i.at DESC, i.rowid DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    totals: {
      total: sums?.total ?? 0,
      paid: sums?.paid ?? 0,
      due: sums?.due ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Held sales (park / resume)
// ---------------------------------------------------------------------------
export interface HeldSaleInput {
  label: string;
  payload: unknown;
}

export function holdSale(ctx: Ctx, input: HeldSaleInput): { id: string } {
  if (!input.label || input.label.trim() === '') {
    throw new ValidationError('A label is required to hold a sale', 'হোল্ড করার জন্য একটি নাম দিন।');
  }
  const id = newId();
  ctx.db.run('INSERT INTO held_sales (id, at, label, payload, user_id) VALUES (?, ?, ?, ?, ?)', [
    id,
    ctx.clock.nowIso(),
    input.label.trim(),
    JSON.stringify(input.payload),
    ctx.userId,
  ]);
  return { id };
}

export function listHeldSales(
  ctx: Ctx,
): Array<{ id: string; at: string; label: string; payload: unknown }> {
  const rows = ctx.db.all<{ id: string; at: string; label: string; payload: string }>(
    'SELECT id, at, label, payload FROM held_sales ORDER BY at DESC',
  );
  return rows.map((r) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(r.payload);
    } catch {
      parsed = null;
    }
    return { id: r.id, at: r.at, label: r.label, payload: parsed };
  });
}

export function deleteHeldSale(ctx: Ctx, id: string): void {
  ctx.db.run('DELETE FROM held_sales WHERE id = ?', [id]);
}

/** Today's sales summary for the dashboard (revenue = net of discounts, excl. VAT). */
export function salesTotals(
  ctx: Ctx,
  window: { from: string; to: string },
): { count: number; gross: number; discount: number; tax: number; total: number; paid: number; due: number; cogs: number; profit: number } {
  const row = ctx.db.get<{
    count: number;
    gross: number;
    discount: number;
    tax: number;
    total: number;
    paid: number;
    due: number;
    cogs: number;
    profit: number;
  }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(gross_total), 0) AS gross,
            COALESCE(SUM(item_discount + invoice_discount), 0) AS discount,
            COALESCE(SUM(tax_total), 0) AS tax,
            COALESCE(SUM(total), 0) AS total,
            COALESCE(SUM(paid), 0) AS paid,
            COALESCE(SUM(due), 0) AS due,
            COALESCE(SUM(cogs), 0) AS cogs,
            COALESCE(SUM(profit), 0) AS profit
       FROM sales_invoices
      WHERE status = 'completed' AND biz_date >= ? AND biz_date <= ?`,
    [window.from, window.to],
  );
  return (
    row ?? {
      count: 0,
      gross: 0,
      discount: 0,
      tax: 0,
      total: 0,
      paid: 0,
      due: 0,
      cogs: 0,
      profit: 0,
    }
  );
}
