/**
 * Purchases: buying stock from suppliers, with landed-cost capture.
 *
 * Additional cost (transport, unloading, duty) is spread across the lines by the
 * server and capitalised into inventory, so the stock valuation and the ledger
 * always agree. This screen only collects the facts.
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
  MoneyInput,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Spinner,
  useUi,
  today,
  Badge,
} from '../components';
import { formatPaisa, formatQty } from '../../core/foundation/money';
import { PAYMENT_METHODS } from '../../core/accounting/accounts';

interface PurchaseRow {
  id: string;
  purchase_no: string;
  at: string;
  biz_date: string;
  supplier_id: string | null;
  supplier_name: string | null;
  total: number;
  paid: number;
  due: number;
  status: string;
  additional_cost: number;
  supplier_ref: string | null;
}

interface ListResult {
  rows: PurchaseRow[];
  total: number;
  page: number;
  totalPages: number;
  totals: { total: number; paid: number; due: number };
}

interface Product {
  id: string;
  name: string;
  name_bn: string | null;
  sku: string;
  purchase_price: number;
  unit_short: string | null;
  stock_qty: number;
}

interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
}

interface DraftLine {
  product: Product;
  qty: string;
  unitCost: number;
}

interface Detail {
  purchase: PurchaseRow & { note: string | null };
  lines: Array<{
    id: string;
    name_snapshot: string;
    qty: number;
    unit_cost: number;
    line_total: number;
    landed_unit_cost: number;
    stock_value: number;
    returned_qty: number;
  }>;
}

export function PurchasesScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const [range, setRange] = useState(() => {
    const d = new Date();
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10), to: today() };
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [additionalCost, setAdditionalCost] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [productQuery, setProductQuery] = useState('');
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [paidAmount, setPaidAmount] = useState(0);
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [payOpen, setPayOpen] = useState<Supplier | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('cash');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<ListResult>('purchases', 'list', {
        from: range.from,
        to: range.to,
        search: search || undefined,
        page,
        pageSize: 25,
      });
      setData(result);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setLoading(false);
    }
  }, [range, search, page, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void call<{ rows: Supplier[] }>('parties', 'suppliers', { pageSize: 200 })
      .then((r) => {
        setSuppliers(r.rows);
        if (r.rows.length > 0) setSupplierId((prev) => prev || r.rows[0].id);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!creating) return;
    const timer = window.setTimeout(() => {
      void call<{ rows: Product[] }>('catalog', 'search', { search: productQuery, pageSize: 12 })
        .then((r) => setProductResults(r.rows))
        .catch(() => setProductResults([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [productQuery, creating]);

  const subtotal = lines.reduce((sum, l) => {
    const qty = Number(l.qty) || 0;
    return sum + Math.round(l.unitCost * qty);
  }, 0);
  const total = subtotal + additionalCost;

  const submit = async () => {
    if (!supplierId) {
      toast('warning', lang === 'bn' ? 'সরবরাহকারী নির্বাচন করুন।' : 'Select a supplier.');
      return;
    }
    if (lines.length === 0) {
      toast('warning', lang === 'bn' ? 'কমপক্ষে একটি পণ্য যোগ করুন।' : 'Add at least one product.');
      return;
    }
    setSaving(true);
    try {
      const result = await call<{ purchaseNo: string; total: number }>('purchases', 'create', {
        supplierId,
        lines: lines.map((l) => ({ productId: l.product.id, qty: l.qty, unitCost: l.unitCost })),
        additionalCost,
        payments: paidAmount > 0 ? [{ method, amount: paidAmount }] : [],
        supplierRef: supplierRef || null,
        note: note || null,
      });
      toast(
        'success',
        lang === 'bn'
          ? `ক্রয় সংরক্ষিত · ${result.purchaseNo} · ${formatPaisa(result.total)}`
          : `Purchase saved · ${result.purchaseNo} · ${formatPaisa(result.total)}`,
      );
      setCreating(false);
      setLines([]);
      setAdditionalCost(0);
      setPaidAmount(0);
      setSupplierRef('');
      setNote('');
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn || err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (row: PurchaseRow) => {
    try {
      setDetail(await call<Detail>('purchases', 'get', { id: row.id }));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const submitSupplierPayment = async () => {
    if (!payOpen) return;
    if (payAmount <= 0) {
      toast('warning', lang === 'bn' ? 'টাকার পরিমাণ দিন।' : 'Enter an amount.');
      return;
    }
    try {
      await call('payments', 'paySupplier', { supplierId: payOpen.id, amount: payAmount, method: payMethod });
      toast('success', lang === 'bn' ? 'পরিশোধ সংরক্ষিত হয়েছে।' : 'Payment recorded.');
      setPayOpen(null);
      setPayAmount(0);
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={t('navPurchases')}
        subtitle={lang === 'bn' ? 'সরবরাহকারীর কাছ থেকে মাল ক্রয় ও পরিশোধ' : 'Stock intake from suppliers and payments'}
        actions={
          <>
            <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
            <Button onClick={() => void load()}>{t('refresh')}</Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              + {t('newPurchase')}
            </Button>
          </>
        }
      />

      <Card bodyClass="tight">
        <div className="row wrap" style={{ padding: 8 }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <SearchInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={lang === 'bn' ? 'ক্রয় নম্বর বা সরবরাহকারী' : 'Purchase number or supplier'}
            />
          </div>
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
                  title={lang === 'bn' ? 'এই সময়ে কোনো ক্রয় নেই' : 'No purchases in this period'}
                  hint={lang === 'bn' ? 'নতুন ক্রয় যোগ করে শুরু করুন।' : 'Record a purchase to add stock.'}
                />
              }
              columns={[
                { key: 'no', header: t('purchaseNo'), render: (r) => <span className="mono strong">{r.purchase_no}</span> },
                { key: 'date', header: t('date'), render: (r) => <span className="small">{r.biz_date}</span> },
                {
                  key: 'supplier',
                  header: t('supplier'),
                  render: (r) => <span className="truncate">{r.supplier_name ?? '—'}</span>,
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
                  render: (r) => (r.due > 0 ? <Badge tone="warning">{t('due')}</Badge> : <Badge tone="success">{t('paid')}</Badge>),
                },
              ]}
              footer={
                data ? (
                  <tr>
                    <td colSpan={3}>{t('total')}</td>
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

      {creating ? (
        <Modal
          title={t('newPurchase')}
          onClose={() => setCreating(false)}
          wide
          footer={
            <>
              <Button onClick={() => setCreating(false)}>{t('cancel')}</Button>
              <Button variant="primary" loading={saving} onClick={() => void submit()}>
                {t('save')} · {formatPaisa(total)}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="form-grid">
              <Field label={t('supplier')} required>
                <Select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  options={[
                    { value: '', label: '—' },
                    ...suppliers.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                />
              </Field>
              <Field label={t('supplierRef')}>
                <Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
              </Field>
            </div>

            <div>
              <Field label={lang === 'bn' ? 'পণ্য যোগ করুন' : 'Add products'}>
                <SearchInput value={productQuery} onChange={setProductQuery} placeholder={lang === 'bn' ? 'পণ্য খুঁজুন' : 'Search products'} />
              </Field>
              {productResults.length > 0 ? (
                <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                  {productResults.map((p) => (
                    <Button
                      key={p.id}
                      size="sm"
                      onClick={() => {
                        setLines((prev) =>
                          prev.some((l) => l.product.id === p.id)
                            ? prev
                            : [...prev, { product: p, qty: '1', unitCost: p.purchase_price }],
                        );
                        setProductQuery('');
                        setProductResults([]);
                      }}
                    >
                      + {lang === 'bn' && p.name_bn ? p.name_bn : p.name}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>

            {lines.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{lang === 'bn' ? 'পণ্য' : 'Product'}</th>
                      <th className="right">{t('quantity')}</th>
                      <th className="right">{lang === 'bn' ? 'একক ক্রয়মূল্য' : 'Unit cost'}</th>
                      <th className="right">{t('total')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, index) => (
                      <tr key={l.product.id}>
                        <td>{lang === 'bn' && l.product.name_bn ? l.product.name_bn : l.product.name}</td>
                        <td className="right">
                          <input
                            className="input num"
                            style={{ width: 90 }}
                            value={l.qty}
                            onChange={(e) =>
                              setLines((prev) =>
                                prev.map((row, i) => (i === index ? { ...row, qty: e.target.value } : row)),
                              )
                            }
                          />
                        </td>
                        <td className="right">
                          <MoneyInput
                            valuePaisa={l.unitCost}
                            onChange={(v) =>
                              setLines((prev) => prev.map((row, i) => (i === index ? { ...row, unitCost: v } : row)))
                            }
                          />
                        </td>
                        <td className="money">
                          {formatPaisa(Math.round(l.unitCost * (Number(l.qty) || 0)))}
                        </td>
                        <td className="right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                          >
                            ✕
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="alert info">
                {lang === 'bn' ? 'উপরের সার্চ থেকে পণ্য যোগ করুন।' : 'Add products from the search above.'}
              </div>
            )}

            <div className="form-grid">
              <Field
                label={t('additionalCost')}
                hint={lang === 'bn' ? 'পরিবহন/মজুরি — স্টক মূল্যে যোগ হবে' : 'Freight/labour — capitalised into stock'}
              >
                <MoneyInput valuePaisa={additionalCost} onChange={setAdditionalCost} />
              </Field>
              <Field label={t('posPaidAmount')}>
                <MoneyInput valuePaisa={paidAmount} onChange={setPaidAmount} />
              </Field>
              <Field label={t('posPayment')}>
                <Select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  options={PAYMENT_METHODS.map((m) => ({ value: m.key, label: lang === 'bn' ? m.nameBn : m.name }))}
                />
              </Field>
              <Field label={t('note')}>
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>

            <div className="summary-strip">
              <div className="item">
                <div className="label">{t('subtotal')}</div>
                <div className="value">{formatPaisa(subtotal)}</div>
              </div>
              <div className="item">
                <div className="label">{t('additionalCost')}</div>
                <div className="value">{formatPaisa(additionalCost)}</div>
              </div>
              <div className="item">
                <div className="label">{t('total')}</div>
                <div className="value">{formatPaisa(total)}</div>
              </div>
              <div className="item">
                <div className="label">{t('due')}</div>
                <div className="value">{formatPaisa(Math.max(0, total - paidAmount))}</div>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {detail ? (
        <Modal
          title={`${t('purchaseNo')} ${detail.purchase.purchase_no}`}
          onClose={() => setDetail(null)}
          wide
          footer={
            <>
              <Button onClick={() => setDetail(null)}>{t('close')}</Button>
              {detail.purchase.due > 0 && detail.purchase.supplier_id ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    const supplier = suppliers.find((s) => s.id === detail.purchase.supplier_id);
                    if (supplier) {
                      setPayOpen(supplier);
                      setPayAmount(detail.purchase.due);
                    }
                  }}
                >
                  {t('paySupplier')}
                </Button>
              ) : null}
            </>
          }
        >
          <div className="stack">
            <div className="summary-strip">
              <div className="item">
                <div className="label">{t('date')}</div>
                <div className="value">{detail.purchase.biz_date}</div>
              </div>
              <div className="item">
                <div className="label">{t('supplier')}</div>
                <div className="value">{detail.purchase.supplier_name ?? '—'}</div>
              </div>
              <div className="item">
                <div className="label">{t('total')}</div>
                <div className="value">{formatPaisa(detail.purchase.total)}</div>
              </div>
              <div className="item">
                <div className="label">{t('due')}</div>
                <div className="value">{formatPaisa(detail.purchase.due)}</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{lang === 'bn' ? 'পণ্য' : 'Product'}</th>
                    <th className="right">{t('quantity')}</th>
                    <th className="right">{lang === 'bn' ? 'ক্রয়মূল্য' : 'Unit cost'}</th>
                    <th className="right">{lang === 'bn' ? 'ল্যান্ডেড মূল্য' : 'Landed cost'}</th>
                    <th className="right">{t('total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name_snapshot}</td>
                      <td className="money">{formatQty(l.qty)}</td>
                      <td className="money">{formatPaisa(l.unit_cost)}</td>
                      <td className="money">{formatPaisa(l.landed_unit_cost)}</td>
                      <td className="money strong">{formatPaisa(l.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Modal>
      ) : null}

      {payOpen ? (
        <Modal
          title={`${t('paySupplier')} · ${payOpen.name}`}
          onClose={() => setPayOpen(null)}
          footer={
            <>
              <Button onClick={() => setPayOpen(null)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => void submitSupplierPayment()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="summary-strip">
              <div className="item">
                <div className="label">{lang === 'bn' ? 'বর্তমান পাওনা' : 'Current payable'}</div>
                <div className="value">{formatPaisa(payOpen.balance)}</div>
              </div>
            </div>
            <Field label={t('amount')} required>
              <MoneyInput valuePaisa={payAmount} onChange={setPayAmount} autoFocus />
            </Field>
            <Field label={t('posPayment')}>
              <Select
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
                options={PAYMENT_METHODS.map((m) => ({ value: m.key, label: lang === 'bn' ? m.nameBn : m.name }))}
              />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
