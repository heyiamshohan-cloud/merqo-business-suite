/**
 * Products & stock.
 *
 * One screen for the catalogue and its stock consequences: create/edit items,
 * add opening stock, record adjustments, and see the ledger-backed quantity and
 * valuation. Archiving is used instead of deletion once a product has history.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
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
} from '../components';
import { formatPaisa, formatQty, toPaisa, toQtyMilli } from '../../core/foundation/money';

interface Product {
  id: string;
  sku: string;
  name: string;
  name_bn: string | null;
  category_id: string | null;
  brand_id: string | null;
  unit_id: string | null;
  category_name: string | null;
  brand_name: string | null;
  unit_short: string | null;
  unit_allow_decimal: number;
  purchase_price: number;
  sale_price: number;
  wholesale_price: number;
  min_stock: number;
  tax_rate_bp: number;
  track_stock: number;
  status: string;
  stock_qty: number;
  stock_value: number;
  barcode_list: string | null;
}

interface Option {
  id: string;
  name: string;
  short_name?: string;
}

interface Page {
  rows: Product[];
  total: number;
  page: number;
  totalPages: number;
}

interface FormState {
  id?: string;
  name: string;
  nameBn: string;
  sku: string;
  categoryId: string;
  brandId: string;
  unitId: string;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice: number;
  minStock: string;
  taxRate: string;
  barcodes: string;
  openingQty: string;
}

const emptyForm = (unitId: string): FormState => ({
  name: '',
  nameBn: '',
  sku: '',
  categoryId: '',
  brandId: '',
  unitId,
  purchasePrice: 0,
  salePrice: 0,
  wholesalePrice: 0,
  minStock: '0',
  taxRate: '0',
  barcodes: '',
  openingQty: '',
});

export function ProductsScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [categories, setCategories] = useState<Option[]>([]);
  const [brands, setBrands] = useState<Option[]>([]);
  const [units, setUnits] = useState<Option[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [stockAction, setStockAction] = useState<{ product: Product; mode: 'opening' | 'adjust' } | null>(null);
  const [stockQty, setStockQty] = useState('');
  const [stockReason, setStockReason] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<Page>('catalog', 'search', {
        search: query,
        categoryId: categoryId || null,
        status,
        lowStock: lowOnly || undefined,
        page,
        pageSize: 25,
        sortBy: 'name',
        sortDir: 'asc',
      });
      setData(result);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    } finally {
      setLoading(false);
    }
  }, [query, categoryId, status, lowOnly, page, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void Promise.all([
      call<Array<Option & { product_count: number }>>('catalog', 'categories', { includeArchived: false }),
      call<Option[]>('catalog', 'brands'),
      call<Option[]>('catalog', 'units'),
    ])
      .then(([cats, brandList, unitList]) => {
        setCategories(cats);
        setBrands(brandList);
        setUnits(unitList);
      })
      .catch(() => undefined);
  }, []);

  const openCreate = () =>
    setForm({ ...emptyForm(units[0]?.id ?? ''), sku: '' });

  const openEdit = (p: Product) => {
    setForm({
      id: p.id,
      name: p.name,
      nameBn: p.name_bn ?? '',
      sku: p.sku,
      categoryId: p.category_id ?? '',
      brandId: p.brand_id ?? '',
      unitId: p.unit_id ?? '',
      purchasePrice: p.purchase_price,
      salePrice: p.sale_price,
      wholesalePrice: p.wholesale_price,
      minStock: String(p.min_stock),
      taxRate: (p.tax_rate_bp / 100).toString(),
      barcodes: p.barcode_list ?? '',
      openingQty: '',
    });
  };

  const save = async () => {
    if (!form) return;
    setFormError(null);
    if (form.name.trim() === '') {
      setFormError(lang === 'bn' ? 'পণ্যের নাম দিন।' : 'Product name is required.');
      return;
    }
    if (form.salePrice <= 0) {
      setFormError(lang === 'bn' ? 'বিক্রয়মূল্য শূন্যের বেশি হতে হবে।' : 'Sale price must be greater than zero.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        nameBn: form.nameBn.trim() || null,
        sku: form.sku.trim() || null,
        categoryId: form.categoryId || null,
        brandId: form.brandId || null,
        unitId: form.unitId || null,
        purchasePrice: form.purchasePrice,
        salePrice: form.salePrice,
        wholesalePrice: form.wholesalePrice,
        minStock: Number(form.minStock) || 0,
        taxRateBp: Math.round((Number(form.taxRate) || 0) * 100),
        barcodes: form.barcodes
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (form.id) {
        await call('catalog', 'update', { id: form.id, patch: payload });
        toast('success', lang === 'bn' ? 'পণ্য হালনাগাদ হয়েছে।' : 'Product updated.');
      } else {
        await call('catalog', 'create', {
          ...payload,
          openingQty: form.openingQty.trim() === '' ? 0 : form.openingQty.trim(),
        });
        toast('success', lang === 'bn' ? 'পণ্য যোগ হয়েছে।' : 'Product created.');
      }
      setForm(null);
      void load();
    } catch (err) {
      const message = err instanceof ApiError ? err.messageBn || err.message : String(err);
      setFormError(message);
      toast('error', message);
    } finally {
      setSaving(false);
    }
  };

  const submitStock = async () => {
    if (!stockAction) return;
    const qty = Number(stockQty);
    if (!Number.isFinite(qty) || qty < 0) {
      toast('warning', lang === 'bn' ? 'সঠিক পরিমাণ দিন।' : 'Enter a valid quantity.');
      return;
    }
    try {
      if (stockAction.mode === 'opening') {
        await call('inventory', 'openingStock', {
          productId: stockAction.product.id,
          // Quantities cross the IPC boundary in milli-units, like everywhere
          // else in the core, so 1.5 kg is 1500 and never a float.
          qty: Math.round(qty * 1000),
          unitCost: stockAction.product.purchase_price,
          note: stockReason || 'Opening stock',
        });
        toast('success', lang === 'bn' ? 'প্রারম্ভিক স্টক যোগ হয়েছে।' : 'Opening stock recorded.');
      } else {
        await call('inventory', 'adjust', {
          productId: stockAction.product.id,
          newQty: Math.round(qty * 1000),
          reason: stockReason || 'Stock adjustment',
        });
        toast('success', lang === 'bn' ? 'স্টক সমন্বয় হয়েছে।' : 'Stock adjusted.');
      }
      setStockAction(null);
      setStockQty('');
      setStockReason('');
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn || err.message : String(err));
    }
  };

  const toggleArchive = async () => {
    if (!archiveTarget) return;
    try {
      if (archiveTarget.status === 'active') {
        await call('catalog', 'archive', { id: archiveTarget.id });
        toast('success', lang === 'bn' ? 'পণ্য আর্কাইভ হয়েছে।' : 'Product archived.');
      } else {
        await call('catalog', 'restore', { id: archiveTarget.id });
        toast('success', lang === 'bn' ? 'পণ্য পুনরুদ্ধার হয়েছে।' : 'Product restored.');
      }
      setArchiveTarget(null);
      void load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  return (
    <>
      <PageHeader
        title={t('navProducts')}
        subtitle={
          lang === 'bn'
            ? 'পণ্যের তালিকা, মূল্য ও স্টক ব্যবস্থাপনা'
            : 'Catalogue, pricing and stock management'
        }
        actions={
          <>
            <Button onClick={() => void load()}>{t('refresh')}</Button>
            <Button variant="primary" onClick={openCreate}>
              + {t('addProduct')}
            </Button>
          </>
        }
      />

      <Card bodyClass="tight">
        <div className="row wrap" style={{ padding: 8, gap: 8 }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <SearchInput
              value={query}
              onChange={(v) => {
                setQuery(v);
                setPage(1);
              }}
              placeholder={lang === 'bn' ? 'নাম, এসকেইউ বা বারকোড দিয়ে খুঁজুন' : 'Search by name, SKU or barcode'}
            />
          </div>
          <Select
            style={{ width: 180 }}
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
            options={[
              { value: '', label: lang === 'bn' ? 'সব ক্যাটাগরি' : 'All categories' },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <Select
            style={{ width: 130 }}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            options={[
              { value: 'active', label: lang === 'bn' ? 'সক্রিয়' : 'Active' },
              { value: 'archived', label: lang === 'bn' ? 'আর্কাইভ' : 'Archived' },
              { value: 'all', label: t('all') },
            ]}
          />
          <Button variant={lowOnly ? 'primary' : 'secondary'} onClick={() => setLowOnly((v) => !v)}>
            {t('dashboardLowStock')}
          </Button>
        </div>

        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            <DataTable
              rows={data?.rows ?? []}
              keyOf={(p) => p.id}
              empty={
                <div className="table-empty">
                  <div className="title">{t('noData')}</div>
                  <div className="small">{t('noDataHint')}</div>
                </div>
              }
              columns={[
                {
                  key: 'name',
                  header: t('productName'),
                  render: (p) => (
                    <div>
                      <div className="strong">{lang === 'bn' && p.name_bn ? p.name_bn : p.name}</div>
                      <div className="small muted">{p.sku}</div>
                    </div>
                  ),
                },
                {
                  key: 'category',
                  header: t('category'),
                  render: (p) => <span className="small">{p.category_name ?? '—'}</span>,
                },
                {
                  key: 'stock',
                  header: t('stock'),
                  align: 'right',
                  render: (p) => (
                    <span className={p.stock_qty <= 0 ? 'text-danger mono' : 'mono'}>
                      {formatQty(p.stock_qty)} {p.unit_short ?? ''}
                    </span>
                  ),
                },
                {
                  key: 'purchase',
                  header: t('purchasePrice'),
                  align: 'right',
                  render: (p) => <Money paisa={p.purchase_price} />,
                },
                {
                  key: 'sale',
                  header: t('salePrice'),
                  align: 'right',
                  render: (p) => <span className="mono strong">{formatPaisa(p.sale_price)}</span>,
                },
                {
                  key: 'value',
                  header: lang === 'bn' ? 'স্টক মূল্য' : 'Stock value',
                  align: 'right',
                  render: (p) => <Money paisa={p.stock_value} />,
                },
                {
                  key: 'status',
                  header: t('status'),
                  render: (p) =>
                    p.status === 'active' ? (
                      p.stock_qty <= 0 ? (
                        <span className="badge danger">{t('dashboardOutOfStock')}</span>
                      ) : p.min_stock > 0 && p.stock_qty <= p.min_stock * 1000 ? (
                        <span className="badge warning">{t('dashboardLowStock')}</span>
                      ) : (
                        <span className="badge success">{lang === 'bn' ? 'সক্রিয়' : 'Active'}</span>
                      )
                    ) : (
                      <span className="badge">{lang === 'bn' ? 'আর্কাইভ' : 'Archived'}</span>
                    ),
                },
                {
                  key: 'actions',
                  header: t('actions'),
                  align: 'right',
                  render: (p) => (
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      <Button size="sm" onClick={() => openEdit(p)}>
                        {t('edit')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setStockAction({ product: p, mode: 'opening' });
                          setStockQty('');
                        }}
                      >
                        {lang === 'bn' ? 'ওপেনিং' : 'Opening'}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setStockAction({ product: p, mode: 'adjust' });
                          setStockQty((p.stock_qty / 1000).toString());
                        }}
                      >
                        {lang === 'bn' ? 'সমন্বয়' : 'Adjust'}
                      </Button>
                      <Button size="sm" variant={p.status === 'active' ? 'ghost' : 'secondary'} onClick={() => setArchiveTarget(p)}>
                        {p.status === 'active' ? t('archive') : lang === 'bn' ? 'ফিরিয়ে আনুন' : 'Restore'}
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
          title={form.id ? t('edit') : t('addProduct')}
          onClose={() => setForm(null)}
          wide
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
            <Field label={t('productName')} required className="span-2">
              <Input
                value={form.name}
                autoFocus
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Miniket Rice 5kg"
              />
            </Field>
            <Field label={t('productNameBn')}>
              <Input value={form.nameBn} onChange={(e) => setForm({ ...form, nameBn: e.target.value })} placeholder="মিনিকেট চাল ৫ কেজি" />
            </Field>
            <Field label={t('sku')} hint={lang === 'bn' ? 'খালি রাখলে স্বয়ংক্রিয়ভাবে তৈরি হবে' : 'Leave blank to auto-generate'}>
              <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </Field>
            <Field label={t('category')}>
              <Select
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                options={[{ value: '', label: '—' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
              />
            </Field>
            <Field label={t('brand')}>
              <Select
                value={form.brandId}
                onChange={(e) => setForm({ ...form, brandId: e.target.value })}
                options={[{ value: '', label: '—' }, ...brands.map((b) => ({ value: b.id, label: b.name }))]}
              />
            </Field>
            <Field label={t('unit')}>
              <Select
                value={form.unitId}
                onChange={(e) => setForm({ ...form, unitId: e.target.value })}
                options={units.map((u) => ({ value: u.id, label: `${u.name}${u.short_name ? ` (${u.short_name})` : ''}` }))}
              />
            </Field>
            <Field label={t('minStock')}>
              <Input
                className="num"
                value={form.minStock}
                onChange={(e) => setForm({ ...form, minStock: e.target.value })}
              />
            </Field>
            <Field label={t('purchasePrice')} required>
              <MoneyInput valuePaisa={form.purchasePrice} onChange={(v) => setForm({ ...form, purchasePrice: v })} />
            </Field>
            <Field label={t('salePrice')} required>
              <MoneyInput valuePaisa={form.salePrice} onChange={(v) => setForm({ ...form, salePrice: v })} />
            </Field>
            <Field label={t('wholesalePrice')}>
              <MoneyInput valuePaisa={form.wholesalePrice} onChange={(v) => setForm({ ...form, wholesalePrice: v })} />
            </Field>
            <Field label={t('taxRate')} hint={lang === 'bn' ? 'শুধু ভ্যাট চালু থাকলে প্রযোজ্য' : 'Applies when VAT is enabled'}>
              <Input className="num" value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />
            </Field>
            <Field label={t('barcode')} hint={lang === 'bn' ? 'একাধিক হলে কমা দিয়ে আলাদা করুন' : 'Comma-separate multiple codes'}>
              <Input value={form.barcodes} onChange={(e) => setForm({ ...form, barcodes: e.target.value })} />
            </Field>
            {!form.id ? (
              <Field
                label={t('openingStock')}
                hint={lang === 'bn' ? 'স্টকের মূল্য মূলধনে যাবে (খতিয়ানে স্বয়ংক্রিয় এন্ট্রি)' : 'Valued at purchase cost and posted to capital'}
              >
                <Input
                  className="num"
                  value={form.openingQty}
                  onChange={(e) => setForm({ ...form, openingQty: e.target.value })}
                  placeholder="0"
                />
              </Field>
            ) : null}
          </div>
          {formError ? (
            <div className="alert danger" style={{ marginTop: 12 }}>
              {formError}
            </div>
          ) : null}
        </Modal>
      ) : null}

      {stockAction ? (
        <Modal
          title={`${stockAction.mode === 'opening' ? t('openingStock') : t('adjustStock')} · ${stockAction.product.name}`}
          onClose={() => setStockAction(null)}
          footer={
            <>
              <Button onClick={() => setStockAction(null)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => void submitStock()}>
                {t('save')}
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="summary-strip">
              <div className="item">
                <div className="label">{lang === 'bn' ? 'বর্তমান স্টক' : 'Current stock'}</div>
                <div className="value">
                  {formatQty(stockAction.product.stock_qty)} {stockAction.product.unit_short ?? ''}
                </div>
              </div>
              <div className="item">
                <div className="label">{lang === 'bn' ? 'স্টক মূল্য' : 'Stock value'}</div>
                <div className="value">{formatPaisa(stockAction.product.stock_value)}</div>
              </div>
            </div>
            <Field
              label={stockAction.mode === 'opening' ? lang === 'bn' ? 'প্রারম্ভিক পরিমাণ' : 'Opening quantity' : t('newStockQty')}
              required
            >
              <Input
                className="num"
                autoFocus
                value={stockQty}
                onChange={(e) => setStockQty(e.target.value)}
              />
            </Field>
            <Field label={t('reason')}>
              <Input value={stockReason} onChange={(e) => setStockReason(e.target.value)} placeholder={lang === 'bn' ? 'যেমন: নতুন মাল এসেছে' : 'e.g. new delivery'} />
            </Field>
            {stockAction.mode === 'adjust' ? (
              <div className="small muted">
                {lang === 'bn'
                  ? 'সমন্বয়ের ফলে স্টকের মূল্য পরিবর্তন খতিয়ানে স্বয়ংক্রিয়ভাবে এন্ট্রি হবে।'
                  : 'The valuation change is posted to the ledger automatically.'}
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {archiveTarget ? (
        <ConfirmDialog
          title={archiveTarget.status === 'active' ? t('archive') : lang === 'bn' ? 'পুনরুদ্ধার' : 'Restore'}
          message={
            archiveTarget.status === 'active'
              ? lang === 'bn'
                ? `"${archiveTarget.name}" আর্কাইভ করলে নতুন বিক্রয়ে দেখা যাবে না, তবে পুরনো রেকর্ড অক্ষত থাকবে।`
                : `"${archiveTarget.name}" will be hidden from new sales but its history stays intact.`
              : lang === 'bn'
                ? `"${archiveTarget.name}" আবার সক্রিয় করবেন?`
                : `Restore "${archiveTarget.name}" to the active catalogue?`
          }
          confirmLabel={archiveTarget.status === 'active' ? t('archive') : t('confirm')}
          dangerous={archiveTarget.status === 'active'}
          onConfirm={() => void toggleArchive()}
          onCancel={() => setArchiveTarget(null)}
        />
      ) : null}
    </>
  );
}

/** Exposed for unit conversion helpers used in other screens. */
export const productHelpers = { toPaisa, toQtyMilli };
