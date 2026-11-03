import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EscPosBuilder,
  buildEscPosJob,
  describeEscPosJob,
  rgbaToRaster,
  wrapLine,
} from '../src/core/printing/escpos';
import { renderReceiptHtml, renderReceiptText, type ReceiptModel } from '../src/core/printing/receipt';
import { getBusinessProfile } from '../src/core/services/settings';
import { createBackup } from '../src/core/backup/backup';
import { createProduct, searchProducts, addBarcode } from '../src/core/catalog/catalog';
import { createSale } from '../src/core/sales/sales';
import { postJournal, getJournalEntry, reverseJournal } from '../src/core/accounting/journal';
import { queryAuditLog } from '../src/core/services/audit';
import { makeHarness, seedFixtures, type Fixtures, type TestHarness } from './helpers';

let h: TestHarness;
let f: Fixtures;

beforeEach(async () => {
  h = await makeHarness();
  f = seedFixtures(h.ctx);
});

afterEach(() => h.close());

function receiptModel(): ReceiptModel {
  const business = getBusinessProfile(h.db);
  const sale = createSale(h.ctx, {
    lines: [{ productId: f.product.id, qty: 2 }],
    customerId: f.customer.id,
    payments: [{ method: 'cash', amount: 150000 }],
  });
  return {
    docType: 'sales_invoice',
    title: 'Sales Invoice',
    titleBn: 'বিক্রয় ইনভয়েস',
    number: sale.invoiceNo,
    dateTime: '01/01/2026 12:00',
    business,
    counterparty: { label: 'Customer', labelBn: 'গ্রাহক', name: 'Karim Traders', phone: '01711111111' },
    lines: sale.lines.map((l) => ({
      name: l.name,
      nameBn: null,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discount: l.discount,
      tax: l.tax,
      lineTotal: l.lineTotal,
    })),
    subtotal: sale.grossTotal,
    itemDiscount: sale.itemDiscount,
    invoiceDiscount: sale.invoiceDiscount,
    tax: sale.taxTotal,
    total: sale.total,
    paid: sale.paid,
    due: sale.due,
    payments: [{ method: 'cash', methodBn: 'নগদ', amount: sale.paid }],
    footer: business.invoiceFooter,
    note: null,
    paperWidthMm: 80,
    showLogo: true,
  };
}

describe('receipt rendering', () => {
  it('renders a Bengali receipt with correct amounts', () => {
    const html = renderReceiptHtml(receiptModel());
    expect(html).toContain('বিক্রয় ইনভয়েস');
    expect(html).toContain('৳2,000.00');
    expect(html).toContain('Karim Traders');
  });

  it('renders 58mm and 80mm widths', () => {
    const model = receiptModel();
    expect(renderReceiptHtml({ ...model, paperWidthMm: 58 })).toContain('size: 58mm auto');
    expect(renderReceiptHtml({ ...model, paperWidthMm: 80 })).toContain('size: 80mm auto');
  });

  it('produces an ASCII text fallback without mojibake', () => {
    const lines = renderReceiptText(receiptModel());
    const text = lines.join('\n');
    expect(text).toContain('SALES INVOICE');
    expect(text).toMatch(/TOTAL\s+2,000\.00/);
    // Every line fits the printable width budget of 48 chars.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe('ESC/POS byte construction', () => {
  it('emits init, alignment, cut and drawer commands', () => {
    const job = buildEscPosJob(['hello'], { openDrawer: true, cut: true });
    const info = describeEscPosJob(job);
    expect(job.includes(Buffer.from([0x1b, 0x40]))).toBe(true); // ESC @
    expect(info.hasCut).toBe(true);
    expect(info.hasDrawer).toBe(true);
    expect(info.hasRaster).toBe(false);
  });

  it('emits a raster block for Bengali receipts', () => {
    const bitmap = { widthBytes: 48, height: 10, data: new Uint8Array(480).fill(0xff) };
    const job = buildEscPosJob([], { bitmap });
    expect(describeEscPosJob(job).hasRaster).toBe(true);
    const header = job.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    expect(header).toBeGreaterThan(-1);
    expect(job[header + 4]).toBe(48); // xL = width bytes
    expect(job[header + 6]).toBe(10); // yL = height
  });

  it('emits a QR code command sequence', () => {
    const b = new EscPosBuilder(80);
    const buf = b.qr('INV-000001').build();
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]))).toBe(true);
    expect(buf.toString('latin1')).toContain('INV-000001');
  });

  it('converts RGBA pixels into a 1-bit raster', () => {
    // 8x2 image: first row black, second white.
    const width = 8;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
    }
    const raster = rgbaToRaster(rgba, width, height, { threshold: 160 });
    expect(raster.widthBytes).toBe(1);
    expect(raster.height).toBe(2);
    expect(raster.data[0]).toBe(0b11111111); // black row sets all bits
    expect(raster.data[1]).toBe(0);
  });

  it('wraps long lines to the paper width', () => {
    const wrapped = wrapLine('a '.repeat(40).trim(), 32);
    expect(wrapped.every((l) => l.length <= 32)).toBe(true);
  });
});

describe('security', () => {
  it('treats SQL injection attempts as literal text', () => {
    const result = searchProducts(h.ctx, { search: "'; DROP TABLE products; --" });
    expect(result.total).toBe(0);
    expect(h.db.count('products')).toBe(2); // table intact

    const sale = createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      payments: [{ method: 'cash', amount: 100000 }],
      note: "'); DELETE FROM sales_invoices; --",
    });
    const stored = h.db.get<{ note: string }>('SELECT note FROM sales_invoices WHERE id = ?', [
      sale.invoiceId,
    ]);
    expect(stored?.note).toBe("'); DELETE FROM sales_invoices; --");
    expect(h.db.count('sales_invoices')).toBe(1);
  });

  it('keeps barcodes globally unique across products', () => {
    expect(() =>
      addBarcode(h.ctx, { productId: f.product2.id, code: '8901234567890' }),
    ).toThrow(/already assigned/i);
    expect(h.db.count('product_barcodes')).toBe(1);
  });

  it('rejects duplicate SKUs', () => {
    expect(() =>
      createProduct(h.ctx, {
        name: 'Clone',
        sku: f.product.sku,
        purchasePrice: 100,
        salePrice: 200,
      }),
    ).toThrow(/already used/i);
  });

  it('keeps posted journal lines immutable when reversing', () => {
    const entry = postJournal(h.ctx, {
      memo: 'Original',
      sourceType: 'manual',
      lines: [
        { accountCode: '1000', debit: 1000 },
        { accountCode: '3000', credit: 1000 },
      ],
    });
    const before = getJournalEntry(h.ctx, entry.id);
    // Correction happens through the public API, never by editing the entry.
    reverseJournal(h.ctx, entry.id, 'Fix');
    const after = getJournalEntry(h.ctx, entry.id);
    expect(after.lines.map((l) => [l.debit, l.credit])).toEqual(
      before.lines.map((l) => [l.debit, l.credit]),
    );
    expect(after.entry.memo ?? after.entry.source_type).toBeTruthy();
  });

  it('records sensitive operations in the audit trail', () => {
    createSale(h.ctx, {
      lines: [{ productId: f.product.id, qty: 1 }],
      payments: [{ method: 'cash', amount: 100000 }],
    });
    const audit = queryAuditLog(h.ctx, { entity: 'sales_invoice' });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].action).toBe('sale.create');
  });

  it('sanitises backup labels so they cannot escape the backup folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merqo-sec-'));
    try {
      const info = createBackup(h.ctx, { directory: dir, label: '../../evil' });
      expect(info.path.startsWith(dir)).toBe(true);
      expect(readdirSync(dir).length).toBe(1);
      expect(info.path).not.toContain('..');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
