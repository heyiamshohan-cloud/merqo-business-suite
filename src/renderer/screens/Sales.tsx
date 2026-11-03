/**
 * Sales register: search, inspect, reprint, void and return.
 *
 * Posted invoices are immutable — "void" records a reversing document and keeps
 * the original visible, which is what an auditor expects. The UI mirrors that
 * rule instead of hiding it: a voided invoice keeps its number and shows why.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  Card,
  DataTable,
  DateRangePicker,
  EmptyState,
  Field,
  Input,
  Modal,
  Money,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Spinner,
  useUi,
  today,
  Badge,
} from '../components';
import { useApp } from '../App';
import { formatPaisa, formatQty } from '../../core/foundation/money';
import { PAYMENT_METHODS } from '../../core/accounting/accounts';

interface InvoiceRow {
  id: string;
  invoice_no: string;
  at: string;
  biz_date: string;
  customer_id: string | null;
  customer_name: string | null;
  gross_total: number;
  item_discount: number;
  invoice_discount: number;
  tax_total: number;
  total: number;
  paid: number;
  due: number;
  status: string;
  note: string | null;
}

interface InvoiceDetail {
  invoice: InvoiceRow;
  lines: Array<{
    id: string;
    name_snapshot: string;
    qty: number;
    unit_price: number;
    discount: number;
    tax: number;
    line_total: number;
    returned_qty: number;
  }>;
  payments: Array<{ id: string; receipt_no: string; at: string; method: string; amount: number }>;
  returns: Array<{ id: string; return_no: string; at: string; total: number; restock: string }>;
}

interface ReturnableLine {
  lineId: string;
  productId: string;
  name: string;
  qty: number;
  returned: number;
  returnable: number;
  unitPrice: number;
  lineTotal: number;
}

interface ListResult {
  rows: InvoiceRow[];
  total: number;
  page: number;
  totalPages: number;
  totals: { total: number; paid: number; due: number };
}

export function SalesScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const { session } = useApp();
  const [range, setRange] = useState(() => {
    const d = new Date();
    return {
      from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10),
      to: today(),
    };
  });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'completed' | 'voided'>('all');
  const [dueOnly, setDueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [receiptHtml, setReceiptHtml] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);
  const [voidTarget, setVoidTarget] = useState<InvoiceRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [returnLines, setReturnLines] = useState<ReturnableLine[] | null>(null);
  const [returnQty, setReturnQty] = useState<Record<string, string>>({});
  const [returnPolicy, setReturnPolicy] = useState<'resalable' | 'damaged' | 'none'>('resalable');
  const [returnMethod, setReturnMethod] = useState('credit');
  const [returnReason, setReturnReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<ListResult>('sales', 'list', {
        from: range.from,
        to: range.to,
        search: search || undefined,
        status,
        withDueOnly: dueOnly || undefined,
        page,
        pageSize: 25,
      });
      setData(result);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setLoading(false);
    }
  }, [range, search, status, dueOnly, page, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (invoice: InvoiceRow) => {
    try {
      const detailResult = await call<InvoiceDetail>('sales', 'get', { id: invoice.id });
      setDetail(detailResult);
      const receipt = await call<{ html: string }>('printing', 'invoiceReceipt', {
        invoiceId: invoice.id,
        lang,
      });
      setReceiptHtml(receipt.html);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const doPrint = async () => {
    try {
      const result = await call<{ ok: boolean; reason?: string }>('printing', 'printHtml', {
        html: receiptHtml,
        paperWidthMm: session.paperWidthMm,
        silent: true,
      });
      if (result.ok) toast('success', lang === 'bn' ? 'প্রিন্ট পাঠানো হয়েছে।' : 'Sent to printer.');
      else toast('warning', result.reason ?? (lang === 'bn' ? 'প্রিন্টার পাওয়া যায়নি।' : 'Printer unavailable.'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const doVoid = async () => {
    if (!voidTarget) return;
    if (voidReason.trim().length < 3) {
      toast('warning', lang === 'bn' ? 'বাতিলের কারণ লিখুন।' : 'Enter a void reason.');
      return;
    }
    try {
      await call('sales', 'void', { id: voidTarget.id, reason: voidReason.trim() });
      toast('success', lang === 'bn' ? 'ইনভয়েস বাতিল হয়েছে।' : 'Invoice voided.');
      setVoidTarget(null);
      setVoidReason('');
      setDetail(null);
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const openReturn = async () => {
    if (!detail) return;
    try {
      const rows = await call<ReturnableLine[]>('returns', 'returnableInvoiceLines', {
        invoiceId: detail.invoice.id,
      });
      setReturnLines(rows);
      setReturnQty({});
      setReturnReason('');
      setReturnMethod(detail.invoice.due > 0 ? 'credit' : 'cash');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const submitReturn = async () => {
    if (!detail || !returnLines) return;
    const lines = returnLines
      .map((l) => ({ lineId: l.lineId, qty: returnQty[l.lineId] }))
      .filter((l) => l.qty && Number(l.qty) > 0);
    if (lines.length === 0) {
      toast('warning', lang === 'bn' ? 'ফেরতের পরিমাণ দিন।' : 'Enter a return quantity.');
      return;
    }
    if (returnReason.trim() === '') {
      toast('warning', lang === 'bn' ? 'ফেরতের কারণ লিখুন।' : 'A return reason is required.');
      return;
    }
    try {
      const result = await call<{ returnNo: string; total: number }>('returns', 'createSalesReturn', {
        invoiceId: detail.invoice.id,
        lines,
        refundMethod: returnMethod,
        restock: returnPolicy,
        reason: returnReason.trim(),
      });
      toast(
        'success',
        lang === 'bn'
          ? `ফেরত সম্পন্ন · ${result.returnNo} · ${formatPaisa(result.total)}`
          : `Return recorded · ${result.returnNo} · ${formatPaisa(result.total)}`,
      );
      setReturnLines(null);
      setDetail(null);
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={t('navSales')}
        subtitle={lang === 'bn' ? 'সব বিক্রয়ের তালিকা ও বিস্তারিত' : 'All sales with full document detail'}
        actions={
          <>
            <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
            <Button onClick={() => void load()}>{t('refresh')}</Button>
          </>
        }
      />

      <Card bodyClass="tight">
        <div className="row wrap" style={{ padding: 8, gap: 8 }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <SearchInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={lang === 'bn' ? 'ইনভয়েস নম্বর বা গ্রাহক' : 'Invoice number or customer'}
            />
          </div>
          <Select
            style={{ width: 140 }}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            options={[
              { value: 'all', label: t('all') },
              { value: 'completed', label: t('completed') },
              { value: 'voided', label: t('voided') },
            ]}
          />
          <Button variant={dueOnly ? 'primary' : 'secondary'} onClick={() => setDueOnly((v) => !v)}>
            {lang === 'bn' ? 'শুধু বাকি' : 'Due only'}
          </Button>
        </div>

        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <DataTable
              rows={data?.rows ?? []}
              keyOf={(r) => r.id}
              onRowClick={(r) => void openDetail(r)}
              empty={
                <EmptyState
                  title={lang === 'bn' ? 'এই সময়ে কোনো বিক্রয় নেই' : 'No sales in this period'}
                  hint={lang === 'bn' ? 'তারিখের পরিসর বদলে দেখুন বা নতুন বিক্রয় করুন।' : 'Change the date range or open the till.'}
                />
              }
              columns={[
                {
                  key: 'no',
                  header: t('invoiceNo'),
                  render: (r) => <span className="mono strong">{r.invoice_no}</span>,
                },
                { key: 'date', header: t('date'), render: (r) => <span className="small">{r.biz_date}</span> },
                {
                  key: 'customer',
                  header: t('customer'),
                  render: (r) => <span className="truncate">{r.customer_name ?? t('posWalkIn')}</span>,
                },
                { key: 'total', header: t('total'), align: 'right', render: (r) => <Money paisa={r.total} /> },
                { key: 'paid', header: t('paid'), align: 'right', render: (r) => <Money paisa={r.paid} /> },
                {
                  key: 'due',
                  header: t('due'),
                  align: 'right',
                  render: (r) => <span className={r.due > 0 ? 'mono text-warning' : 'mono'}>{formatPaisa(r.due)}</span>,
                },
                {
                  key: 'status',
                  header: t('status'),
                  render: (r) =>
                    r.status === 'voided' ? (
                      <Badge tone="danger">{t('voided')}</Badge>
                    ) : r.due > 0 ? (
                      <Badge tone="warning">{lang === 'bn' ? 'আংশিক' : 'Partial'}</Badge>
                    ) : (
                      <Badge tone="success">{t('paid')}</Badge>
                    ),
                },
              ]}
              footer={
                data ? (
                  <tr>
                    <td colSpan={3}>{lang === 'bn' ? 'মোট' : 'Total'}</td>
                    <td className="money">{formatPaisa(data.totals.total)}</td>
                    <td className="money">{formatPaisa(data.totals.paid)}</td>
                    <td className="money">{formatPaisa(data.totals.due)}</td>
                    <td />
                  </tr>
                ) : undefined
              }
            />
            {data && data.total > 0 ? (
              <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />
            ) : null}
          </>
        )}
      </Card>

      {detail ? (
        <Modal
          title={`${t('invoiceNo')} ${detail.invoice.invoice_no}`}
          onClose={() => setDetail(null)}
          wide
          footer={
            <>
              <Button onClick={() => setShowReceipt(true)}>{t('preview')}</Button>
              <Button variant="secondary" onClick={() => void doPrint()}>
                {t('print')}
              </Button>
              <Button variant="secondary" onClick={() => void openReturn()} disabled={detail.invoice.status === 'voided'}>
                {t('return')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setVoidTarget(detail.invoice);
                  setVoidReason('');
                }}
                disabled={detail.invoice.status === 'voided'}
              >
                {t('void')}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="summary-strip">
              <div className="item">
                <div className="label">{t('date')}</div>
                <div className="value">{detail.invoice.biz_date}</div>
              </div>
              <div className="item">
                <div className="label">{t('customer')}</div>
                <div className="value">{detail.invoice.customer_name ?? t('posWalkIn')}</div>
              </div>
              <div className="item">
                <div className="label">{t('total')}</div>
                <div className="value">{formatPaisa(detail.invoice.total)}</div>
              </div>
              <div className="item">
                <div className="label">{t('paid')}</div>
                <div className="value">{formatPaisa(detail.invoice.paid)}</div>
              </div>
              <div className="item">
                <div className="label">{t('due')}</div>
                <div className="value">{formatPaisa(detail.invoice.due)}</div>
              </div>
              <div className="item">
                <div className="label">{t('status')}</div>
                <div className="value">
                  {detail.invoice.status === 'voided' ? t('voided') : t('completed')}
                </div>
              </div>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{lang === 'bn' ? 'পণ্য' : 'Item'}</th>
                    <th className="right">{t('quantity')}</th>
                    <th className="right">{t('price')}</th>
                    <th className="right">{t('discount')}</th>
                    <th className="right">{t('vat')}</th>
                    <th className="right">{t('total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.name_snapshot}
                        {l.returned_qty > 0 ? (
                          <span className="badge warning" style={{ marginLeft: 6 }}>
                            {lang === 'bn' ? 'ফেরত' : 'returned'} {formatQty(l.returned_qty)}
                          </span>
                        ) : null}
                      </td>
                      <td className="money">{formatQty(l.qty)}</td>
                      <td className="money">{formatPaisa(l.unit_price)}</td>
                      <td className="money">{formatPaisa(l.discount)}</td>
                      <td className="money">{formatPaisa(l.tax)}</td>
                      <td className="money strong">{formatPaisa(l.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>{t('subtotal')}</td>
                    <td className="money">{formatPaisa(detail.invoice.gross_total)}</td>
                  </tr>
                  {detail.invoice.invoice_discount + detail.invoice.item_discount > 0 ? (
                    <tr>
                      <td colSpan={5}>{t('discount')}</td>
                      <td className="money">
                        −{formatPaisa(detail.invoice.invoice_discount + detail.invoice.item_discount)}
                      </td>
                    </tr>
                  ) : null}
                  {detail.invoice.tax_total > 0 ? (
                    <tr>
                      <td colSpan={5}>{t('vat')}</td>
                      <td className="money">{formatPaisa(detail.invoice.tax_total)}</td>
                    </tr>
                  ) : null}
                  <tr>
                    <td colSpan={5}>{t('total')}</td>
                    <td className="money">{formatPaisa(detail.invoice.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {detail.payments.length > 0 ? (
              <Card title={lang === 'bn' ? 'পেমেন্ট' : 'Payments'} bodyClass="tight">
                <DataTable
                  rows={detail.payments}
                  keyOf={(p) => p.id}
                  columns={[
                    { key: 'no', header: lang === 'bn' ? 'রশিদ' : 'Receipt', render: (p) => <span className="mono">{p.receipt_no}</span> },
                    { key: 'date', header: t('date'), render: (p) => <span className="small">{p.at.slice(0, 10)}</span> },
                    {
                      key: 'method',
                      header: t('posPayment'),
                      render: (p) => PAYMENT_METHODS.find((m) => m.key === p.method)?.[lang === 'bn' ? 'nameBn' : 'name'] ?? p.method,
                    },
                    { key: 'amount', header: t('amount'), align: 'right', render: (p) => <Money paisa={p.amount} /> },
                  ]}
                />
              </Card>
            ) : null}

            {detail.returns.length > 0 ? (
              <Card title={lang === 'bn' ? 'ফেরত' : 'Returns'} bodyClass="tight">
                <DataTable
                  rows={detail.returns}
                  keyOf={(r) => r.id}
                  columns={[
                    { key: 'no', header: lang === 'bn' ? 'ফেরত নং' : 'Return No', render: (r) => <span className="mono">{r.return_no}</span> },
                    { key: 'date', header: t('date'), render: (r) => <span className="small">{r.at.slice(0, 10)}</span> },
                    { key: 'total', header: t('total'), align: 'right', render: (r) => <Money paisa={r.total} /> },
                    { key: 'policy', header: lang === 'bn' ? 'স্টক' : 'Stock', render: (r) => <span className="small">{r.restock}</span> },
                  ]}
                />
              </Card>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {showReceipt && receiptHtml ? (
        <Modal
          title={`${t('preview')} · ${detail?.invoice.invoice_no ?? ''}`}
          onClose={() => setShowReceipt(false)}
          wide
          footer={
            <>
              <Button onClick={() => setShowReceipt(false)}>{t('close')}</Button>
              <Button variant="primary" onClick={() => void doPrint()}>
                {t('print')}
              </Button>
            </>
          }
        >
          <div className="receipt-preview">
            <iframe title="receipt" srcDoc={receiptHtml} />
          </div>
        </Modal>
      ) : null}

      {voidTarget ? (
        <Modal
          title={`${t('void')} · ${voidTarget.invoice_no}`}
          onClose={() => setVoidTarget(null)}
          footer={
            <>
              <Button onClick={() => setVoidTarget(null)}>{t('cancel')}</Button>
              <Button variant="danger" onClick={() => void doVoid()}>
                {t('void')}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="alert warning">
              {lang === 'bn'
                ? 'বাতিল করলে একটি বিপরীত জার্নাল তৈরি হবে। মূল ইনভয়েস মুছে যাবে না — অডিটের জন্য সংরক্ষিত থাকবে।'
                : 'Voiding posts a reversing journal. The original invoice is retained for audit; it is never deleted.'}
            </div>
            <Field label={t('voidReason')} required>
              <Input
                autoFocus
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder={lang === 'bn' ? 'যেমন: ভুল পণ্য বিল হয়েছে' : 'e.g. wrong item billed'}
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      {returnLines ? (
        <Modal
          title={`${t('return')} · ${detail?.invoice.invoice_no ?? ''}`}
          onClose={() => setReturnLines(null)}
          wide
          footer={
            <>
              <Button onClick={() => setReturnLines(null)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => void submitReturn()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{lang === 'bn' ? 'পণ্য' : 'Item'}</th>
                    <th className="right">{lang === 'bn' ? 'বিক্রীত' : 'Sold'}</th>
                    <th className="right">{lang === 'bn' ? 'ফেরতযোগ্য' : 'Returnable'}</th>
                    <th className="right">{lang === 'bn' ? 'ফেরত পরিমাণ' : 'Return qty'}</th>
                  </tr>
                </thead>
                <tbody>
                  {returnLines.map((l) => (
                    <tr key={l.lineId}>
                      <td>{l.name}</td>
                      <td className="money">{formatQty(l.qty)}</td>
                      <td className="money">{formatQty(l.returnable)}</td>
                      <td className="money">
                        <input
                          className="input num"
                          style={{ width: 90 }}
                          value={returnQty[l.lineId] ?? ''}
                          disabled={l.returnable <= 0}
                          onChange={(e) => setReturnQty({ ...returnQty, [l.lineId]: e.target.value })}
                          placeholder="0"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="form-grid">
              <Field label={lang === 'bn' ? 'স্টক ফেরত' : 'Restock policy'}>
                <Select
                  value={returnPolicy}
                  onChange={(e) => setReturnPolicy(e.target.value as typeof returnPolicy)}
                  options={[
                    { value: 'resalable', label: lang === 'bn' ? 'আবার বিক্রয়যোগ্য' : 'Resalable' },
                    { value: 'damaged', label: lang === 'bn' ? 'নষ্ট (স্টকে ফিরবে না)' : 'Damaged (no restock)' },
                    { value: 'none', label: lang === 'bn' ? 'স্টক পরিবর্তন নয়' : 'No stock change' },
                  ]}
                />
              </Field>
              <Field label={lang === 'bn' ? 'ফেরতের মাধ্যম' : 'Refund method'}>
                <Select
                  value={returnMethod}
                  onChange={(e) => setReturnMethod(e.target.value)}
                  options={[
                    { value: 'credit', label: lang === 'bn' ? 'গ্রাহকের বাকিতে সমন্বয়' : 'Adjust customer balance' },
                    ...PAYMENT_METHODS.map((m) => ({ value: m.key, label: lang === 'bn' ? m.nameBn : m.name })),
                  ]}
                />
              </Field>
              <Field label={t('reason')} required className="span-2">
                <Input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} />
              </Field>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
