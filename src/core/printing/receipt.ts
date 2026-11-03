/**
 * Receipt model + HTML renderer.
 *
 * The same model feeds three outputs:
 *   1. on-screen preview and the print dialog (HTML),
 *   2. PDF export (Electron `printToPDF` on the HTML),
 *   3. thermal ESC/POS output — where Bengali text is rasterised from this
 *      HTML so that যুক্তাক্ষর, কার and ফলা render correctly on printers whose
 *      firmware has no Bengali character set.
 */
import { formatPaisa, formatQty } from '../foundation/money';
import type { BusinessProfile } from '../services/settings';

export interface ReceiptLine {
  name: string;
  nameBn?: string | null;
  qty: number;
  unitPrice: number;
  discount: number;
  tax: number;
  lineTotal: number;
}

export interface ReceiptPayment {
  method: string;
  methodBn: string;
  amount: number;
}

export interface ReceiptModel {
  docType: 'sales_invoice' | 'sales_return' | 'customer_receipt' | 'supplier_payment' | 'purchase' | 'expense';
  title: string;
  titleBn: string;
  number: string;
  dateTime: string;
  business: BusinessProfile;
  counterparty: { label: string; labelBn: string; name: string; phone?: string | null; address?: string | null } | null;
  lines: ReceiptLine[];
  subtotal: number;
  itemDiscount: number;
  invoiceDiscount: number;
  tax: number;
  total: number;
  paid: number;
  due: number;
  payments: ReceiptPayment[];
  footer: string;
  note?: string | null;
  paperWidthMm: number;
  showLogo: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReceiptHtml(model: ReceiptModel, opts: { lang?: 'bn' | 'en' } = {}): string {
  const lang = opts.lang ?? 'bn';
  const width = model.paperWidthMm === 58 ? 58 : 80;
  const heading = lang === 'bn' ? model.titleBn : model.title;
  const rows = model.lines
    .map(
      (l) => `
      <tr>
        <td class="item">
          <div class="name">${escapeHtml(l.name)}</div>
          <div class="sub">${formatQty(l.qty)} × ${formatPaisa(l.unitPrice)}${
            l.discount > 0 ? ` − ${formatPaisa(l.discount)}` : ''
          }</div>
        </td>
        <td class="amt">${formatPaisa(l.lineTotal)}</td>
      </tr>`,
    )
    .join('');

  const payments = model.payments
    .map(
      (p) =>
        `<div class="row"><span>${escapeHtml(lang === 'bn' ? p.methodBn : p.method)}</span><span>${formatPaisa(
          p.amount,
        )}</span></div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<style>
  @page { size: ${width}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    width: ${width}mm;
    padding: 3mm 3mm 4mm;
    font-family: 'Noto Sans Bengali', 'Nirmala UI', 'SolaimanLipi', 'Segoe UI', sans-serif;
    color: #000; font-size: ${width === 58 ? '9px' : '11px'}; line-height: 1.35;
  }
  .center { text-align: center; }
  .biz { font-size: ${width === 58 ? '12px' : '15px'}; font-weight: 700; margin-bottom: 1mm; }
  .meta { font-size: ${width === 58 ? '8px' : '9.5px'}; }
  .rule { border-top: 1px dashed #000; margin: 2mm 0; }
  .title { font-weight: 700; text-align: center; text-transform: uppercase; letter-spacing: .4px; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 0.6mm 0; }
  td.amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 32%; }
  .name { font-weight: 600; }
  .sub { font-size: ${width === 58 ? '8px' : '9px'}; color: #333; }
  .row { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
  .row.total { font-weight: 700; font-size: ${width === 58 ? '11px' : '13px'}; }
  .footer { margin-top: 2mm; text-align: center; font-size: ${width === 58 ? '8px' : '9.5px'}; }
  .qr { margin-top: 2mm; text-align: center; }
</style>
</head>
<body>
  ${model.showLogo ? `<div class="center biz">${escapeHtml(model.business.nameBn || model.business.name)}</div>` : ''}
  ${model.showLogo ? '' : `<div class="center biz">${escapeHtml(model.business.name)}</div>`}
  <div class="center meta">
    ${model.business.address ? escapeHtml(model.business.address) + '<br/>' : ''}
    ${model.business.phone ? 'মোবাইল: ' + escapeHtml(model.business.phone) + '<br/>' : ''}
    ${model.business.vatRegNo ? 'VAT: ' + escapeHtml(model.business.vatRegNo) : ''}
  </div>
  <div class="rule"></div>
  <div class="title">${escapeHtml(heading)}</div>
  <div class="row meta"><span>${escapeHtml(lang === 'bn' ? 'নং' : 'No')}: ${escapeHtml(model.number)}</span><span>${escapeHtml(
    model.dateTime,
  )}</span></div>
  ${
    model.counterparty
      ? `<div class="meta">${escapeHtml(
          lang === 'bn' ? model.counterparty.labelBn : model.counterparty.label,
        )}: ${escapeHtml(model.counterparty.name)}${
          model.counterparty.phone ? ` · ${escapeHtml(model.counterparty.phone)}` : ''
        }</div>`
      : ''
  }
  <div class="rule"></div>
  <table>${rows}</table>
  <div class="rule"></div>
  <div class="row"><span>${lang === 'bn' ? 'সাবটোটাল' : 'Subtotal'}</span><span>${formatPaisa(
    model.subtotal,
  )}</span></div>
  ${
    model.itemDiscount + model.invoiceDiscount > 0
      ? `<div class="row"><span>${lang === 'bn' ? 'ছাড়' : 'Discount'}</span><span>−${formatPaisa(
          model.itemDiscount + model.invoiceDiscount,
        )}</span></div>`
      : ''
  }
  ${
    model.tax > 0
      ? `<div class="row"><span>${escapeHtml(model.business.taxLabel)}</span><span>${formatPaisa(
          model.tax,
        )}</span></div>`
      : ''
  }
  <div class="row total"><span>${lang === 'bn' ? 'সর্বমোট' : 'Total'}</span><span>${formatPaisa(
    model.total,
  )}</span></div>
  ${payments}
  ${
    model.due > 0
      ? `<div class="row"><span>${lang === 'bn' ? 'বাকি' : 'Due'}</span><span>${formatPaisa(
          model.due,
        )}</span></div>`
      : ''
  }
  <div class="rule"></div>
  ${model.note ? `<div class="meta">${escapeHtml(model.note)}</div>` : ''}
  <div class="footer">${escapeHtml(model.footer)}</div>
  <div class="footer meta">MERQO · ${escapeHtml(model.business.phone || '')}</div>
</body>
</html>`;
}

/** Plain-text representation used for the ESC/POS fallback (ASCII-safe). */
export function renderReceiptText(model: ReceiptModel): string[] {
  const lines: string[] = [];
  const width = model.paperWidthMm === 58 ? 32 : 48;
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((width - s.length) / 2));
    return ' '.repeat(pad) + s;
  };
  const twoCol = (left: string, right: string) => {
    const space = Math.max(1, width - left.length - right.length);
    return left + ' '.repeat(space) + right;
  };
  lines.push(center(model.business.name));
  if (model.business.address) lines.push(center(model.business.address));
  lines.push('-'.repeat(width));
  lines.push(center(model.title.toUpperCase()));
  lines.push(twoCol(model.number, model.dateTime));
  if (model.counterparty) lines.push(model.counterparty.name);
  lines.push('-'.repeat(width));
  for (const l of model.lines) {
    lines.push(l.name);
    lines.push(
      twoCol(
        `  ${formatQty(l.qty)} x ${formatPaisa(l.unitPrice, { symbol: false })}`,
        formatPaisa(l.lineTotal, { symbol: false }),
      ),
    );
  }
  lines.push('-'.repeat(width));
  lines.push(twoCol('Subtotal', formatPaisa(model.subtotal, { symbol: false })));
  if (model.itemDiscount + model.invoiceDiscount > 0) {
    lines.push(
      twoCol('Discount', '-' + formatPaisa(model.itemDiscount + model.invoiceDiscount, { symbol: false })),
    );
  }
  if (model.tax > 0) lines.push(twoCol(model.business.taxLabel, formatPaisa(model.tax, { symbol: false })));
  lines.push(twoCol('TOTAL', formatPaisa(model.total, { symbol: false })));
  for (const p of model.payments) lines.push(twoCol(p.method, formatPaisa(p.amount, { symbol: false })));
  if (model.due > 0) lines.push(twoCol('Due', formatPaisa(model.due, { symbol: false })));
  lines.push('-'.repeat(width));
  lines.push(center(model.footer));
  return lines;
}
