/**
 * Expenses: rent, salary, transport, utilities and so on.
 * Editing never rewrites history — the server reverses and reposts — so this
 * screen simply offers "edit" and "void" and then reloads the list.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  Card,
  ConfirmDialog,
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
} from '../components';
import { formatPaisa } from '../../core/foundation/money';
import { PAYMENT_METHODS } from '../../core/accounting/accounts';

interface ExpenseRow {
  id: string;
  voucher_no: string;
  at: string;
  biz_date: string;
  category_id: string;
  amount: number;
  method: string;
  payee: string | null;
  note: string | null;
  category_name: string | null;
}

interface Category {
  id: string;
  name: string;
  name_bn: string | null;
}

interface ListResult {
  rows: ExpenseRow[];
  total: number;
  page: number;
  totalPages: number;
  totalAmount: number;
}

export function ExpensesScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const [range, setRange] = useState(() => {
    const d = new Date();
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10), to: today() };
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{
    id?: string;
    categoryId: string;
    amount: number;
    method: string;
    payee: string;
    note: string;
  } | null>(null);
  const [voidTarget, setVoidTarget] = useState<ExpenseRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [newCategory, setNewCategory] = useState<{ name: string; nameBn: string; accountCode: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<ListResult>('expenses', 'list', {
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

  const loadCategories = useCallback(() => {
    void call<Category[]>('expenses', 'categories')
      .then(setCategories)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const save = async () => {
    if (!form) return;
    if (!form.categoryId) {
      toast('warning', lang === 'bn' ? 'খরচের ধরন নির্বাচন করুন।' : 'Select an expense category.');
      return;
    }
    if (form.amount <= 0) {
      toast('warning', lang === 'bn' ? 'টাকার পরিমাণ দিন।' : 'Enter an amount.');
      return;
    }
    setSaving(true);
    try {
      if (form.id) {
        await call('expenses', 'update', {
          id: form.id,
          patch: {
            categoryId: form.categoryId,
            amount: form.amount,
            method: form.method,
            payee: form.payee || null,
            note: form.note || null,
          },
        });
      } else {
        await call('expenses', 'create', {
          categoryId: form.categoryId,
          amount: form.amount,
          method: form.method,
          payee: form.payee || null,
          note: form.note || null,
        });
      }
      toast('success', t('saved'));
      setForm(null);
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn || err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const doVoid = async () => {
    if (!voidTarget) return;
    if (voidReason.trim() === '') {
      toast('warning', lang === 'bn' ? 'কারণ লিখুন।' : 'A reason is required.');
      return;
    }
    try {
      await call('expenses', 'void', { id: voidTarget.id, reason: voidReason.trim() });
      toast('success', lang === 'bn' ? 'খরচ বাতিল হয়েছে।' : 'Expense voided.');
      setVoidTarget(null);
      setVoidReason('');
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const saveCategory = async () => {
    if (!newCategory) return;
    try {
      await call('expenses', 'createCategory', newCategory);
      toast('success', t('saved'));
      setNewCategory(null);
      loadCategories();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={t('navExpenses')}
        subtitle={lang === 'bn' ? 'দৈনন্দিন খরচের ভাউচার' : 'Day-to-day expense vouchers'}
        actions={
          <>
            <DateRangePicker from={range.from} to={range.to} onChange={setRange} />
            <Button onClick={() => setNewCategory({ name: '', nameBn: '', accountCode: '5100' })}>
              + {lang === 'bn' ? 'নতুন খরচের ধরন' : 'New category'}
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                setForm({
                  categoryId: categories[0]?.id ?? '',
                  amount: 0,
                  method: 'cash',
                  payee: '',
                  note: '',
                })
              }
              disabled={categories.length === 0}
            >
              + {t('newExpense')}
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
              placeholder={lang === 'bn' ? 'ভাউচার নম্বর, প্রাপক বা মন্তব্য' : 'Voucher number, payee or note'}
            />
          </div>
          <div className="summary-strip" style={{ border: 0, background: 'transparent' }}>
            <div className="item">
              <div className="label">{lang === 'bn' ? 'মোট খরচ' : 'Total expenses'}</div>
              <div className="value">{formatPaisa(data?.totalAmount ?? 0)}</div>
            </div>
          </div>
        </div>

        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <DataTable
              rows={data?.rows ?? []}
              keyOf={(r) => r.id}
              empty={
                <EmptyState
                  title={lang === 'bn' ? 'এই সময়ে কোনো খরচ নেই' : 'No expenses in this period'}
                  hint={lang === 'bn' ? 'নতুন খরচ যোগ করুন।' : 'Record an expense to see it here.'}
                />
              }
              columns={[
                { key: 'no', header: t('voucherNo'), render: (r) => <span className="mono small">{r.voucher_no}</span> },
                { key: 'date', header: t('date'), render: (r) => <span className="small">{r.biz_date}</span> },
                { key: 'category', header: t('expenseCategory'), render: (r) => r.category_name ?? '—' },
                { key: 'payee', header: t('payee'), render: (r) => <span className="small">{r.payee ?? '—'}</span> },
                {
                  key: 'method',
                  header: t('posPayment'),
                  render: (r) =>
                    PAYMENT_METHODS.find((m) => m.key === r.method)?.[lang === 'bn' ? 'nameBn' : 'name'] ?? r.method,
                },
                { key: 'amount', header: t('amount'), align: 'right', render: (r) => <Money paisa={r.amount} /> },
                {
                  key: 'actions',
                  header: t('actions'),
                  align: 'right',
                  render: (r) => (
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      <Button
                        size="sm"
                        onClick={() =>
                          setForm({
                            id: r.id,
                            categoryId: r.category_id,
                            amount: r.amount,
                            method: r.method,
                            payee: r.payee ?? '',
                            note: r.note ?? '',
                          })
                        }
                      >
                        {t('edit')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setVoidTarget(r)}>
                        {t('void')}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
            {data && data.total > 0 ? (
              <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />
            ) : null}
          </>
        )}
      </Card>

      {form ? (
        <Modal
          title={form.id ? t('edit') : t('newExpense')}
          onClose={() => setForm(null)}
          footer={
            <>
              <Button onClick={() => setForm(null)}>{t('cancel')}</Button>
              <Button variant="primary" loading={saving} onClick={() => void save()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label={t('expenseCategory')} required>
              <Select
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                options={categories.map((c) => ({
                  value: c.id,
                  label: lang === 'bn' && c.name_bn ? c.name_bn : c.name,
                }))}
              />
            </Field>
            <Field label={t('amount')} required>
              <MoneyInput valuePaisa={form.amount} onChange={(v) => setForm({ ...form, amount: v })} autoFocus />
            </Field>
            <Field label={t('posPayment')}>
              <Select
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value })}
                options={PAYMENT_METHODS.map((m) => ({ value: m.key, label: lang === 'bn' ? m.nameBn : m.name }))}
              />
            </Field>
            <Field label={t('payee')}>
              <Input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} />
            </Field>
            <Field label={t('note')} className="span-2">
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
          </div>
          {form.id ? (
            <div className="alert info" style={{ marginTop: 12 }}>
              {lang === 'bn'
                ? 'সম্পাদনা করলে মূল ভাউচারটি বিপরীত হয়ে নতুন এন্ট্রি তৈরি হবে — অডিট ট্রেইল অক্ষত থাকবে।'
                : 'Editing reverses the original voucher and posts a corrected one, keeping the audit trail intact.'}
            </div>
          ) : null}
        </Modal>
      ) : null}

      {voidTarget ? (
        <ConfirmDialog
          title={`${t('void')} · ${voidTarget.voucher_no}`}
          message={
            lang === 'bn'
              ? 'বাতিল করলে একটি বিপরীত জার্নাল তৈরি হবে। ভাউচার রেকর্ডে থাকবে।'
              : 'Voiding posts a reversing journal; the voucher stays in the record.'
          }
          confirmLabel={t('void')}
          dangerous
          onConfirm={() => void doVoid()}
          onCancel={() => setVoidTarget(null)}
        >
          <Field label={t('voidReason')} required>
            <Input autoFocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          </Field>
        </ConfirmDialog>
      ) : null}

      {newCategory ? (
        <Modal
          title={lang === 'bn' ? 'নতুন খরচের ধরন' : 'New expense category'}
          onClose={() => setNewCategory(null)}
          footer={
            <>
              <Button onClick={() => setNewCategory(null)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => void saveCategory()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label={t('name')} required>
              <Input autoFocus value={newCategory.name} onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })} />
            </Field>
            <Field label={lang === 'bn' ? 'বাংলা নাম' : 'Bengali name'}>
              <Input value={newCategory.nameBn} onChange={(e) => setNewCategory({ ...newCategory, nameBn: e.target.value })} />
            </Field>
            <Field
              label={lang === 'bn' ? 'খতিয়ান কোড' : 'Ledger account code'}
              hint={lang === 'bn' ? 'যেমন ৫১০০ (পরিচালন ব্যয়)' : 'e.g. 5100 (operating expense)'}
            >
              <Input
                value={newCategory.accountCode}
                onChange={(e) => setNewCategory({ ...newCategory, accountCode: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
