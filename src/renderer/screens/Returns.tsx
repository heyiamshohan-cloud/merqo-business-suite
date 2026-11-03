/**
 * Returns register.
 *
 * A return is always raised against a specific invoice or purchase, because the
 * server must validate the returnable quantity against the original document.
 * This screen is the read-only register plus a shortcut into the source
 * document, which is where a return is actually created.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  Card,
  DataTable,
  DateRangePicker,
  EmptyState,
  Money,
  PageHeader,
  Spinner,
  useUi,
  today,
  Badge,
} from '../components';
import { useApp } from '../App';

interface SalesReturn {
  id: string;
  return_no: string;
  at: string;
  biz_date: string;
  invoice_no: string;
  customer_name: string | null;
  net_sales: number;
  tax: number;
  total: number;
  restock: string;
  reason: string | null;
}

interface PurchaseReturn {
  id: string;
  return_no: string;
  at: string;
  biz_date: string;
  purchase_no: string;
  supplier_name: string | null;
  net_purchase: number;
  total: number;
  reason: string | null;
}

export function ReturnsScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const { navigate } = useApp();
  const [tab, setTab] = useState<'sales' | 'purchases'>('sales');
  const [range, setRange] = useState(() => {
    const d = new Date();
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10), to: today() };
  });
  const [salesReturns, setSalesReturns] = useState<SalesReturn[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sales, purchases] = await Promise.all([
        call<SalesReturn[]>('returns', 'salesReturns', range),
        call<PurchaseReturn[]>('returns', 'purchaseReturns', range),
      ]);
      setSalesReturns(sales);
      setPurchaseReturns(purchases);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setLoading(false);
    }
  }, [range, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const salesTotal = salesReturns.reduce((sum, r) => sum + r.total, 0);
  const purchaseTotal = purchaseReturns.reduce((sum, r) => sum + r.total, 0);

  return (
    <>
      <PageHeader
        title={t('navReturns')}
        subtitle={lang === 'bn' ? 'বিক্রয় ও ক্রয় ফেরতের রেজিস্টার' : 'Sales and purchase return register'}
        actions={
          <>
            <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
            <Button onClick={() => void load()}>{t('refresh')}</Button>
          </>
        }
      />

      <div className="tabs">
        <button className={`tab ${tab === 'sales' ? 'active' : ''}`} onClick={() => setTab('sales')}>
          {lang === 'bn' ? 'বিক্রয় ফেরত' : 'Sales returns'} · {salesReturns.length}
        </button>
        <button className={`tab ${tab === 'purchases' ? 'active' : ''}`} onClick={() => setTab('purchases')}>
          {lang === 'bn' ? 'ক্রয় ফেরত' : 'Purchase returns'} · {purchaseReturns.length}
        </button>
      </div>

      <Card
        title={tab === 'sales' ? lang === 'bn' ? 'বিক্রয় ফেরত' : 'Sales returns' : lang === 'bn' ? 'ক্রয় ফেরত' : 'Purchase returns'}
        actions={
          <div className="row">
            <span className="small muted">
              {lang === 'bn' ? 'মোট' : 'Total'}:{' '}
              <strong className="mono">{tab === 'sales' ? salesTotal / 100 : purchaseTotal / 100}</strong>{' '}
              {lang === 'bn' ? '৳' : 'BDT'}
            </span>
            <Button size="sm" onClick={() => navigate(tab === 'sales' ? 'sales' : 'purchases')}>
              {lang === 'bn' ? 'মূল ডকুমেন্ট থেকে ফেরত' : 'Return from document'}
            </Button>
          </div>
        }
        bodyClass="tight"
      >
        {loading ? (
          <Spinner />
        ) : tab === 'sales' ? (
          <DataTable
            rows={salesReturns}
            keyOf={(r) => r.id}
            empty={
              <EmptyState
                title={lang === 'bn' ? 'কোনো বিক্রয় ফেরত নেই' : 'No sales returns'}
                hint={lang === 'bn' ? 'বিক্রয় তালিকা থেকে ইনভয়েস খুলে ফেরত দিন।' : 'Open an invoice in Sales to record a return.'}
                action={
                  <Button size="sm" onClick={() => navigate('sales')}>
                    {t('navSales')}
                  </Button>
                }
              />
            }
            columns={[
              { key: 'no', header: lang === 'bn' ? 'ফেরত নং' : 'Return No', render: (r) => <span className="mono">{r.return_no}</span> },
              { key: 'date', header: t('date'), render: (r) => <span className="small">{r.biz_date}</span> },
              { key: 'invoice', header: t('invoiceNo'), render: (r) => <span className="mono small">{r.invoice_no}</span> },
              { key: 'party', header: t('customer'), render: (r) => r.customer_name ?? t('posWalkIn') },
              { key: 'net', header: lang === 'bn' ? 'নিট বিক্রয়' : 'Net sales', align: 'right', render: (r) => <Money paisa={r.net_sales} /> },
              { key: 'tax', header: t('vat'), align: 'right', render: (r) => <Money paisa={r.tax} /> },
              { key: 'total', header: t('total'), align: 'right', render: (r) => <Money paisa={r.total} /> },
              {
                key: 'restock',
                header: lang === 'bn' ? 'স্টক' : 'Stock',
                render: (r) => (
                  <Badge tone={r.restock === 'resalable' ? 'success' : r.restock === 'damaged' ? 'warning' : 'default'}>
                    {r.restock === 'resalable'
                      ? lang === 'bn'
                        ? 'ফিরেছে'
                        : 'Restocked'
                      : r.restock === 'damaged'
                        ? lang === 'bn'
                          ? 'নষ্ট'
                          : 'Damaged'
                        : lang === 'bn'
                          ? 'নেই'
                          : 'No change'}
                  </Badge>
                ),
              },
              { key: 'reason', header: t('reason'), render: (r) => <span className="truncate small">{r.reason ?? '—'}</span> },
            ]}
          />
        ) : (
          <DataTable
            rows={purchaseReturns}
            keyOf={(r) => r.id}
            empty={
              <EmptyState
                title={lang === 'bn' ? 'কোনো ক্রয় ফেরত নেই' : 'No purchase returns'}
                hint={lang === 'bn' ? 'ক্রয় তালিকা থেকে ফেরত দিন।' : 'Open a purchase to record a return.'}
                action={
                  <Button size="sm" onClick={() => navigate('purchases')}>
                    {t('navPurchases')}
                  </Button>
                }
              />
            }
            columns={[
              { key: 'no', header: lang === 'bn' ? 'ফেরত নং' : 'Return No', render: (r) => <span className="mono">{r.return_no}</span> },
              { key: 'date', header: t('date'), render: (r) => <span className="small">{r.biz_date}</span> },
              { key: 'purchase', header: t('purchaseNo'), render: (r) => <span className="mono small">{r.purchase_no}</span> },
              { key: 'party', header: t('supplier'), render: (r) => r.supplier_name ?? '—' },
              { key: 'net', header: lang === 'bn' ? 'নিট ক্রয়' : 'Net purchase', align: 'right', render: (r) => <Money paisa={r.net_purchase} /> },
              { key: 'total', header: t('total'), align: 'right', render: (r) => <Money paisa={r.total} /> },
              { key: 'reason', header: t('reason'), render: (r) => <span className="truncate small">{r.reason ?? '—'}</span> },
            ]}
          />
        )}
      </Card>
    </>
  );
}
