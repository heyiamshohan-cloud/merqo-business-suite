/**
 * Builds receipt models from persisted documents.
 * Kept in the core so the same receipt content is used for preview, printing,
 * PDF export and thermal output — and can be asserted by tests.
 */
import type { Ctx } from '../kernel';
import { getInvoice } from '../sales/sales';
import { getBusinessProfile, getNumberSetting, getBoolSetting } from '../services/settings';
import { PAYMENT_METHODS } from '../accounting/accounts';
import type { ReceiptModel } from './receipt';
import { getExpense } from '../expenses/expenses';
import { getPayment } from '../payments/payments';

function methodLabel(method: string): { en: string; bn: string } {
  const found = PAYMENT_METHODS.find((m) => m.key === method);
  return { en: found?.name ?? method, bn: found?.nameBn ?? method };
}

function formatDateTime(ctx: Ctx, iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Bangladesh local time (UTC+6) — matches the business-day boundary.
  const local = new Date(date.getTime() + 6 * 3_600_000);
  return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}/${local.getUTCFullYear()} ${pad(
    local.getUTCHours(),
  )}:${pad(local.getUTCMinutes())}`;
}

export function buildInvoiceReceipt(ctx: Ctx, invoiceId: string): ReceiptModel {
  const detail = getInvoice(ctx, invoiceId);
  const business = getBusinessProfile(ctx.db);
  const invoice = detail.invoice;

  const payments = detail.payments.map((p) => {
    const label = methodLabel(p.method);
    return { method: label.en, methodBn: label.bn, amount: p.amount };
  });

  return {
    docType: 'sales_invoice',
    title: 'Sales Invoice',
    titleBn: 'বিক্রয় ইনভয়েস',
    number: invoice.invoice_no,
    dateTime: formatDateTime(ctx, invoice.at),
    business,
    counterparty: invoice.customer_id
      ? {
          label: 'Customer',
          labelBn: 'গ্রাহক',
          name: invoice.customer_name ?? '',
          phone: invoice.customer_phone ?? null,
        }
      : null,
    lines: detail.lines.map((l) => ({
      name: l.name_snapshot,
      nameBn: null,
      qty: l.qty,
      unitPrice: l.unit_price,
      discount: l.discount,
      tax: l.tax,
      lineTotal: l.line_total,
    })),
    subtotal: invoice.gross_total,
    itemDiscount: invoice.item_discount,
    invoiceDiscount: invoice.invoice_discount,
    tax: invoice.tax_total,
    total: invoice.total,
    paid: invoice.paid,
    due: invoice.due,
    payments,
    footer: business.invoiceFooter,
    note: invoice.note,
    paperWidthMm: (getNumberSetting(ctx.db, 'printing.paper_width_mm', 80) === 58 ? 58 : 80),
    showLogo: getBoolSetting(ctx.db, 'invoice.show_logo'),
  };
}

export function buildPaymentReceipt(ctx: Ctx, paymentId: string): ReceiptModel {
  const payment = getPayment(ctx, paymentId);
  const business = getBusinessProfile(ctx.db);
  const label = methodLabel(payment.method);
  const partyName =
    ctx.db.get<{ name: string; phone: string | null }>(
      payment.party_type === 'customer'
        ? 'SELECT name, phone FROM customers WHERE id = ?'
        : 'SELECT name, phone FROM suppliers WHERE id = ?',
      [payment.party_id],
    ) ?? null;

  return {
    docType: payment.direction === 'in' ? 'customer_receipt' : 'supplier_payment',
    title: payment.direction === 'in' ? 'Payment Receipt' : 'Supplier Payment',
    titleBn: payment.direction === 'in' ? 'পেমেন্ট রশিদ' : 'সরবরাহকারী পরিশোধ',
    number: payment.receipt_no,
    dateTime: formatDateTime(ctx, payment.at),
    business,
    counterparty: partyName
      ? {
          label: payment.party_type === 'customer' ? 'Customer' : 'Supplier',
          labelBn: payment.party_type === 'customer' ? 'গ্রাহক' : 'সরবরাহকারী',
          name: partyName.name,
          phone: partyName.phone,
        }
      : null,
    lines: [],
    subtotal: 0,
    itemDiscount: 0,
    invoiceDiscount: 0,
    tax: 0,
    total: payment.amount,
    paid: payment.amount,
    due: 0,
    payments: [{ method: label.en, methodBn: label.bn, amount: payment.amount }],
    footer: business.invoiceFooter,
    note: payment.note,
    paperWidthMm: (getNumberSetting(ctx.db, 'printing.paper_width_mm', 80) === 58 ? 58 : 80),
    showLogo: getBoolSetting(ctx.db, 'invoice.show_logo'),
  };
}

export function buildExpenseReceipt(ctx: Ctx, expenseId: string): ReceiptModel {
  const expense = getExpense(ctx, expenseId);
  const business = getBusinessProfile(ctx.db);
  const label = methodLabel(expense.method);
  return {
    docType: 'expense',
    title: 'Expense Voucher',
    titleBn: 'খরচ ভাউচার',
    number: expense.voucher_no,
    dateTime: formatDateTime(ctx, expense.at),
    business,
    counterparty: expense.payee
      ? { label: 'Payee', labelBn: 'প্রাপক', name: expense.payee }
      : null,
    lines: [
      {
        name: expense.category_name ?? 'Expense',
        qty: 1000,
        unitPrice: expense.amount,
        discount: 0,
        tax: 0,
        lineTotal: expense.amount,
      },
    ],
    subtotal: expense.amount,
    itemDiscount: 0,
    invoiceDiscount: 0,
    tax: 0,
    total: expense.amount,
    paid: expense.amount,
    due: 0,
    payments: [{ method: label.en, methodBn: label.bn, amount: expense.amount }],
    footer: business.invoiceFooter,
    note: expense.note,
    paperWidthMm: 80,
    showLogo: false,
  };
}
