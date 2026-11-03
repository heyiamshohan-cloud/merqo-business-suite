/**
 * Receipt model + evaluation/licence enforcement tests.
 *
 * These cover the two pieces of logic the Electron layer relies on but which do
 * not need Electron to run: building a receipt from a persisted invoice, and the
 * read-only policy once the evaluation window has expired.
 */
import { describe, expect, it } from 'vitest';
import { makeHarness, seedFixtures } from './helpers';
import { createSale } from '../src/core/sales/sales';
import { receiveFromCustomer } from '../src/core/payments/payments';
import { buildExpenseReceipt, buildInvoiceReceipt, buildPaymentReceipt } from '../src/core/printing/receiptModel';
import { renderReceiptHtml, renderReceiptText } from '../src/core/printing/receipt';
import {
  EVALUATION_DAYS,
  EVAL_STARTED_KEY,
  assertOperatingAllowed,
  evaluationState,
  startEvaluationIfNeeded,
} from '../src/core/licensing/enforcement';
import type { LicenseStatus } from '../src/core/licensing/license';
import { setSetting } from '../src/core/services/settings';

const unlicensed: LicenseStatus = {
  activated: false,
  valid: false,
  organization: null,
  licenseId: null,
  type: null,
  expiresAt: null,
  activatedAt: null,
  deviceHash: null,
  errors: [],
  errorsBn: [],
};

const licensed: LicenseStatus = {
  ...unlicensed,
  activated: true,
  valid: true,
  organization: 'Karim Traders',
  licenseId: 'MERQO-2026-ABCD1234',
  type: 'lifetime',
};

describe('receipt model', () => {
  it('builds a receipt that agrees with the stored invoice', async () => {
    const h = await makeHarness();
    const { product, customer } = seedFixtures(h.ctx);
    const sale = createSale(h.ctx, {
      customerId: customer.id,
      lines: [{ productId: product.id, qty: '2', unitPrice: 100000 }],
      payments: [{ method: 'cash', amount: 150000 }],
    });

    const receipt = buildInvoiceReceipt(h.ctx, sale.invoiceId);
    expect(receipt.number).toBe(sale.invoiceNo);
    expect(receipt.lines).toHaveLength(1);
    expect(receipt.lines[0].qty).toBe(2000);
    expect(receipt.lines[0].lineTotal).toBe(sale.lines[0].lineTotal);
    expect(receipt.total).toBe(sale.total);
    expect(receipt.paid).toBe(150000);
    expect(receipt.due).toBe(sale.total - 150000);
    expect(receipt.payments[0]).toMatchObject({ method: 'Cash', amount: 150000 });
    expect(receipt.counterparty?.name).toBe('Karim Traders');

    const htmlBn = renderReceiptHtml(receipt, { lang: 'bn' });
    expect(htmlBn).toContain('বিক্রয় ইনভয়েস');
    expect(htmlBn).toContain('গ্রাহক');
    expect(htmlBn).toContain(sale.invoiceNo);
    expect(htmlBn).toContain('৳');

    const htmlEn = renderReceiptHtml(receipt, { lang: 'en' });
    expect(htmlEn).toContain('Sales Invoice');

    const text = renderReceiptText(receipt).join('\n');
    expect(text).toContain(sale.invoiceNo);
    expect(text).toContain('Karim Traders');
    h.close();
  });

  it('produces a payment receipt with the party and method', async () => {
    const h = await makeHarness();
    const { product, customer } = seedFixtures(h.ctx);
    const sale = createSale(h.ctx, {
      customerId: customer.id,
      lines: [{ productId: product.id, qty: '1' }],
      payments: [],
    });
    const payment = receiveFromCustomer(h.ctx, {
      customerId: customer.id,
      amount: 50000,
      method: 'bkash',
    });
    expect(sale.due).toBeGreaterThan(0);

    const receipt = buildPaymentReceipt(h.ctx, payment.paymentId);
    expect(receipt.number).toBe(payment.receiptNo);
    expect(receipt.counterparty?.name).toBe('Karim Traders');
    expect(receipt.payments[0]).toMatchObject({ method: 'bKash', methodBn: 'বিকাশ', amount: 50000 });
    expect(receipt.total).toBe(50000);
    h.close();
  });

  it('renders an expense voucher', async () => {
    const h = await makeHarness();
    seedFixtures(h.ctx);
    const categories = h.db.all<{ id: string }>('SELECT id FROM expense_categories ORDER BY name LIMIT 1');
    const { createExpense } = await import('../src/core/expenses/expenses');
    const expense = createExpense(h.ctx, {
      categoryId: categories[0].id,
      amount: 250000,
      method: 'cash',
      payee: 'Landlord',
    });
    const receipt = buildExpenseReceipt(h.ctx, expense.expenseId);
    expect(receipt.number).toBe(expense.voucherNo);
    expect(receipt.total).toBe(250000);
    expect(receipt.counterparty?.name).toBe('Landlord');
    h.close();
  });
});

describe('evaluation policy', () => {
  it('starts a 14-day evaluation on first run and is idempotent', async () => {
    const h = await makeHarness();
    startEvaluationIfNeeded(h.ctx, unlicensed);
    const started = h.ctx.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'license.eval_started_at'",
    );
    expect(started?.value).toBe(h.clock.nowIso());

    const state = evaluationState(h.ctx, unlicensed);
    expect(state.mode).toBe('evaluation');
    expect(state.daysLeft).toBe(EVALUATION_DAYS);

    // A second call must not restart the clock.
    h.clock.advanceMinutes(60 * 24 * 3);
    startEvaluationIfNeeded(h.ctx, unlicensed);
    expect(evaluationState(h.ctx, unlicensed).daysLeft).toBe(EVALUATION_DAYS - 3);
    h.close();
  });

  it('expires after 14 days and blocks writes but not reads', async () => {
    const h = await makeHarness();
    startEvaluationIfNeeded(h.ctx, unlicensed);
    h.clock.advanceMinutes(60 * 24 * (EVALUATION_DAYS + 1));

    const state = evaluationState(h.ctx, unlicensed);
    expect(state.mode).toBe('expired');
    expect(() => assertOperatingAllowed(h.ctx, unlicensed)).toThrowError(/evaluation period has ended/i);

    // Reading the books still works while expired.
    const products = h.db.all('SELECT id FROM products');
    expect(Array.isArray(products)).toBe(true);

    // Posting is still possible at the service layer — enforcement lives at the
    // IPC boundary — so the guard, not the database, is the policy point.
    expect(products.length).toBe(0);
    h.close();
  });

  it('never expires while a valid licence is active', async () => {
    const h = await makeHarness();
    setSetting(h.db, EVAL_STARTED_KEY, '2020-01-01T00:00:00.000Z', h.clock.nowIso());
    const state = evaluationState(h.ctx, licensed);
    expect(state.mode).toBe('licensed');
    expect(() => assertOperatingAllowed(h.ctx, licensed)).not.toThrow();
    h.close();
  });

  it('reports a full window when no evaluation clock exists yet', async () => {
    const h = await makeHarness();
    const state = evaluationState(h.ctx, unlicensed);
    expect(state).toMatchObject({ mode: 'evaluation', daysLeft: EVALUATION_DAYS, startedAt: null });
    h.close();
  });
});
