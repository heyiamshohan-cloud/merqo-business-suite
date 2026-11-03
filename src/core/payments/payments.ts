/**
 * Payments: customer receipts (money in) and supplier payments (money out).
 *
 * Payments are always recorded individually, linked to the party, and
 * allocated against open documents FIFO (oldest first) so the customer /
 * supplier statement reconciles exactly with the invoice-level due amounts.
 *
 * Customer receipt:  Dr Cash|Bank|MFS / Cr Accounts Receivable (party)
 * Supplier payment:  Dr Accounts Payable (party) / Cr Cash|Bank|MFS
 */
import { BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import type { Ctx } from '../kernel';
import { ACC, paymentMethodAccountCode, PAYMENT_METHODS } from '../accounting/accounts';
import { postJournal, type JournalLineInput } from '../accounting/journal';
import type { PaymentRow } from '../domain/types';
import { customerBalance, getCustomer, getSupplier, supplierBalance } from '../parties/parties';
import { nextSequence } from '../services/settings';
import { recordAudit } from '../services/audit';

function validateMethod(method: string): string {
  const m = (method ?? '').trim().toLowerCase();
  const found = PAYMENT_METHODS.find((p) => p.key === m);
  if (!found) {
    throw new ValidationError(`Unknown payment method: "${method}"`, 'অজানা পেমেন্ট মাধ্যম।', { method });
  }
  return found.key;
}

export interface CustomerPaymentInput {
  customerId: string;
  amount: number; // paisa
  method: string;
  note?: string | null;
  /** Optional explicit invoice to settle; otherwise FIFO across open invoices. */
  invoiceId?: string | null;
  at?: string;
  bizDate?: string;
  /** Accept payment larger than the outstanding balance (posted as advance). */
  allowAdvance?: boolean;
  clientToken?: string | null;
}

export interface PaymentResult {
  paymentId: string;
  receiptNo: string;
  amount: number;
  allocations: Array<{ docType: 'sales_invoice' | 'purchase'; docId: string; amount: number }>;
  unallocated: number;
  journalId: string;
  newBalance: number;
}

interface OpenDoc {
  id: string;
  due: number;
}

function allocateFifo(amount: number, docs: OpenDoc[]): Array<{ docId: string; amount: number }> {
  let remaining = amount;
  const out: Array<{ docId: string; amount: number }> = [];
  for (const doc of docs) {
    if (remaining <= 0) break;
    if (doc.due <= 0) continue;
    const applied = Math.min(remaining, doc.due);
    out.push({ docId: doc.id, amount: applied });
    remaining -= applied;
  }
  return out;
}

export function receiveFromCustomer(ctx: Ctx, input: CustomerPaymentInput): PaymentResult {
  const { db, clock } = ctx;
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new ValidationError('Payment amount must be greater than zero', 'টাকার পরিমাণ শূন্যের বেশি হতে হবে।');
  }
  const method = validateMethod(input.method);
  const customer = getCustomer(ctx, input.customerId);
  if (customer.status !== 'active') {
    throw new BusinessRuleError('CONFLICT', 'Customer is archived', 'গ্রাহক আর্কাইভ করা হয়েছে।');
  }

  return db.transaction(() => {
    if (input.clientToken) {
      const dupe = db.get<{ id: string }>('SELECT id FROM payments WHERE client_token = ?', [
        input.clientToken,
      ]);
      if (dupe) {
        throw new BusinessRuleError(
          'CONFLICT',
          'Duplicate payment submission detected',
          'একই পেমেন্ট দুইবার জমা হয়েছে — প্রতিরোধ করা হয়েছে।',
        );
      }
    }

    const balance = customerBalance(ctx, customer.id);
    if (input.amount > balance && !input.allowAdvance) {
      throw new BusinessRuleError(
        'INSUFFICIENT_PAYMENT',
        `Payment (${input.amount}) exceeds the outstanding balance (${balance})`,
        'পরিশোধের পরিমাণ বাকির চেয়ে বেশি।',
        { amount: input.amount, outstanding: balance },
      );
    }

    const at = input.at ?? clock.nowIso();
    const bizDate = input.bizDate ?? clock.bizDateOf(at);

    let docs: OpenDoc[];
    if (input.invoiceId) {
      const invoice = db.get<{ id: string; due: number }>(
        'SELECT id, due FROM sales_invoices WHERE id = ? AND customer_id = ?',
        [input.invoiceId, customer.id],
      );
      if (!invoice) {
        throw new NotFoundError('Invoice not found for this customer', 'এই গ্রাহকের ইনভয়েস পাওয়া যায়নি।');
      }
      docs = invoice.due > 0 ? [{ id: invoice.id, due: invoice.due }] : [];
    } else {
      docs = db.all<OpenDoc>(
        `SELECT id, due FROM sales_invoices
          WHERE customer_id = ? AND status = 'completed' AND due > 0
          ORDER BY biz_date ASC, at ASC`,
        [customer.id],
      );
    }

    const planned = allocateFifo(input.amount, docs);
    const allocatedTotal = planned.reduce((a, p) => a + p.amount, 0);
    const unallocated = input.amount - allocatedTotal;

    if (unallocated > 0 && !input.allowAdvance) {
      throw new BusinessRuleError(
        'INSUFFICIENT_PAYMENT',
        'Payment exceeds the open invoice balance. Enable advance payment to continue.',
        'পরিশোধের পরিমাণ বাকির চেয়ে বেশি। অগ্রিম অনুমোদন করুন।',
        { unallocated },
      );
    }

    const journalLines: JournalLineInput[] = [];
    // A cash sale settles its own invoice inside createSale, so a receipt with
    // no open invoice (allocatedTotal === 0) is booked entirely as an advance.
    journalLines.push({ accountCode: paymentMethodAccountCode(method), debit: input.amount });
    if (allocatedTotal > 0) {
      journalLines.push({
        accountCode: ACC.AR,
        credit: allocatedTotal,
        party: { type: 'customer', id: customer.id },
      });
    }
    const remainingCredit = input.amount - allocatedTotal;
    if (remainingCredit > 0) {
      journalLines.push({
        accountCode: ACC.CUSTOMER_ADVANCE,
        credit: remainingCredit,
        party: { type: 'customer', id: customer.id },
        memo: 'Advance received',
      });
    }
    const journal = postJournal(ctx, {
      memo: `Customer receipt (${customer.name})`,
      sourceType: 'customer_payment',
      sourceId: null,
      lines: journalLines,
      at,
      bizDate,
    });

    const paymentId = newId();
    const receiptNo = nextSequence(db, 'receipt').formatted;
    db.run(
      `INSERT INTO payments
        (id, receipt_no, at, biz_date, direction, party_type, party_id, method, amount, note,
         journal_id, client_token, user_id, created_at)
       VALUES (?, ?, ?, ?, 'in', 'customer', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentId,
        receiptNo,
        at,
        bizDate,
        customer.id,
        method,
        input.amount,
        input.note ?? null,
        journal.id,
        input.clientToken ?? null,
        ctx.userId,
        clock.nowIso(),
      ],
    );

    for (const alloc of planned) {
      db.run(
        `INSERT INTO payment_allocations (id, payment_id, doc_type, doc_id, amount)
         VALUES (?, ?, 'sales_invoice', ?, ?)`,
        [newId(), paymentId, alloc.docId, alloc.amount],
      );
      db.run(
        'UPDATE sales_invoices SET due = due - ?, paid = paid + ?, updated_at = ? WHERE id = ?',
        [alloc.amount, alloc.amount, clock.nowIso(), alloc.docId],
      );
    }
    // Reflect the allocation on the payment row's journal link for the receipt.
    recordAudit(ctx, {
      action: 'payment.customer.receive',
      entity: 'payment',
      entityId: paymentId,
      details: { customerId: customer.id, amount: input.amount, method, unallocated },
    });

    return {
      paymentId,
      receiptNo,
      amount: input.amount,
      allocations: planned.map((p) => ({
        docType: 'sales_invoice' as const,
        docId: p.docId,
        amount: p.amount,
      })),
      unallocated,
      journalId: journal.id,
      newBalance: customerBalance(ctx, customer.id),
    };
  });
}

export interface SupplierPaymentInput {
  supplierId: string;
  amount: number;
  method: string;
  note?: string | null;
  purchaseId?: string | null;
  at?: string;
  bizDate?: string;
  allowAdvance?: boolean;
  clientToken?: string | null;
}

export function paySupplier(ctx: Ctx, input: SupplierPaymentInput): PaymentResult {
  const { db, clock } = ctx;
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new ValidationError('Payment amount must be greater than zero', 'টাকার পরিমাণ শূন্যের বেশি হতে হবে।');
  }
  const method = validateMethod(input.method);
  const supplier = getSupplier(ctx, input.supplierId);
  if (supplier.status !== 'active') {
    throw new BusinessRuleError('CONFLICT', 'Supplier is archived', 'সরবরাহকারী আর্কাইভ করা হয়েছে।');
  }

  return db.transaction(() => {
    if (input.clientToken) {
      const dupe = db.get<{ id: string }>('SELECT id FROM payments WHERE client_token = ?', [
        input.clientToken,
      ]);
      if (dupe) {
        throw new BusinessRuleError(
          'CONFLICT',
          'Duplicate payment submission detected',
          'একই পেমেন্ট দুইবার জমা হয়েছে — প্রতিরোধ করা হয়েছে।',
        );
      }
    }

    const balance = supplierBalance(ctx, supplier.id);
    if (input.amount > balance && !input.allowAdvance) {
      throw new BusinessRuleError(
        'INSUFFICIENT_PAYMENT',
        `Payment (${input.amount}) exceeds the payable balance (${balance})`,
        'পরিশোধের পরিমাণ পাওনার চেয়ে বেশি।',
        { amount: input.amount, outstanding: balance },
      );
    }

    const at = input.at ?? clock.nowIso();
    const bizDate = input.bizDate ?? clock.bizDateOf(at);

    const docs = input.purchaseId
      ? db.all<OpenDoc>('SELECT id, due FROM purchases WHERE id = ? AND supplier_id = ? AND due > 0', [
          input.purchaseId,
          supplier.id,
        ])
      : db.all<OpenDoc>(
          `SELECT id, due FROM purchases
            WHERE supplier_id = ? AND status = 'completed' AND due > 0
            ORDER BY biz_date ASC, at ASC`,
          [supplier.id],
        );

    const planned = allocateFifo(input.amount, docs);
    const allocatedTotal = planned.reduce((a, p) => a + p.amount, 0);
    const unallocated = input.amount - allocatedTotal;
    if (unallocated > 0 && !input.allowAdvance) {
      throw new BusinessRuleError(
        'INSUFFICIENT_PAYMENT',
        'Payment exceeds the open payable. Enable advance payment to continue.',
        'পরিশোধের পরিমাণ পাওনার চেয়ে বেশি। অগ্রিম অনুমোদন করুন।',
        { unallocated },
      );
    }
    if (unallocated > 0) {
      throw new ValidationError(
        'Supplier advance payments are not supported; pay the exact outstanding amount',
        'সরবরাহকারীকে অগ্রিম প্রদান সমর্থিত নয়।',
        { unallocated },
      );
    }

    const journalLines = [
      {
        accountCode: ACC.AP,
        debit: input.amount,
        party: { type: 'supplier' as const, id: supplier.id },
      },
      { accountCode: paymentMethodAccountCode(method), credit: input.amount },
    ];
    const journal = postJournal(ctx, {
      memo: `Supplier payment (${supplier.name})`,
      sourceType: 'supplier_payment',
      sourceId: null,
      lines: journalLines,
      at,
      bizDate,
    });

    const paymentId = newId();
    const receiptNo = nextSequence(db, 'payment').formatted;
    db.run(
      `INSERT INTO payments
        (id, receipt_no, at, biz_date, direction, party_type, party_id, method, amount, note,
         journal_id, client_token, user_id, created_at)
       VALUES (?, ?, ?, ?, 'out', 'supplier', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentId,
        receiptNo,
        at,
        bizDate,
        supplier.id,
        method,
        input.amount,
        input.note ?? null,
        journal.id,
        input.clientToken ?? null,
        ctx.userId,
        clock.nowIso(),
      ],
    );

    for (const alloc of planned) {
      db.run(
        `INSERT INTO payment_allocations (id, payment_id, doc_type, doc_id, amount)
         VALUES (?, ?, 'purchase', ?, ?)`,
        [newId(), paymentId, alloc.docId, alloc.amount],
      );
      db.run('UPDATE purchases SET due = due - ?, paid = paid + ?, updated_at = ? WHERE id = ?', [
        alloc.amount,
        alloc.amount,
        clock.nowIso(),
        alloc.docId,
      ]);
    }

    recordAudit(ctx, {
      action: 'payment.supplier.pay',
      entity: 'payment',
      entityId: paymentId,
      details: { supplierId: supplier.id, amount: input.amount, method },
    });

    return {
      paymentId,
      receiptNo,
      amount: input.amount,
      allocations: planned.map((p) => ({
        docType: 'purchase' as const,
        docId: p.docId,
        amount: p.amount,
      })),
      unallocated,
      journalId: journal.id,
      newBalance: supplierBalance(ctx, supplier.id),
    };
  });
}

export interface PaymentQuery {
  from?: string;
  to?: string;
  partyType?: 'customer' | 'supplier';
  partyId?: string;
  direction?: 'in' | 'out';
  page?: number;
  pageSize?: number;
}

export function listPayments(
  ctx: Ctx,
  q: PaymentQuery = {},
): { rows: PaymentRow[]; total: number; page: number; pageSize: number; totalPages: number } {
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (q.from) {
    where.push('p.biz_date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('p.biz_date <= ?');
    params.push(q.to);
  }
  if (q.partyType) {
    where.push('p.party_type = ?');
    params.push(q.partyType);
  }
  if (q.partyId) {
    where.push('p.party_id = ?');
    params.push(q.partyId);
  }
  if (q.direction) {
    where.push('p.direction = ?');
    params.push(q.direction);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = ctx.db.sum(`SELECT COUNT(*) AS v FROM payments p ${whereSql}`, params);
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(Math.max(1, q.pageSize ?? 50), 500);
  const rows = ctx.db.all<PaymentRow>(
    `SELECT p.* FROM payments p ${whereSql} ORDER BY p.at DESC, p.rowid DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function getPayment(ctx: Ctx, id: string): PaymentRow {
  const row = ctx.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', [id]);
  if (!row) throw new NotFoundError('Payment not found', 'পেমেন্ট পাওয়া যায়নি।');
  return row;
}

export function paymentAllocations(
  ctx: Ctx,
  paymentId: string,
): Array<{ docType: string; docId: string; amount: number; docNo: string | null }> {
  return ctx.db.all<{ docType: string; docId: string; amount: number; docNo: string | null }>(
    `SELECT pa.doc_type AS docType, pa.doc_id AS docId, pa.amount,
            CASE pa.doc_type
              WHEN 'sales_invoice' THEN (SELECT invoice_no FROM sales_invoices WHERE id = pa.doc_id)
              WHEN 'purchase' THEN (SELECT purchase_no FROM purchases WHERE id = pa.doc_id)
            END AS docNo
       FROM payment_allocations pa
      WHERE pa.payment_id = ?`,
    [paymentId],
  );
}
