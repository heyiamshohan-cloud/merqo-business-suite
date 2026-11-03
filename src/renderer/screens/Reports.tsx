/**
 * Reports.
 *
 * The catalogue and the report builders live in the core, so this screen only
 * chooses a report and a date window. Preview, print, CSV, Excel and PDF all use
 * the same `ReportTable` produced by one server call — there is no second
 * implementation that could disagree with the numbers on screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  Card,
  DateRangePicker,
  EmptyState,
  Money,
  PageHeader,
  Spinner,
  useUi,
  today,
  Badge,
} from '../components';
import { formatPaisa, formatQty } from '../../core/foundation/money';

interface ReportColumn {
  key: string;
  label: string;
  labelBn: string;
  type: 'text' | 'money' | 'qty' | 'date' | 'int' | 'percent';
  align?: 'left' | 'right' | 'center';
}

interface ReportTable {
  key: string;
  title: string;
  titleBn: string;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  totals?: Record<string, string | number | null>;
  meta?: Record<string, string | number | boolean | null>;
}

interface CatalogEntry {
  key: string;
  title: string;
  titleBn: string;
  group: 'sales' | 'purchase' | 'parties' | 'stock' | 'accounting';
  needsRange: boolean;
}

const GROUP_LABEL: Record<CatalogEntry['group'], { bn: string; en: string }> = {
  sales: { bn: 'বিক্রয়', en: 'Sales' },
  purchase: { bn: 'ক্রয় ও খরচ', en: 'Purchases & expenses' },
  parties: { bn: 'গ্রাহক ও সরবরাহকারী', en: 'Customers & suppliers' },
  stock: { bn: 'স্টক', en: 'Stock' },
  accounting: { bn: 'হিসাব', en: 'Accounting' },
};

function renderCell(value: string | number | null, type: ReportColumn['type']): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'money' && typeof value === 'number') return formatPaisa(value);
  if (type === 'qty' && typeof value === 'number') return formatQty(value);
  if (type === 'percent' && typeof value === 'number') return `${(value / 100).toFixed(2)}%`;
  return String(value);
}

export function ReportsScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState<string>('daily-sales');
  const [range, setRange] = useState(() => {
    const d = new Date();
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10), to: today() };
  });
  const [report, setReport] = useState<ReportTable | null>(null);
  const [loading, setLoading] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState<string>('');
  const [showHtml, setShowHtml] = useState(false);

  useEffect(() => {
    void call<CatalogEntry[]>('reports', 'catalog')
      .then(setCatalog)
      .catch((err: unknown) => toast('error', err instanceof ApiError ? err.messageBn : String(err)));
  }, [toast]);

  const run = useCallback(
    async (key: string) => {
      setLoading(true);
      try {
        const table = await call<ReportTable>('reports', 'build', { key, from: range.from, to: range.to });
        setReport(table);
        const html = await call<string>('exportData', 'reportHtml', { report: table, lang });
        setHtmlPreview(html);
      } catch (err) {
        toast('error', err instanceof ApiError ? err.messageBn : String(err));
      } finally {
        setLoading(false);
      }
    },
    [range, lang, toast],
  );

  useEffect(() => {
    void run(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, range.from, range.to]);

  const groups = useMemo(() => {
    const map = new Map<CatalogEntry['group'], CatalogEntry[]>();
    for (const entry of catalog) {
      const list = map.get(entry.group) ?? [];
      list.push(entry);
      map.set(entry.group, list);
    }
    return Array.from(map.entries());
  }, [catalog]);

  const fileName = `${report?.key ?? selected}-${range.from}-to-${range.to}`;

  const exportReport = async (kind: 'reportCsv' | 'reportXlsx' | 'reportPdf') => {
    if (!report) return;
    try {
      const result = await call<{ canceled?: boolean; path?: string }>('exportData', kind, {
        report,
        fileName,
      });
      if (result.canceled) return;
      toast('success', `${t('saved')}: ${result.path ?? ''}`);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const printReport = async () => {
    if (!htmlPreview) return;
    try {
      const result = await call<{ ok: boolean; reason?: string }>('printing', 'printHtml', {
        html: htmlPreview,
        silent: false,
      });
      if (!result.ok) toast('warning', result.reason ?? 'Print cancelled');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={t('reportTitle')}
        subtitle={lang === 'bn' ? 'খতিয়ান ও স্টক থেকে সরাসরি তৈরি রিপোর্ট' : 'Reports computed straight from the ledger and stock tables'}
        actions={
          <>
            <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
            <Button onClick={() => void run(selected)}>{t('reportGenerate')}</Button>
          </>
        }
      />

      <div className="grid" style={{ gridTemplateColumns: '260px minmax(0, 1fr)' }}>
        <Card title={lang === 'bn' ? 'রিপোর্ট তালিকা' : 'Report list'} bodyClass="tight">
          <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
            {groups.map(([group, entries]) => (
              <div key={group}>
                <div className="small muted" style={{ padding: '8px 8px 4px', fontWeight: 600 }}>
                  {lang === 'bn' ? GROUP_LABEL[group].bn : GROUP_LABEL[group].en}
                </div>
                {entries.map((entry) => (
                  <button
                    key={entry.key}
                    className={`nav-item ${selected === entry.key ? 'active' : ''}`}
                    style={{
                      color: 'inherit',
                      background: selected === entry.key ? 'var(--brand-100)' : 'transparent',
                      padding: '7px 8px',
                      fontSize: 'var(--text-sm)',
                    }}
                    onClick={() => setSelected(entry.key)}
                  >
                    <span>{lang === 'bn' ? entry.titleBn : entry.title}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Card>

        <Card
          title={report ? (lang === 'bn' ? report.titleBn : report.title) : t('reportTitle')}
          actions={
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" onClick={() => setShowHtml((v) => !v)}>
                {showHtml ? (lang === 'bn' ? 'ডাটা' : 'Data') : t('preview')}
              </Button>
              <Button size="sm" onClick={() => void exportReport('reportCsv')} disabled={!report}>
                {t('exportCsv')}
              </Button>
              <Button size="sm" onClick={() => void exportReport('reportXlsx')} disabled={!report}>
                {t('exportXlsx')}
              </Button>
              <Button size="sm" onClick={() => void exportReport('reportPdf')} disabled={!report}>
                {t('exportPdf')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void printReport()} disabled={!report}>
                {t('print')}
              </Button>
            </div>
          }
          bodyClass="tight"
        >
          {loading ? (
            <Spinner label={t('loading')} />
          ) : !report ? (
            <EmptyState title={t('noData')} />
          ) : showHtml ? (
            <div className="report-frame">
              <iframe title="report" srcDoc={htmlPreview} />
            </div>
          ) : report.rows.length === 0 ? (
            <EmptyState
              title={lang === 'bn' ? 'এই সময়ে কোনো তথ্য নেই' : 'No data for this period'}
              hint={lang === 'bn' ? 'তারিখের পরিসর বদলে দেখুন।' : 'Try a different date range.'}
            />
          ) : (
            <div className="table-wrap" style={{ maxHeight: '62vh' }}>
              <table className="table">
                <thead>
                  <tr>
                    {report.columns.map((c) => (
                      <th key={c.key} className={c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : ''}>
                        {lang === 'bn' ? c.labelBn : c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, index) => (
                    <tr key={index}>
                      {report.columns.map((c) => (
                        <td
                          key={c.key}
                          className={
                            c.type === 'money' || c.type === 'qty' || c.type === 'int'
                              ? 'money'
                              : c.align === 'center'
                                ? 'center'
                                : ''
                          }
                        >
                          {renderCell(row[c.key], c.type)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {report.totals ? (
                  <tfoot>
                    <tr>
                      {report.columns.map((c, index) => (
                        <td
                          key={c.key}
                          className={c.type === 'money' || c.type === 'qty' || c.type === 'int' ? 'money' : ''}
                        >
                          {index === 0
                            ? t('total')
                            : renderCell(report.totals?.[c.key] ?? null, c.type)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          )}
          <div className="row between" style={{ padding: '8px 12px' }}>
            <span className="small muted">
              {report ? `${report.rows.length} ${lang === 'bn' ? 'সারি' : 'rows'}` : ''}
            </span>
            {report?.meta ? (
              <span className="row small muted" style={{ gap: 8 }}>
                {Object.entries(report.meta)
                  .slice(0, 4)
                  .map(([key, value]) => (
                    <span key={key}>
                      <Badge>{key}</Badge> {String(value)}
                    </span>
                  ))}
              </span>
            ) : null}
          </div>
        </Card>
      </div>
    </>
  );
}
