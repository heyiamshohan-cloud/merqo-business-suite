/**
 * Dashboard — every figure here is computed from the ledger and the stock
 * tables at request time. There are no placeholders, no cached demo numbers and
 * no chart that could drift away from the books.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  Card,
  DateRangePicker,
  DataTable,
  EmptyState,
  Kpi,
  Money,
  PageHeader,
  Spinner,
  today,
  useUi,
  Alert,
} from '../components';
import { useApp } from '../App';
import { formatPaisa } from '../../core/foundation/money';

interface Summary {
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

interface RecentInvoice {
  id: string;
  invoice_no: string;
  at: string;
  customer_name: string | null;
  total: number;
  paid: number;
  due: number;
  status: string;
}

interface LowStockRow {
  id: string;
  name: string;
  name_bn: string | null;
  stock_qty: number;
  min_stock: number;
  unit_short: string | null;
}

interface Health {
  journalsBalanced: { ok: boolean; unbalanced: string[] };
  inventory: { ok: boolean; difference: number };
  startup: { databasePath: string; schemaVersion: number; integrity: string; autoBackupPath: string | null } | null;
}

export function DashboardScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const { navigate } = useApp();
  const [range, setRange] = useState(() => {
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
    return { from, to: today() };
  });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<RecentInvoice[]>([]);
  const [low, setLow] = useState<LowStockRow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, invoices, lowStock, healthResult] = await Promise.all([
        call<Summary>('reports', 'dashboard', range),
        call<{ rows: RecentInvoice[] }>('sales', 'list', { page: 1, pageSize: 8 }),
        call<LowStockRow[]>('inventory', 'lowStock'),
        call<Health>('system', 'health'),
      ]);
      setSummary(s);
      setRecent(invoices.rows);
      setLow(lowStock.slice(0, 8));
      setHealth(healthResult);
    } catch (err) {
      const message = err instanceof ApiError ? err.messageBn : String(err);
      setError(message);
      toast('error', message);
    } finally {
      setLoading(false);
    }
  }, [range, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title={t('navDashboard')}
        subtitle={
          lang === 'bn'
            ? `হিসাবের সারসংক্ষেপ · ${range.from} থেকে ${range.to}`
            : `Business snapshot · ${range.from} to ${range.to}`
        }
        actions={
          <>
            <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
            <Button onClick={() => void load()}>{t('refresh')}</Button>
            <Button variant="primary" onClick={() => navigate('pos')}>
              {t('navPos')}
            </Button>
          </>
        }
      />

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {loading && !summary ? (
        <Spinner label={t('loading')} />
      ) : summary ? (
        <div className="stack">
          <div className="kpi-grid">
            <Kpi
              label={t('dashboardTodaySales')}
              value={formatPaisa(summary.salesTotal)}
              foot={`${summary.salesCount} ${lang === 'bn' ? 'টি বিক্রয়' : 'invoices'}`}
            />
            <Kpi
              label={t('dashboardGrossProfit')}
              value={formatPaisa(summary.grossProfit)}
              tone={summary.grossProfit >= 0 ? 'positive' : 'negative'}
              foot={lang === 'bn' ? 'বিক্রয় − বিক্রীত পণ্যের খরচ − ভ্যাট' : 'Sales − COGS − VAT'}
            />
            <Kpi
              label={t('dashboardNetProfit')}
              value={formatPaisa(summary.netProfit)}
              tone={summary.netProfit >= 0 ? 'positive' : 'negative'}
              foot={lang === 'bn' ? 'খরচ বাদ দেওয়ার পর' : 'After expenses'}
            />
            <Kpi label={t('dashboardTodayExpenses')} value={formatPaisa(summary.expensesTotal)} />
            <Kpi label={t('dashboardPurchases') ?? 'ক্রয়'} value={formatPaisa(summary.purchasesTotal)} foot={`${summary.purchasesCount}`} />
            <Kpi
              label={t('dashboardReceivables')}
              value={formatPaisa(summary.receivables)}
              foot={`${summary.customerCount} ${lang === 'bn' ? 'জন গ্রাহক' : 'customers'}`}
            />
            <Kpi
              label={t('dashboardPayables')}
              value={formatPaisa(summary.payables)}
              foot={`${summary.supplierCount} ${lang === 'bn' ? 'জন সরবরাহকারী' : 'suppliers'}`}
            />
            <Kpi label={t('dashboardCash')} value={formatPaisa(summary.cashBalance)} />
            <Kpi
              label={t('dashboardStockValue')}
              value={formatPaisa(summary.stockValue)}
              foot={`${summary.productCount} ${lang === 'bn' ? 'টি পণ্য' : 'products'}`}
            />
            <Kpi
              label={t('dashboardLowStock')}
              value={String(summary.lowStockCount)}
              foot={`${summary.outOfStockCount} ${lang === 'bn' ? 'স্টক শেষ' : 'out of stock'}`}
              tone={summary.outOfStockCount > 0 ? 'negative' : undefined}
            />
            <Kpi
              label={lang === 'bn' ? 'বাকি ইনভয়েস' : 'Unclosed invoices'}
              value={String(summary.unclosedInvoices)}
              foot={lang === 'bn' ? 'সম্পূর্ণ পরিশোধ হয়নি' : 'Not fully paid'}
            />
          </div>

          <div className="grid cols-2">
            <Card
              title={t('dashboardRecentSales')}
              actions={
                <Button size="sm" onClick={() => navigate('sales')}>
                  {t('view')}
                </Button>
              }
              bodyClass="tight"
            >
              <DataTable
                rows={recent}
                keyOf={(row) => row.id}
                empty={
                  <EmptyState
                    title={t('noData')}
                    hint={lang === 'bn' ? 'প্রথম বিক্রয় করতে টিল খুলুন।' : 'Open the till to record your first sale.'}
                    action={
                      <Button variant="primary" size="sm" onClick={() => navigate('pos')}>
                        {t('navPos')}
                      </Button>
                    }
                  />
                }
                columns={[
                  { key: 'no', header: t('invoiceNo'), render: (r) => <span className="mono">{r.invoice_no}</span> },
                  {
                    key: 'customer',
                    header: t('customer'),
                    render: (r) => <span className="truncate">{r.customer_name ?? t('posWalkIn')}</span>,
                  },
                  { key: 'total', header: t('total'), align: 'right', render: (r) => <Money paisa={r.total} /> },
                  {
                    key: 'status',
                    header: t('status'),
                    render: (r) =>
                      r.status === 'voided' ? (
                        <span className="badge danger">{t('voided')}</span>
                      ) : r.due > 0 ? (
                        <span className="badge warning">{t('due')}</span>
                      ) : (
                        <span className="badge success">{t('paid')}</span>
                      ),
                  },
                ]}
              />
            </Card>

            <div className="stack">
              <Card
                title={t('dashboardLowStock')}
                actions={
                  <Button size="sm" onClick={() => navigate('products')}>
                    {t('navProducts')}
                  </Button>
                }
                bodyClass="tight"
              >
                <DataTable
                  rows={low}
                  keyOf={(row) => row.id}
                  empty={<EmptyState title={t('noData')} hint={lang === 'bn' ? 'সব পণ্যের স্টক পর্যাপ্ত।' : 'All stock levels are healthy.'} />}
                  columns={[
                    {
                      key: 'name',
                      header: t('productName'),
                      render: (r) => (
                        <span className="truncate">{lang === 'bn' && r.name_bn ? r.name_bn : r.name}</span>
                      ),
                    },
                    {
                      key: 'stock',
                      header: t('stock'),
                      align: 'right',
                      render: (r) => (
                        <span className={r.stock_qty <= 0 ? 'text-danger mono' : 'mono'}>
                          {(r.stock_qty / 1000).toLocaleString(lang === 'bn' ? 'bn-BD' : 'en-GB')}
                        </span>
                      ),
                    },
                    {
                      key: 'min',
                      header: t('minStock'),
                      align: 'right',
                      render: (r) => <span className="mono muted">{r.min_stock}</span>,
                    },
                  ]}
                />
              </Card>

              <Card title={t('healthCheck')}>
                {health ? (
                  <div className="stack tight small">
                    <div className="row between">
                      <span>{lang === 'bn' ? 'জার্নাল ভারসাম্য' : 'Journals balanced'}</span>
                      {health.journalsBalanced.ok ? (
                        <span className="badge success">{lang === 'bn' ? 'ঠিক আছে' : 'OK'}</span>
                      ) : (
                        <span className="badge danger">
                          {health.journalsBalanced.unbalanced.length} {lang === 'bn' ? 'অসামঞ্জস্য' : 'unbalanced'}
                        </span>
                      )}
                    </div>
                    <div className="row between">
                      <span>{lang === 'bn' ? 'স্টক ও খতিয়ান মিল' : 'Stock vs ledger'}</span>
                      {health.inventory.ok ? (
                        <span className="badge success">{lang === 'bn' ? 'মিলেছে' : 'Reconciled'}</span>
                      ) : (
                        <span className="badge warning">
                          {formatPaisa(health.inventory.difference)}
                        </span>
                      )}
                    </div>
                    <div className="row between">
                      <span>{lang === 'bn' ? 'ডাটাবেস' : 'Database'}</span>
                      <span className="mono small">
                        v{health.startup?.schemaVersion} · {health.startup?.integrity}
                      </span>
                    </div>
                    <div className="row between">
                      <span>{lang === 'bn' ? 'সর্বশেষ স্বয়ংক্রিয় ব্যাকআপ' : 'Last automatic backup'}</span>
                      <span className="small truncate" title={health.startup?.autoBackupPath ?? ''}>
                        {health.startup?.autoBackupPath ? health.startup.autoBackupPath.split(/[\\/]/).pop() : '—'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <Spinner />
                )}
              </Card>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
