/**
 * Customers and suppliers — one screen, two modes.
 *
 * Balances shown here are derived from the receivable/payable control accounts
 * (never from a stored running total), so a statement opened from this list is
 * guaranteed to agree with the ledger it came from.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  Card,
  DataTable,
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
  Badge,
} from '../components';
import { formatPaisa } from '../../core/foundation/money';
import { PAYMENT_METHODS } from '../../core/accounting/accounts';

interface Party {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  status: string;
  balance: number;
  credit_limit?: number;
}

interface ListResult {
  rows: Party[];
  total: number;
  page: number;
  totalPages: number;
}

interface LedgerLine {
  entry_id: string;
  entry_no: number;
  at: string;
  biz_date: string;
  memo: string;
  debit: number;
  credit: number;
  balance: number;
  source_type: string;
}

interface Statement {
  lines: LedgerLine[];
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
}

export function PartiesScreen({ kind }: { kind: 'customer' | 'supplier' }): JSX.Element {
  const { t, lang, toast } = useUi();
  const isCustomer = kind === 'customer';
  const [search, setSearch] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{
    id?: string;
    name: string;
    phone: string;
    address: string;
    code: string;
    note: string;
    creditLimit: number;
  } | null>(null);
  const [statement, setStatement] = useState<{ party: Party; data: Statement } | null>(null);
  const [payOpen, setPayOpen] = useState<Party | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('cash');
  const [saving, setSaving] = useState(false);

  const listMethod = isCustomer ? 'customers' : 'suppliers';
  const createMethod = isCustomer ? 'createCustomer' : 'createSupplier';
  const updateMethod = isCustomer ? 'updateCustomer' : 'updateSupplier';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<ListResult>('parties', listMethod, {
        search: search || undefined,
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
  }, [listMethod, search, dueOnly, page, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    if (form.name.trim() === '') {
      toast('warning', lang === 'bn' ? 'নাম দিন।' : 'Name is required.');
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        code: form.code.trim() || null,
        note: form.note.trim() || null,
      };
      if (isCustomer) payload.creditLimit = form.creditLimit;
      if (form.id) {
        await call('parties', updateMethod, { id: form.id, patch: payload });
      } else {
        await call('parties', createMethod, payload);
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

  const openStatement = async (party: Party) => {
    try {
      const result = await call<Statement>(
        'parties',
        isCustomer ? 'customerStatement' : 'supplierStatement',
        { id: party.id },
      );
      setStatement({ party, data: result });
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const submitPayment = async () => {
    if (!payOpen) return;
    if (payAmount <= 0) {
      toast('warning', lang === 'bn' ? 'টাকার পরিমাণ দিন।' : 'Enter an amount.');
      return;
    }
    try {
      if (isCustomer) {
        await call('payments', 'receiveFromCustomer', {
          customerId: payOpen.id,
          amount: payAmount,
          method: payMethod,
        });
      } else {
        await call('payments', 'paySupplier', {
          supplierId: payOpen.id,
          amount: payAmount,
          method: payMethod,
        });
      }
      toast('success', lang === 'bn' ? 'লেনদেন সংরক্ষিত হয়েছে।' : 'Transaction recorded.');
      setPayOpen(null);
      setPayAmount(0);
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn || err.message : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={isCustomer ? t('navCustomers') : t('navSuppliers')}
        subtitle={
          isCustomer
            ? lang === 'bn'
              ? 'গ্রাহকের বাকি, খতিয়ান ও পেমেন্ট'
              : 'Customer dues, statements and receipts'
            : lang === 'bn'
              ? 'সরবরাহকারীর পাওনা, খতিয়ান ও পরিশোধ'
              : 'Supplier payables, statements and payments'
        }
        actions={
          <>
            <Button onClick={() => void load()}>{t('refresh')}</Button>
            <Button
              variant="primary"
              onClick={() =>
                setForm({ name: '', phone: '', address: '', code: '', note: '', creditLimit: 0 })
              }
            >
              + {isCustomer ? lang === 'bn' ? 'নতুন গ্রাহক' : 'New customer' : lang === 'bn' ? 'নতুন সরবরাহকারী' : 'New supplier'}
            </Button>
          </>
        }
      />

      <Card bodyClass="tight">
        <div className="row wrap" style={{ padding: 8, gap: 8 }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <SearchInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={lang === 'bn' ? 'নাম, মোবাইল বা কোড' : 'Name, mobile or code'}
            />
          </div>
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
              keyOf={(p) => p.id}
              onRowClick={(p) => void openStatement(p)}
              empty={
                <EmptyState
                  title={t('noData')}
                  hint={
                    isCustomer
                      ? lang === 'bn'
                        ? 'নতুন গ্রাহক যোগ করুন।'
                        : 'Add your first customer.'
                      : lang === 'bn'
                        ? 'নতুন সরবরাহকারী যোগ করুন।'
                        : 'Add your first supplier.'
                  }
                />
              }
              columns={[
                { key: 'code', header: lang === 'bn' ? 'কোড' : 'Code', render: (p) => <span className="mono small">{p.code}</span> },
                { key: 'name', header: t('name'), render: (p) => <span className="strong">{p.name}</span> },
                { key: 'phone', header: t('phone'), render: (p) => <span className="small">{p.phone ?? '—'}</span> },
                {
                  key: 'balance',
                  header: isCustomer ? t('due') : lang === 'bn' ? 'পাওনা' : 'Payable',
                  align: 'right',
                  render: (p) => (
                    <span className={p.balance > 0 ? 'mono text-warning strong' : 'mono'}>
                      {formatPaisa(p.balance)}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: t('status'),
                  render: (p) =>
                    p.status === 'active' ? (
                      <Badge tone="success">{lang === 'bn' ? 'সক্রিয়' : 'Active'}</Badge>
                    ) : (
                      <Badge>{lang === 'bn' ? 'আর্কাইভ' : 'Archived'}</Badge>
                    ),
                },
                {
                  key: 'actions',
                  header: t('actions'),
                  align: 'right',
                  render: (p) => (
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        onClick={() =>
                          setForm({
                            id: p.id,
                            name: p.name,
                            phone: p.phone ?? '',
                            address: p.address ?? '',
                            code: p.code,
                            note: p.note ?? '',
                            creditLimit: p.credit_limit ?? 0,
                          })
                        }
                      >
                        {t('edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setPayOpen(p);
                          setPayAmount(Math.max(0, p.balance));
                        }}
                      >
                        {isCustomer ? t('receivePayment') : t('paySupplier')}
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
          title={form.id ? t('edit') : isCustomer ? lang === 'bn' ? 'নতুন গ্রাহক' : 'New customer' : lang === 'bn' ? 'নতুন সরবরাহকারী' : 'New supplier'}
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
            <Field label={t('name')} required className="span-2">
              <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t('phone')}>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="01XXXXXXXXX" />
            </Field>
            <Field label={lang === 'bn' ? 'কোড' : 'Code'} hint={lang === 'bn' ? 'খালি রাখলে স্বয়ংক্রিয়' : 'Auto-generated if blank'}>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label={t('address')} className="span-2">
              <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            {isCustomer ? (
              <Field label={lang === 'bn' ? 'বাকির সীমা' : 'Credit limit'}>
                <MoneyInput valuePaisa={form.creditLimit} onChange={(v) => setForm({ ...form, creditLimit: v })} />
              </Field>
            ) : null}
            <Field label={t('note')}>
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {statement ? (
        <Modal
          title={`${lang === 'bn' ? 'খতিয়ান' : 'Statement'} · ${statement.party.name}`}
          onClose={() => setStatement(null)}
          wide
          footer={<Button onClick={() => setStatement(null)}>{t('close')}</Button>}
        >
          <div className="stack">
            <div className="summary-strip">
              <div className="item">
                <div className="label">{lang === 'bn' ? 'প্রারম্ভিক' : 'Opening'}</div>
                <div className="value">{formatPaisa(statement.data.openingBalance)}</div>
              </div>
              <div className="item">
                <div className="label">{lang === 'bn' ? 'ডেবিট' : 'Debit'}</div>
                <div className="value">{formatPaisa(statement.data.totalDebit)}</div>
              </div>
              <div className="item">
                <div className="label">{lang === 'bn' ? 'ক্রেডিট' : 'Credit'}</div>
                <div className="value">{formatPaisa(statement.data.totalCredit)}</div>
              </div>
              <div className="item">
                <div className="label">{lang === 'bn' ? 'সমাপনী' : 'Closing'}</div>
                <div className="value">{formatPaisa(statement.data.closingBalance)}</div>
              </div>
            </div>
            <DataTable
              rows={statement.data.lines}
              keyOf={(l) => l.entry_id + l.balance}
              empty={<EmptyState title={t('noData')} />}
              columns={[
                { key: 'date', header: t('date'), render: (l) => <span className="small">{l.biz_date}</span> },
                { key: 'memo', header: lang === 'bn' ? 'বিবরণ' : 'Description', render: (l) => <span className="truncate">{l.memo}</span> },
                { key: 'debit', header: lang === 'bn' ? 'ডেবিট' : 'Debit', align: 'right', render: (l) => <Money paisa={l.debit} /> },
                { key: 'credit', header: lang === 'bn' ? 'ক্রেডিট' : 'Credit', align: 'right', render: (l) => <Money paisa={l.credit} /> },
                { key: 'balance', header: lang === 'bn' ? 'স্থিতি' : 'Balance', align: 'right', render: (l) => <Money paisa={l.balance} /> },
              ]}
            />
          </div>
        </Modal>
      ) : null}

      {payOpen ? (
        <Modal
          title={`${isCustomer ? t('receivePayment') : t('paySupplier')} · ${payOpen.name}`}
          onClose={() => setPayOpen(null)}
          footer={
            <>
              <Button onClick={() => setPayOpen(null)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => void submitPayment()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="summary-strip">
              <div className="item">
                <div className="label">{isCustomer ? t('due') : lang === 'bn' ? 'পাওনা' : 'Payable'}</div>
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
            <div className="small muted">
              {isCustomer
                ? lang === 'bn'
                  ? 'টাকা স্বয়ংক্রিয়ভাবে সবচেয়ে পুরনো বাকি ইনভয়েস থেকে সমন্বয় হবে।'
                  : 'Payment is allocated to the oldest outstanding invoices first.'
                : lang === 'bn'
                  ? 'পরিশোধ সবচেয়ে পুরনো ক্রয় থেকে সমন্বয় হবে।'
                  : 'Payment settles the oldest purchases first.'}
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
