/**
 * Reporting engine.
 *
 * Every report is produced as a `ReportTable` (title, typed columns, rows,
 * totals) so the same structure can be rendered on screen, printed, exported to
 * CSV/Excel or converted to PDF without duplicating logic.
 *
 * Reports read from the operational tables for business detail and from the
 * journal for anything financial — the accounting reports are the authority and
 * the operational reports are reconciled against them by the test suite.
 */
import type { Ctx } from '../kernel';
import { ACC } from '../accounting/accounts';
import {
  accountBalances,
  cashFlow,
  ledger,
  profitAndLoss,
  trialBalance,
  type DateWindow,
} from '../accounting/reports';
import { customerBalance, supplierBalance } from '../parties/parties';
import { lowStock, outOfStock, stockMoves, stockValuation } from '../inventory/stock';

export type ColumnType = 'text' | 'money' | 'qty' | 'date' | 'int' | 'percent';

export interface ReportColumn {
  key: string;
  label: string;
  labelBn: string;
  type: ColumnType;
  align?: 'left' | 'right' | 'center';
  width?: number;
}

export interface ReportTable {
  key: string;
  title: string;
  titleBn: string;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  totals?: Record<string, string | number | null>;
  meta?: Record<string, string | number | boolean | null>;
}

export interface RangeQuery {
  from: string;
  to: string;
}

const col = (
  key: string,
  label: string,
  labelBn: string,
  type: ColumnType = 'text',
  align?: 'left' | 'right' | 'center',
): ReportColumn => ({
  key,
  label,
  labelBn,
  type,
  align: align ?? (type === 'money' || type === 'qty' || type === 'int' ? 'right' : 'left'),
});

function table(
  key: string,
  title: string,
  titleBn: string,
  columns: ReportColumn[],
  rows: Array<Record<string, string | number | null>>,
  totals?: Record<string, string | number | null>,
  meta?: ReportTable['meta'],
): ReportTable {
  return { key, title, titleBn, columns, rows, totals, meta };
}

// ---------------------------------------------------------------------------
// Sales reports
// ---------------------------------------------------------------------------
export function reportDailySales(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<{
    biz_date: string;
    invoices: number;
    gross: number;
    discount: number;
    tax: number;
    net: number;
    paid: number;
    due: number;
    cogs: number;
    profit: number;
  }>(
    `SELECT biz_date,
            COUNT(*) AS invoices,
            COALESCE(SUM(gross_total),0) AS gross,
            COALESCE(SUM(item_discount + invoice_discount),0) AS discount,
            COALESCE(SUM(tax_total),0) AS tax,
            COALESCE(SUM(total),0) AS net,
            COALESCE(SUM(paid),0) AS paid,
            COALESCE(SUM(due),0) AS due,
            COALESCE(SUM(cogs),0) AS cogs,
            COALESCE(SUM(profit),0) AS profit
       FROM sales_invoices
      WHERE status = 'completed' AND biz_date >= ? AND biz_date <= ?
      GROUP BY biz_date ORDER BY biz_date`,
    [q.from, q.to],
  );
  const t = rows.reduce(
    (a, r) => ({
      invoices: a.invoices + r.invoices,
      gross: a.gross + r.gross,
      discount: a.discount + r.discount,
      tax: a.tax + r.tax,
      net: a.net + r.net,
      paid: a.paid + r.paid,
      due: a.due + r.due,
      cogs: a.cogs + r.cogs,
      profit: a.profit + r.profit,
    }),
    { invoices: 0, gross: 0, discount: 0, tax: 0, net: 0, paid: 0, due: 0, cogs: 0, profit: 0 },
  );
  return table(
    'daily-sales',
    'Daily Sales Report',
    'দৈনিক বিক্রয় রিপোর্ট',
    [
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('invoices', 'Invoices', 'ইনভয়েস', 'int'),
      col('gross', 'Gross', 'মোট বিক্রয়', 'money'),
      col('discount', 'Discount', 'ছাড়', 'money'),
      col('tax', 'VAT', 'ভ্যাট', 'money'),
      col('net', 'Net Total', 'নিট মোট', 'money'),
      col('paid', 'Received', 'আদায়', 'money'),
      col('due', 'Due', 'বাকি', 'money'),
      col('profit', 'Gross Profit', 'মোট মুনাফা', 'money'),
    ],
    rows,
    { ...t },
    { from: q.from, to: q.to },
  );
}

export function reportSalesByInvoice(
  ctx: Ctx,
  q: RangeQuery & { customerId?: string; search?: string },
): ReportTable {
  const where = ["i.status = 'completed'", 'i.biz_date >= ?', 'i.biz_date <= ?'];
  const params: Array<string | number> = [q.from, q.to];
  if (q.customerId) {
    where.push('i.customer_id = ?');
    params.push(q.customerId);
  }
  if (q.search) {
    where.push("(LOWER(i.invoice_no) LIKE ? OR LOWER(COALESCE(c.name,'')) LIKE ?)");
    params.push(`%${q.search.toLowerCase()}%`, `%${q.search.toLowerCase()}%`);
  }
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT i.invoice_no AS invoice_no, i.biz_date AS biz_date,
            COALESCE(c.name, 'Walk-in') AS customer,
            i.total AS total, i.paid AS paid, i.due AS due,
            i.cogs AS cogs, i.profit AS profit, i.payment_method AS method
       FROM sales_invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.biz_date, i.invoice_no`,
    params,
  );
  const totals = sumKeys(rows, ['total', 'paid', 'due', 'cogs', 'profit']);
  return table(
    'sales-by-invoice',
    'Sales Register',
    'বিক্রয় রেজিস্টার',
    [
      col('invoice_no', 'Invoice', 'ইনভয়েস'),
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('customer', 'Customer', 'গ্রাহক'),
      col('total', 'Total', 'মোট', 'money'),
      col('paid', 'Paid', 'পরিশোধিত', 'money'),
      col('due', 'Due', 'বাকি', 'money'),
      col('cogs', 'Cost', 'ক্রয়মূল্য', 'money'),
      col('profit', 'Profit', 'মুনাফা', 'money'),
    ],
    rows,
    totals,
    { from: q.from, to: q.to },
  );
}

export function reportSalesByProduct(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT p.name AS product, p.sku AS sku,
            SUM(sl.qty) AS qty,
            SUM(sl.line_total) AS amount,
            SUM(sl.cogs) AS cogs,
            SUM(sl.line_total - sl.tax - sl.cogs) AS profit
       FROM sale_lines sl
       JOIN sales_invoices i ON i.id = sl.invoice_id
       JOIN products p ON p.id = sl.product_id
      WHERE i.status = 'completed' AND i.biz_date >= ? AND i.biz_date <= ?
      GROUP BY sl.product_id
      ORDER BY amount DESC`,
    [q.from, q.to],
  );
  return table(
    'sales-by-product',
    'Product-wise Sales',
    'পণ্যভিত্তিক বিক্রয়',
    [
      col('product', 'Product', 'পণ্য'),
      col('sku', 'SKU', 'এসকেইউ'),
      col('qty', 'Qty', 'পরিমাণ', 'qty'),
      col('amount', 'Sales', 'বিক্রয়', 'money'),
      col('cogs', 'Cost', 'ক্রয়মূল্য', 'money'),
      col('profit', 'Profit', 'মুনাফা', 'money'),
    ],
    rows,
    sumKeys(rows, ['qty', 'amount', 'cogs', 'profit']),
    { from: q.from, to: q.to },
  );
}

export function reportSalesByCategory(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT COALESCE(c.name, 'Uncategorised') AS category,
            SUM(sl.qty) AS qty,
            SUM(sl.line_total) AS amount,
            SUM(sl.cogs) AS cogs
       FROM sale_lines sl
       JOIN sales_invoices i ON i.id = sl.invoice_id
       JOIN products p ON p.id = sl.product_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE i.status = 'completed' AND i.biz_date >= ? AND i.biz_date <= ?
      GROUP BY p.category_id ORDER BY amount DESC`,
    [q.from, q.to],
  );
  return table(
    'sales-by-category',
    'Category-wise Sales',
    'ক্যাটাগরিভিত্তিক বিক্রয়',
    [
      col('category', 'Category', 'ক্যাটাগরি'),
      col('qty', 'Qty', 'পরিমাণ', 'qty'),
      col('amount', 'Sales', 'বিক্রয়', 'money'),
      col('cogs', 'Cost', 'ক্রয়মূল্য', 'money'),
    ],
    rows,
    sumKeys(rows, ['qty', 'amount', 'cogs']),
    { from: q.from, to: q.to },
  );
}

export function reportBestSelling(ctx: Ctx, q: RangeQuery, limit = 20): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT p.name AS product, SUM(sl.qty) AS qty, SUM(sl.line_total) AS amount
       FROM sale_lines sl
       JOIN sales_invoices i ON i.id = sl.invoice_id
       JOIN products p ON p.id = sl.product_id
      WHERE i.status = 'completed' AND i.biz_date >= ? AND i.biz_date <= ?
      GROUP BY sl.product_id ORDER BY qty DESC LIMIT ?`,
    [q.from, q.to, limit],
  );
  return table(
    'best-selling',
    'Best Selling Products',
    'সর্বাধিক বিক্রীত পণ্য',
    [
      col('product', 'Product', 'পণ্য'),
      col('qty', 'Qty Sold', 'বিক্রীত পরিমাণ', 'qty'),
      col('amount', 'Sales Value', 'বিক্রয় মূল্য', 'money'),
    ],
    rows,
    undefined,
    { from: q.from, to: q.to, limit },
  );
}

export function reportPaymentHistory(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT p.biz_date AS biz_date, p.receipt_no AS receipt_no,
            CASE p.direction WHEN 'in' THEN 'Received' ELSE 'Paid' END AS direction,
            COALESCE(c.name, s.name, '') AS party,
            p.method AS method, p.amount AS amount
       FROM payments p
       LEFT JOIN customers c ON c.id = p.party_id AND p.party_type = 'customer'
       LEFT JOIN suppliers s ON s.id = p.party_id AND p.party_type = 'supplier'
      WHERE p.biz_date >= ? AND p.biz_date <= ?
      ORDER BY p.at DESC`,
    [q.from, q.to],
  );
  const received = rows
    .filter((r) => r.direction === 'Received')
    .reduce((a, r) => a + Number(r.amount ?? 0), 0);
  const paid = rows
    .filter((r) => r.direction === 'Paid')
    .reduce((a, r) => a + Number(r.amount ?? 0), 0);
  return table(
    'payment-history',
    'Payment History',
    'পেমেন্ট ইতিহাস',
    [
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('receipt_no', 'Receipt', 'রশিদ'),
      col('direction', 'Direction', 'ধরন'),
      col('party', 'Party', 'পক্ষ'),
      col('method', 'Method', 'মাধ্যম'),
      col('amount', 'Amount', 'টাকা', 'money'),
    ],
    rows,
    { received, paid },
    { from: q.from, to: q.to },
  );
}

export function reportSalesReturns(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT r.return_no AS return_no, r.biz_date AS biz_date, i.invoice_no AS invoice,
            COALESCE(c.name, 'Walk-in') AS customer, r.total AS total,
            r.cogs AS cogs, r.restock AS restock, COALESCE(r.reason,'') AS reason
       FROM sales_returns r
       JOIN sales_invoices i ON i.id = r.invoice_id
       LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.biz_date >= ? AND r.biz_date <= ?
      ORDER BY r.biz_date, r.return_no`,
    [q.from, q.to],
  );
  return table(
    'sales-returns',
    'Sales Return Report',
    'বিক্রয় ফেরত রিপোর্ট',
    [
      col('return_no', 'Return', 'ফেরত নং'),
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('invoice', 'Invoice', 'ইনভয়েস'),
      col('customer', 'Customer', 'গ্রাহক'),
      col('total', 'Refund', 'ফেরত টাকা', 'money'),
      col('restock', 'Restock', 'পুনঃস্টক'),
      col('reason', 'Reason', 'কারণ'),
    ],
    rows,
    sumKeys(rows, ['total']),
    { from: q.from, to: q.to },
  );
}

// ---------------------------------------------------------------------------
// Purchase & expense reports
// ---------------------------------------------------------------------------
export function reportPurchases(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT p.purchase_no AS purchase_no, p.biz_date AS biz_date,
            COALESCE(s.name, '—') AS supplier, COALESCE(p.supplier_ref,'') AS ref,
            p.total AS total, p.paid AS paid, p.due AS due
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.status = 'completed' AND p.biz_date >= ? AND p.biz_date <= ?
      ORDER BY p.biz_date, p.purchase_no`,
    [q.from, q.to],
  );
  return table(
    'purchases',
    'Purchase Report',
    'ক্রয় রিপোর্ট',
    [
      col('purchase_no', 'Purchase', 'ক্রয় নং'),
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('supplier', 'Supplier', 'সরবরাহকারী'),
      col('ref', 'Supplier Ref', 'সরবরাহকারী রেফ'),
      col('total', 'Total', 'মোট', 'money'),
      col('paid', 'Paid', 'পরিশোধিত', 'money'),
      col('due', 'Due', 'বাকি', 'money'),
    ],
    rows,
    sumKeys(rows, ['total', 'paid', 'due']),
    { from: q.from, to: q.to },
  );
}

export function reportPurchaseReturns(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT r.return_no AS return_no, r.biz_date AS biz_date, p.purchase_no AS purchase,
            COALESCE(s.name, '—') AS supplier, r.total AS total, COALESCE(r.reason,'') AS reason
       FROM purchase_returns r
       JOIN purchases p ON p.id = r.purchase_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE r.biz_date >= ? AND r.biz_date <= ?
      ORDER BY r.biz_date, r.return_no`,
    [q.from, q.to],
  );
  return table(
    'purchase-returns',
    'Purchase Return Report',
    'ক্রয় ফেরত রিপোর্ট',
    [
      col('return_no', 'Return', 'ফেরত নং'),
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('purchase', 'Purchase', 'ক্রয় নং'),
      col('supplier', 'Supplier', 'সরবরাহকারী'),
      col('total', 'Value', 'মূল্য', 'money'),
      col('reason', 'Reason', 'কারণ'),
    ],
    rows,
    sumKeys(rows, ['total']),
    { from: q.from, to: q.to },
  );
}

export function reportExpenses(ctx: Ctx, q: RangeQuery): ReportTable {
  const rows = ctx.db.all<Record<string, string | number | null>>(
    `SELECT e.voucher_no AS voucher_no, e.biz_date AS biz_date, ec.name AS category,
            e.method AS method, COALESCE(e.payee,'') AS payee, e.amount AS amount,
            COALESCE(e.note,'') AS note
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
      WHERE e.biz_date >= ? AND e.biz_date <= ? AND e.amount > 0
      ORDER BY e.biz_date, e.voucher_no`,
    [q.from, q.to],
  );
  return table(
    'expenses',
    'Expense Report',
    'খরচ রিপোর্ট',
    [
      col('voucher_no', 'Voucher', 'ভাউচার'),
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('category', 'Category', 'ক্যাটাগরি'),
      col('method', 'Method', 'মাধ্যম'),
      col('payee', 'Payee', 'প্রাপক'),
      col('amount', 'Amount', 'টাকা', 'money'),
      col('note', 'Note', 'মন্তব্য'),
    ],
    rows,
    sumKeys(rows, ['amount']),
    { from: q.from, to: q.to },
  );
}

// ---------------------------------------------------------------------------
// Party reports
// ---------------------------------------------------------------------------
export function reportCustomerDue(ctx: Ctx, q?: RangeQuery): ReportTable {
  const rows = ctx.db.all<{
    id: string;
    name: string;
    code: string;
    phone: string | null;
    balance: number;
    last_invoice: string | null;
  }>(
    `SELECT c.id, c.name, c.code, c.phone,
            (SELECT COALESCE(SUM(jl.debit - jl.credit),0)
               FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
              WHERE jl.party_type = 'customer' AND jl.party_id = c.id AND a.code = ?) AS balance,
            (SELECT MAX(biz_date) FROM sales_invoices WHERE customer_id = c.id) AS last_invoice
       FROM customers c
      WHERE c.status = 'active'
      ORDER BY balance DESC, c.name COLLATE NOCASE`,
    [ACC.AR],
  );
  const filtered = rows.filter((r) => r.balance !== 0);
  return table(
    'customer-due',
    'Customer Due Report',
    'গ্রাহক বাকি রিপোর্ট',
    [
      col('code', 'Code', 'কোড'),
      col('name', 'Customer', 'গ্রাহক'),
      col('phone', 'Mobile', 'মোবাইল'),
      col('last_invoice', 'Last Invoice', 'সর্বশেষ ইনভয়েস', 'date'),
      col('balance', 'Outstanding', 'বাকি', 'money'),
    ],
    filtered,
    { balance: filtered.reduce((a, r) => a + r.balance, 0) },
    q ? { from: q.from, to: q.to } : undefined,
  );
}

export function reportSupplierDue(ctx: Ctx): ReportTable {
  const rows = ctx.db.all<{
    id: string;
    name: string;
    code: string;
    phone: string | null;
    balance: number;
    last_purchase: string | null;
  }>(
    `SELECT s.id, s.name, s.code, s.phone,
            (SELECT COALESCE(SUM(jl.credit - jl.debit),0)
               FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
              WHERE jl.party_type = 'supplier' AND jl.party_id = s.id AND a.code = ?) AS balance,
            (SELECT MAX(biz_date) FROM purchases WHERE supplier_id = s.id) AS last_purchase
       FROM suppliers s WHERE s.status = 'active'
      ORDER BY balance DESC, s.name COLLATE NOCASE`,
    [ACC.AP],
  ).filter((r) => r.balance !== 0);
  return table(
    'supplier-due',
    'Supplier Payable Report',
    'সরবরাহকারী পাওনা রিপোর্ট',
    [
      col('code', 'Code', 'কোড'),
      col('name', 'Supplier', 'সরবরাহকারী'),
      col('phone', 'Mobile', 'মোবাইল'),
      col('last_purchase', 'Last Purchase', 'সর্বশেষ ক্রয়', 'date'),
      col('balance', 'Payable', 'পাওনা', 'money'),
    ],
    rows,
    { balance: rows.reduce((a, r) => a + r.balance, 0) },
  );
}

export function reportCustomerStatement(
  ctx: Ctx,
  customerId: string,
  q: RangeQuery,
): ReportTable {
  const customer = ctx.db.get<{ name: string; code: string; phone: string | null }>(
    'SELECT name, code, phone FROM customers WHERE id = ?',
    [customerId],
  );
  if (!customer) throw new Error('Customer not found');
  const result = ledger(ctx, {
    accountCodes: [ACC.AR],
    partyType: 'customer',
    partyId: customerId,
    from: q.from,
    to: q.to,
  });
  const rows = result.lines.map((l) => ({
    biz_date: l.biz_date,
    memo: l.memo,
    debit: l.debit,
    credit: l.credit,
    balance: l.balance,
  }));
  return table(
    'customer-statement',
    `Customer Statement — ${customer.name}`,
    `গ্রাহক বিবরণী — ${customer.name}`,
    [
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('memo', 'Particulars', 'বিবরণ'),
      col('debit', 'Debit (Sale)', 'ডেবিট (বিক্রয়)', 'money'),
      col('credit', 'Credit (Paid)', 'ক্রেডিট (পরিশোধ)', 'money'),
      col('balance', 'Balance', 'বাকি', 'money'),
    ],
    rows,
    {
      opening: result.openingBalance,
      debit: result.totalDebit,
      credit: result.totalCredit,
      balance: result.closingBalance,
    },
    {
      from: q.from,
      to: q.to,
      customerCode: customer.code,
      customerPhone: customer.phone ?? '',
      outstanding: customerBalance(ctx, customerId),
    },
  );
}

export function reportSupplierStatement(
  ctx: Ctx,
  supplierId: string,
  q: RangeRange,
): ReportTable {
  const supplier = ctx.db.get<{ name: string; code: string; phone: string | null }>(
    'SELECT name, code, phone FROM suppliers WHERE id = ?',
    [supplierId],
  );
  if (!supplier) throw new Error('Supplier not found');
  const result = ledger(ctx, {
    accountCodes: [ACC.AP],
    partyType: 'supplier',
    partyId: supplierId,
    from: q.from,
    to: q.to,
  });
  const rows = result.lines.map((l) => ({
    biz_date: l.biz_date,
    memo: l.memo,
    debit: l.debit,
    credit: l.credit,
    balance: l.balance,
  }));
  return table(
    'supplier-statement',
    `Supplier Statement — ${supplier.name}`,
    `সরবরাহকারী বিবরণী — ${supplier.name}`,
    [
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('memo', 'Particulars', 'বিবরণ'),
      col('debit', 'Debit (Paid)', 'ডেবিট (পরিশোধ)', 'money'),
      col('credit', 'Credit (Purchase)', 'ক্রেডিট (ক্রয়)', 'money'),
      col('balance', 'Balance', 'পাওনা', 'money'),
    ],
    rows,
    {
      opening: result.openingBalance,
      debit: result.totalDebit,
      credit: result.totalCredit,
      balance: result.closingBalance,
    },
    {
      from: q.from,
      to: q.to,
      supplierCode: supplier.code,
      outstanding: supplierBalance(ctx, supplierId),
    },
  );
}

type RangeRange = RangeQuery;

// ---------------------------------------------------------------------------
// Stock reports
// ---------------------------------------------------------------------------
export function reportStock(ctx: Ctx): ReportTable {
  const valuation = stockValuation(ctx);
  const rows = valuation.rows.map((r) => ({
    sku: r.sku,
    product: r.name,
    category: r.category_name ?? '—',
    qty: r.qty,
    unit_cost: r.unit_cost,
    value: r.value,
  }));
  return table(
    'stock',
    'Stock Report',
    'স্টক রিপোর্ট',
    [
      col('sku', 'SKU', 'এসকেইউ'),
      col('product', 'Product', 'পণ্য'),
      col('category', 'Category', 'ক্যাটাগরি'),
      col('qty', 'Qty', 'পরিমাণ', 'qty'),
      col('unit_cost', 'Avg Cost', 'গড় ক্রয়মূল্য', 'money'),
      col('value', 'Value', 'মূল্য', 'money'),
    ],
    rows,
    { value: valuation.totalValue, qty: valuation.totalQty },
  );
}

export function reportLowStock(ctx: Ctx): ReportTable {
  const rows = lowStock(ctx).map((r) => ({
    sku: r.sku,
    product: r.name,
    qty: r.qty,
    min_stock: r.min_stock,
    reorder: r.reorder_qty,
  }));
  return table(
    'low-stock',
    'Low Stock Report',
    'কম স্টক রিপোর্ট',
    [
      col('sku', 'SKU', 'এসকেইউ'),
      col('product', 'Product', 'পণ্য'),
      col('qty', 'On Hand', 'স্টক', 'qty'),
      col('min_stock', 'Minimum', 'সর্বনিম্ন', 'qty'),
      col('reorder', 'To Reorder', 'অর্ডার করতে হবে', 'qty'),
    ],
    rows,
  );
}

export function reportOutOfStock(ctx: Ctx): ReportTable {
  const rows = outOfStock(ctx).map((r) => ({
    sku: r.sku,
    product: r.name,
    min_stock: r.min_stock,
  }));
  return table(
    'out-of-stock',
    'Out of Stock Report',
    'স্টক শেষ রিপোর্ট',
    [
      col('sku', 'SKU', 'এসকেইউ'),
      col('product', 'Product', 'পণ্য'),
      col('min_stock', 'Minimum', 'সর্বনিম্ন', 'qty'),
    ],
    rows,
  );
}

export function reportStockMovement(ctx: Ctx, q: RangeQuery & { productId?: string }): ReportTable {
  const moves = stockMoves(ctx, {
    productId: q.productId,
    from: q.from,
    to: q.to,
    limit: 2000,
  });
  const rows = moves.map((m) => ({
    biz_date: m.biz_date,
    product: m.product_name ?? '',
    movement: m.movement,
    qty: m.qty,
    value: m.value,
    reason: m.reason ?? '',
  }));
  return table(
    'stock-movement',
    'Stock Movement Report',
    'স্টক চলাচল রিপোর্ট',
    [
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('product', 'Product', 'পণ্য'),
      col('movement', 'Movement', 'ধরন'),
      col('qty', 'Qty', 'পরিমাণ', 'qty'),
      col('value', 'Value', 'মূল্য', 'money'),
      col('reason', 'Reason', 'কারণ'),
    ],
    rows,
    { qty: rows.reduce((a, r) => a + Number(r.qty), 0) },
    { from: q.from, to: q.to },
  );
}

export function reportInventoryValuation(ctx: Ctx): ReportTable {
  const valuation = stockValuation(ctx);
  return table(
    'inventory-valuation',
    'Inventory Valuation',
    'স্টক মূল্যায়ন',
    [
      col('sku', 'SKU', 'এসকেইউ'),
      col('product', 'Product', 'পণ্য'),
      col('qty', 'Qty', 'পরিমাণ', 'qty'),
      col('unit_cost', 'Avg Cost', 'গড় ক্রয়মূল্য', 'money'),
      col('value', 'Total Value', 'মোট মূল্য', 'money'),
    ],
    valuation.rows.map((r) => ({
      sku: r.sku,
      product: r.name,
      qty: r.qty,
      unit_cost: r.unit_cost,
      value: r.value,
    })),
    { value: valuation.totalValue },
    { method: 'moving_weighted_average' },
  );
}

// ---------------------------------------------------------------------------
// Accounting reports
// ---------------------------------------------------------------------------
export function reportTrialBalance(ctx: Ctx, q: RangeQuery): ReportTable {
  const tb = trialBalance(ctx, q);
  const rows = tb.rows.map((r) => ({
    code: r.code,
    account: r.name,
    type: r.type,
    debit: r.debit,
    credit: r.credit,
  }));
  return table(
    'trial-balance',
    'Trial Balance',
    'রেওয়ামিল',
    [
      col('code', 'Code', 'কোড'),
      col('account', 'Account', 'হিসাব'),
      col('type', 'Type', 'ধরন'),
      col('debit', 'Debit', 'ডেবিট', 'money'),
      col('credit', 'Credit', 'ক্রেডিট', 'money'),
    ],
    rows,
    { debit: tb.totalDebit, credit: tb.totalCredit },
    { from: q.from, to: q.to, balanced: tb.balanced },
  );
}

export function reportGeneralLedger(ctx: Ctx, q: RangeQuery): ReportTable {
  const result = ledger(ctx, { from: q.from, to: q.to });
  const rows = result.lines.map((l) => ({
    biz_date: l.biz_date,
    account: `${l.account_code} ${l.account_name}`,
    memo: l.memo,
    debit: l.debit,
    credit: l.credit,
  }));
  return table(
    'general-ledger',
    'General Ledger',
    'সাধারণ খতিয়ান',
    [
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('account', 'Account', 'হিসাব'),
      col('memo', 'Particulars', 'বিবরণ'),
      col('debit', 'Debit', 'ডেবিট', 'money'),
      col('credit', 'Credit', 'ক্রেডিট', 'money'),
    ],
    rows,
    { debit: result.totalDebit, credit: result.totalCredit },
    { from: q.from, to: q.to },
  );
}

export function reportAccountLedger(ctx: Ctx, accountCode: string, q: RangeQuery): ReportTable {
  const result = ledger(ctx, { accountCode, from: q.from, to: q.to });
  const account = ctx.db.get<{ name: string; code: string }>(
    'SELECT name, code FROM accounts WHERE code = ?',
    [accountCode],
  );
  const rows = result.lines.map((l) => ({
    biz_date: l.biz_date,
    memo: l.memo,
    debit: l.debit,
    credit: l.credit,
    balance: l.balance,
  }));
  return table(
    'account-ledger',
    `Account Ledger — ${account?.name ?? accountCode}`,
    `হিসাব খতিয়ান — ${account?.name ?? accountCode}`,
    [
      col('biz_date', 'Date', 'তারিখ', 'date'),
      col('memo', 'Particulars', 'বিবরণ'),
      col('debit', 'Debit', 'ডেবিট', 'money'),
      col('credit', 'Credit', 'ক্রেডিট', 'money'),
      col('balance', 'Balance', 'ব্যালেন্স', 'money'),
    ],
    rows,
    {
      opening: result.openingBalance,
      debit: result.totalDebit,
      credit: result.totalCredit,
      balance: result.closingBalance,
    },
    { from: q.from, to: q.to, accountCode },
  );
}

export function reportProfitAndLoss(ctx: Ctx, q: RangeQuery): ReportTable {
  const pl = profitAndLoss(ctx, q);
  const rows: Array<Record<string, string | number | null>> = [
    { line: 'Gross Sales', line_bn: 'মোট বিক্রয়', amount: pl.grossSales },
    { line: 'Less: Sales Discount', line_bn: 'বিয়োগ: বিক্রয় ছাড়', amount: -pl.salesDiscount },
    { line: 'Less: Sales Returns', line_bn: 'বিয়োগ: বিক্রয় ফেরত', amount: -pl.salesReturns },
    { line: 'Net Sales', line_bn: 'নিট বিক্রয়', amount: pl.netSales },
    { line: 'Less: Cost of Goods Sold', line_bn: 'বিয়োগ: বিক্রীত পণ্যের ক্রয়মূল্য', amount: -pl.costOfGoodsSold },
    { line: 'Gross Profit', line_bn: 'মোট মুনাফা', amount: pl.grossProfit },
  ];
  for (const e of pl.operatingExpenseLines) {
    rows.push({ line: e.name, line_bn: e.name_bn, amount: -e.amount });
  }
  rows.push({
    line: 'Total Operating Expenses',
    line_bn: 'মোট পরিচালন ব্যয়',
    amount: -pl.totalOperatingExpenses,
  });
  for (const i of pl.otherIncomeLines) {
    rows.push({ line: i.name, line_bn: i.name_bn, amount: i.amount });
  }
  rows.push({ line: 'Net Profit', line_bn: 'নিট মুনাফা', amount: pl.netProfit });

  return table(
    'profit-loss',
    'Profit & Loss Statement',
    'লাভ-ক্ষতি বিবরণী',
    [
      col('line', 'Particulars', 'বিবরণ'),
      col('amount', 'Amount', 'টাকা', 'money'),
    ],
    rows.map((r) => ({ line: r.line, amount: r.amount })),
    { amount: pl.netProfit },
    {
      from: q.from,
      to: q.to,
      grossSales: pl.grossSales,
      netSales: pl.netSales,
      grossProfit: pl.grossProfit,
      netProfit: pl.netProfit,
    },
  );
}

export function reportCashFlow(ctx: Ctx, q: RangeQuery): ReportTable {
  const cf = cashFlow(ctx, q);
  const rows: Array<Record<string, string | number | null>> = [
    { item: 'Opening cash & bank balance', item_bn: 'প্রারম্ভিক নগদ ও ব্যাংক', amount: cf.openingBalance },
  ];
  for (const r of cf.rows) {
    rows.push({ item: `${r.sourceType} (in)`, item_bn: '', amount: r.inflow });
    rows.push({ item: `${r.sourceType} (out)`, item_bn: '', amount: -r.outflow });
  }
  rows.push({ item: 'Net movement', item_bn: 'নিট পরিবর্তন', amount: cf.totalInflow - cf.totalOutflow });
  rows.push({ item: 'Closing cash & bank balance', item_bn: 'সমাপনী নগদ ও ব্যাংক', amount: cf.closingBalance });
  return table(
    'cash-flow',
    'Cash Flow Statement',
    'নগদ প্রবাহ বিবরণী',
    [
      col('item', 'Particulars', 'বিবরণ'),
      col('amount', 'Amount', 'টাকা', 'money'),
    ],
    rows.map((r) => ({ item: r.item, amount: r.amount })),
    { amount: cf.closingBalance },
    { from: q.from, to: q.to },
  );
}

export function reportAccountBalances(ctx: Ctx, q: RangeQuery): ReportTable {
  const balances = accountBalances(ctx, q);
  return table(
    'account-balances',
    'Account Balances',
    'হিসাবের স্থিতি',
    [
      col('code', 'Code', 'কোড'),
      col('name', 'Account', 'হিসাব'),
      col('type', 'Type', 'ধরন'),
      col('debit', 'Debit', 'ডেবিট', 'money'),
      col('credit', 'Credit', 'ক্রেডিট', 'money'),
    ],
    balances.map((b) => ({
      code: b.code,
      name: b.name,
      type: b.type,
      debit: b.debit,
      credit: b.credit,
    })),
    {
      debit: balances.reduce((a, b) => a + b.debit, 0),
      credit: balances.reduce((a, b) => a + b.credit, 0),
    },
    { from: q.from, to: q.to },
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export interface DashboardSummary {
  from: string;
  to: string;
  salesTotal: number;
  salesCount: number;
  salesPaid: number;
  salesDue: number;
  purchasesTotal: number;
  purchasesCount: number;
  expensesTotal: number;
  grossProfit: number;
  netProfit: number;
  receivables: number;
  payables: number;
  cashBalance: number;
  stockValue: number;
  productCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  customerCount: number;
  supplierCount: number;
  unclosedInvoices: number;
}

export function dashboardSummary(ctx: Ctx, q: RangeQuery): DashboardSummary {
  const sales = ctx.db.get<{
    total: number;
    count: number;
    paid: number;
    due: number;
    profit: number;
  }>(
    `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS count,
            COALESCE(SUM(paid),0) AS paid, COALESCE(SUM(due),0) AS due,
            COALESCE(SUM(total - tax_total - cogs),0) AS profit
       FROM sales_invoices
      WHERE status = 'completed' AND biz_date >= ? AND biz_date <= ?`,
    [q.from, q.to],
  );
  const purchases = ctx.db.get<{ total: number; count: number }>(
    `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS count FROM purchases
      WHERE status = 'completed' AND biz_date >= ? AND biz_date <= ?`,
    [q.from, q.to],
  );
  const expenses = ctx.db.get<{ total: number }>(
    'SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE biz_date >= ? AND biz_date <= ?',
    [q.from, q.to],
  );
  const pl = profitAndLoss(ctx, q);
  const receivables = ctx.db.sum(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id WHERE a.code = ? AND jl.party_type = 'customer'`,
    [ACC.AR],
  );
  const payables = ctx.db.sum(
    `SELECT COALESCE(SUM(jl.credit - jl.debit),0) AS v FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id WHERE a.code = ? AND jl.party_type = 'supplier'`,
    [ACC.AP],
  );
  const cash = ctx.db.sum(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id WHERE a.code IN (?, ?, ?, ?)`,
    [ACC.CASH, ACC.BANK, ACC.MFS, ACC.CARD_CLEARING],
  );

  return {
    from: q.from,
    to: q.to,
    salesTotal: sales?.total ?? 0,
    salesCount: sales?.count ?? 0,
    salesPaid: sales?.paid ?? 0,
    salesDue: sales?.due ?? 0,
    purchasesTotal: purchases?.total ?? 0,
    purchasesCount: purchases?.count ?? 0,
    expensesTotal: expenses?.total ?? 0,
    grossProfit: pl.grossProfit,
    netProfit: pl.netProfit,
    receivables,
    payables,
    cashBalance: cash,
    stockValue: stockValuation(ctx).totalValue,
    productCount: ctx.db.count('products', "status = 'active'"),
    lowStockCount: lowStock(ctx).length,
    outOfStockCount: outOfStock(ctx).length,
    customerCount: ctx.db.count('customers', "status = 'active'"),
    supplierCount: ctx.db.count('suppliers', "status = 'active'"),
    unclosedInvoices: ctx.db.count('sales_invoices', "status = 'completed' AND due > 0"),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sumKeys(
  rows: Array<Record<string, string | number | null>>,
  keys: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  }
  return out;
}

/** Registry used by the Reports screen to enumerate available reports. */
export const REPORT_CATALOG: Array<{
  key: string;
  title: string;
  titleBn: string;
  group: 'sales' | 'purchase' | 'parties' | 'stock' | 'accounting';
  needsRange: boolean;
}> = [
  { key: 'daily-sales', title: 'Daily Sales', titleBn: 'দৈনিক বিক্রয়', group: 'sales', needsRange: true },
  { key: 'sales-by-invoice', title: 'Sales Register', titleBn: 'বিক্রয় রেজিস্টার', group: 'sales', needsRange: true },
  { key: 'sales-by-product', title: 'Product-wise Sales', titleBn: 'পণ্যভিত্তিক বিক্রয়', group: 'sales', needsRange: true },
  { key: 'sales-by-category', title: 'Category-wise Sales', titleBn: 'ক্যাটাগরিভিত্তিক বিক্রয়', group: 'sales', needsRange: true },
  { key: 'best-selling', title: 'Best Selling Products', titleBn: 'সর্বাধিক বিক্রীত পণ্য', group: 'sales', needsRange: true },
  { key: 'sales-returns', title: 'Sales Returns', titleBn: 'বিক্রয় ফেরত', group: 'sales', needsRange: true },
  { key: 'payment-history', title: 'Payment History', titleBn: 'পেমেন্ট ইতিহাস', group: 'sales', needsRange: true },
  { key: 'purchases', title: 'Purchases', titleBn: 'ক্রয়', group: 'purchase', needsRange: true },
  { key: 'purchase-returns', title: 'Purchase Returns', titleBn: 'ক্রয় ফেরত', group: 'purchase', needsRange: true },
  { key: 'expenses', title: 'Expenses', titleBn: 'খরচ', group: 'purchase', needsRange: true },
  { key: 'customer-due', title: 'Customer Due', titleBn: 'গ্রাহক বাকি', group: 'parties', needsRange: false },
  { key: 'supplier-due', title: 'Supplier Payable', titleBn: 'সরবরাহকারী পাওনা', group: 'parties', needsRange: false },
  { key: 'stock', title: 'Stock Report', titleBn: 'স্টক রিপোর্ট', group: 'stock', needsRange: false },
  { key: 'low-stock', title: 'Low Stock', titleBn: 'কম স্টক', group: 'stock', needsRange: false },
  { key: 'out-of-stock', title: 'Out of Stock', titleBn: 'স্টক শেষ', group: 'stock', needsRange: false },
  { key: 'stock-movement', title: 'Stock Movement', titleBn: 'স্টক চলাচল', group: 'stock', needsRange: true },
  { key: 'inventory-valuation', title: 'Inventory Valuation', titleBn: 'স্টক মূল্যায়ন', group: 'stock', needsRange: false },
  { key: 'trial-balance', title: 'Trial Balance', titleBn: 'রেওয়ামিল', group: 'accounting', needsRange: true },
  { key: 'general-ledger', title: 'General Ledger', titleBn: 'সাধারণ খতিয়ান', group: 'accounting', needsRange: true },
  { key: 'profit-loss', title: 'Profit & Loss', titleBn: 'লাভ-ক্ষতি', group: 'accounting', needsRange: true },
  { key: 'cash-flow', title: 'Cash Flow', titleBn: 'নগদ প্রবাহ', group: 'accounting', needsRange: true },
  { key: 'account-balances', title: 'Account Balances', titleBn: 'হিসাবের স্থিতি', group: 'accounting', needsRange: true },
];

export interface ReportRequest extends DateWindow {
  key: string;
  from: string;
  to: string;
  productId?: string;
  customerId?: string;
  supplierId?: string;
  accountCode?: string;
}

/** Single dispatch point used by the UI and the exporters. */
export function buildReport(ctx: Ctx, req: ReportRequest): ReportTable {
  const q = { from: req.from, to: req.to };
  switch (req.key) {
    case 'daily-sales':
      return reportDailySales(ctx, q);
    case 'sales-by-invoice':
      return reportSalesByInvoice(ctx, { ...q, customerId: req.customerId });
    case 'sales-by-product':
      return reportSalesByProduct(ctx, q);
    case 'sales-by-category':
      return reportSalesByCategory(ctx, q);
    case 'best-selling':
      return reportBestSelling(ctx, q);
    case 'sales-returns':
      return reportSalesReturns(ctx, q);
    case 'payment-history':
      return reportPaymentHistory(ctx, q);
    case 'purchases':
      return reportPurchases(ctx, q);
    case 'purchase-returns':
      return reportPurchaseReturns(ctx, q);
    case 'expenses':
      return reportExpenses(ctx, q);
    case 'customer-due':
      return reportCustomerDue(ctx, q);
    case 'supplier-due':
      return reportSupplierDue(ctx);
    case 'customer-statement':
      if (!req.customerId) throw new Error('customerId is required');
      return reportCustomerStatement(ctx, req.customerId, q);
    case 'supplier-statement':
      if (!req.supplierId) throw new Error('supplierId is required');
      return reportSupplierStatement(ctx, req.supplierId, q);
    case 'stock':
      return reportStock(ctx);
    case 'low-stock':
      return reportLowStock(ctx);
    case 'out-of-stock':
      return reportOutOfStock(ctx);
    case 'stock-movement':
      return reportStockMovement(ctx, { ...q, productId: req.productId });
    case 'inventory-valuation':
      return reportInventoryValuation(ctx);
    case 'trial-balance':
      return reportTrialBalance(ctx, q);
    case 'general-ledger':
      return reportGeneralLedger(ctx, q);
    case 'account-ledger':
      if (!req.accountCode) throw new Error('accountCode is required');
      return reportAccountLedger(ctx, req.accountCode, q);
    case 'profit-loss':
      return reportProfitAndLoss(ctx, q);
    case 'cash-flow':
      return reportCashFlow(ctx, q);
    case 'account-balances':
      return reportAccountBalances(ctx, q);
    default:
      throw new Error(`Unknown report: ${req.key}`);
  }
}
