/**
 * Point of Sale.
 *
 * Built for a counter workflow: keyboard-first, barcode-ready, and safe against
 * double-submits (every completed sale carries a client token, and the button
 * disables while the sale is in flight). Payment is sent as an amount in paisa,
 * never as a float; the server recomputes all totals, so what is stored is what
 * the accounting engine validated — not what the screen happened to display.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, ApiError } from '../api';
import {
  Button,
  EmptyState,
  Field,
  Modal,
  MoneyInput,
  SearchInput,
  Select,
  useUi,
} from '../components';
import { useApp } from '../App';
import { formatPaisa, formatQty } from '../../core/foundation/money';
import { PAYMENT_METHODS } from '../../core/accounting/accounts';

interface Product {
  id: string;
  sku: string;
  name: string;
  name_bn: string | null;
  sale_price: number;
  tax_rate_bp: number;
  unit_short: string | null;
  unit_allow_decimal: number;
  stock_qty: number;
  barcode_list: string | null;
}

interface CartLine {
  product: Product;
  qtyMilli: number;
  unitPrice: number;
  discount: number;
}

interface PricePreview {
  lines: Array<{ product: { id: string }; qty: number; unitPrice: number; lineTotal: number; tax: number }>;
  grossTotal: number;
  itemDiscount: number;
  invoiceDiscount: number;
  taxTotal: number;
  total: number;
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

interface SaleResult {
  invoiceId: string;
  invoiceNo: string;
  total: number;
  paid: number;
  due: number;
  profit: number;
  idempotentReplay: boolean;
}

const WALK_IN = 'walk-in';

export function PosScreen(): JSX.Element {
  const { t, lang, toast } = useUi();
  const { session, navigate } = useApp();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string>(WALK_IN);
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [invoiceDiscount, setInvoiceDiscount] = useState(0);
  const [method, setMethod] = useState('cash');
  const [paidInput, setPaidInput] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<{ invoiceId: string; html: string; invoiceNo: string } | null>(null);
  const [receiptHtml, setReceiptHtml] = useState<string>('');
  const [printLanguage, setPrintLanguage] = useState<'bn' | 'en'>(lang);
  const tokenRef = useRef<string>(crypto.randomUUID());

  const loadProducts = useCallback(
    async (term: string) => {
      try {
        const result = await call<{ rows: Product[] }>('catalog', 'search', {
          search: term,
          pageSize: 60,
          status: 'active',
        });
        setProducts(result.rows);
      } catch (err) {
        toast('error', err instanceof ApiError ? err.messageBn : String(err));
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadProducts('');
    void call<{ rows: Customer[] }>('parties', 'customers', { pageSize: 200 })
      .then((r) => setCustomers(r.rows))
      .catch(() => undefined);
  }, [loadProducts]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProducts(query), 180);
    return () => window.clearTimeout(timer);
  }, [query, loadProducts]);

  // Ask the server for authoritative totals whenever the cart changes.
  useEffect(() => {
    if (cart.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    call<PricePreview>('sales', 'price', {
      lines: cart.map((l) => ({
        productId: l.product.id,
        qty: (l.qtyMilli / 1000).toString(),
        unitPrice: l.unitPrice,
        discount: l.discount,
      })),
      invoiceDiscount,
    })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cart, invoiceDiscount]);

  const total = preview?.total ?? 0;
  const due = Math.max(0, total - paidInput);

  const addProduct = useCallback((product: Product) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === product.id);
      if (existing) {
        return prev.map((l) =>
          l.product.id === product.id ? { ...l, qtyMilli: l.qtyMilli + 1000 } : l,
        );
      }
      return [...prev, { product, qtyMilli: 1000, unitPrice: product.sale_price, discount: 0 }];
    });
    setQuery('');
    searchRef.current?.focus();
  }, []);

  const setQty = (productId: string, qtyMilli: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.product.id === productId ? { ...l, qtyMilli: Math.max(0, qtyMilli) } : l))
        .filter((l) => l.qtyMilli > 0),
    );
  };

  const removeLine = (productId: string) =>
    setCart((prev) => prev.filter((l) => l.product.id !== productId));

  const clearCart = () => {
    setCart([]);
    setInvoiceDiscount(0);
    setPaidInput(0);
    setCustomerId(WALK_IN);
    tokenRef.current = crypto.randomUUID();
  };

  const handleSearchKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = query.trim();
    if (!code) return;
    try {
      const found = await call<Product | null>('catalog', 'findByBarcode', { code });
      if (found) {
        addProduct(found);
        return;
      }
    } catch {
      /* fall through to exact-name handling */
    }
    if (products.length === 1) addProduct(products[0]);
  };

  const completeSale = async () => {
    if (cart.length === 0) {
      toast('warning', lang === 'bn' ? 'কার্ট খালি।' : 'Cart is empty.');
      return;
    }
    if (paidInput > 0 && paidInput > total) {
      toast('warning', lang === 'bn' ? 'পরিশোধিত টাকা মোটের চেয়ে বেশি।' : 'Paid amount exceeds the total.');
      return;
    }
    if (due > 0 && customerId === WALK_IN) {
      toast(
        'warning',
        lang === 'bn'
          ? 'বাকি বিক্রয়ের জন্য গ্রাহক নির্বাচন করুন।'
          : 'Select a customer to record a sale on credit.',
      );
      return;
    }
    setSubmitting(true);
    try {
      const result = await call<SaleResult>('sales', 'create', {
        lines: cart.map((l) => ({
          productId: l.product.id,
          qty: (l.qtyMilli / 1000).toString(),
          unitPrice: l.unitPrice,
          discount: l.discount,
        })),
        customerId: customerId === WALK_IN ? null : customerId,
        invoiceDiscount,
        payments: paidInput > 0 ? [{ method, amount: paidInput }] : [],
        clientToken: tokenRef.current,
        allowNegativeStock: session.allowNegativeStock,
      });
      toast(
        'success',
        lang === 'bn'
          ? `বিক্রয় সম্পন্ন · ${result.invoiceNo} · ${formatPaisa(result.total)}`
          : `Sale completed · ${result.invoiceNo} · ${formatPaisa(result.total)}`,
      );
      const receiptResult = await call<{ html: string }>('printing', 'invoiceReceipt', {
        invoiceId: result.invoiceId,
        lang: printLanguage,
      });
      setReceipt({ invoiceId: result.invoiceId, html: receiptResult.html, invoiceNo: result.invoiceNo });
      setReceiptHtml(receiptResult.html);
      clearCart();
      void loadProducts(query);
    } catch (err) {
      const message = err instanceof ApiError ? err.messageBn || err.message : String(err);
      toast('error', message);
    } finally {
      setSubmitting(false);
    }
  };

  const printReceipt = async () => {
    try {
      const result = await call<{ ok: boolean; reason?: string }>('printing', 'printHtml', {
        html: receiptHtml,
        paperWidthMm: session.paperWidthMm,
        copies: 1,
        silent: true,
      });
      if (result.ok) toast('success', lang === 'bn' ? 'প্রিন্ট পাঠানো হয়েছে।' : 'Sent to printer.');
      else toast('warning', result.reason ?? (lang === 'bn' ? 'প্রিন্টার পাওয়া যায়নি।' : 'Printer unavailable.'));
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  const hold = async () => {
    if (cart.length === 0) return;
    try {
      await call('sales', 'hold', {
        customerId: customerId === WALK_IN ? null : customerId,
        lines: cart.map((l) => ({
          productId: l.product.id,
          qty: (l.qtyMilli / 1000).toString(),
          unitPrice: l.unitPrice,
          discount: l.discount,
        })),
        note: null,
      });
      toast('success', lang === 'bn' ? 'কার্ট হোল্ড করা হয়েছে।' : 'Cart held.');
      clearCart();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.messageBn : String(err));
    }
  };

  // F4 completes the sale from anywhere on the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F4') {
        e.preventDefault();
        void completeSale();
      }
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape' && !receipt) clearCart();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const quickCash = useMemo(() => {
    const notes = [50_000, 100_000, 200_000, 500_000, 100_0000];
    const rounded = Math.ceil(total / 10_000) * 10_000;
    const options = new Set<number>([total, rounded]);
    for (const note of notes) options.add(note);
    return Array.from(options).filter((v) => v > 0).sort((a, b) => a - b).slice(0, 6);
  }, [total]);

  return (
    <div className="pos">
      <div className="pos-left">
        <div className="pos-search-row">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('posSearchPlaceholder')}
            autoFocus
            inputRef={searchRef}
          />
          <Button variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => void loadProducts(query)}>
            {t('search')}
          </Button>
        </div>

        <div className="pos-grid">
          {products.length === 0 ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <EmptyState
                title={lang === 'bn' ? 'কোনো পণ্য পাওয়া যায়নি' : 'No products found'}
                hint={
                  lang === 'bn'
                    ? 'পণ্য যোগ করতে "পণ্য ও স্টক" পাতা খুলুন।'
                    : 'Add products from the Products screen first.'
                }
                action={
                  <Button variant="primary" size="sm" onClick={() => navigate('products')}>
                    {t('addProduct')}
                  </Button>
                }
              />
            </div>
          ) : (
            products.map((p) => {
              const outOfStock = p.stock_qty <= 0;
              return (
                <button
                  key={p.id}
                  className="pos-tile"
                  onClick={() => addProduct(p)}
                  disabled={outOfStock && !session.allowNegativeStock}
                  title={p.sku}
                >
                  <span className="name">{lang === 'bn' && p.name_bn ? p.name_bn : p.name}</span>
                  <span className="price">{formatPaisa(p.sale_price)}</span>
                  <span className="stock">
                    {formatQty(p.stock_qty)} {p.unit_short ?? ''} {outOfStock ? '· ০' : ''}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="small muted">{t('posShortcuts')}</div>
      </div>

      <aside className="pos-right">
        <div className="cart-header">
          <strong>
            {t('posCart')} · {cart.length}
          </strong>
          <Button size="sm" variant="ghost" onClick={clearCart} disabled={cart.length === 0}>
            {t('posClear')}
          </Button>
        </div>

        <div className="cart-lines">
          {cart.length === 0 ? (
            <EmptyState title={t('posEmptyCart')} hint={t('posEmptyCartHint')} />
          ) : (
            cart.map((line) => (
              <div className="cart-line" key={line.product.id}>
                <span className="name">
                  {lang === 'bn' && line.product.name_bn ? line.product.name_bn : line.product.name}
                </span>
                <span className="amount">
                  {preview
                    ? formatPaisa(
                        preview.lines.find((l) => l.product.id === line.product.id)?.lineTotal ??
                          line.unitPrice * (line.qtyMilli / 1000),
                      )
                    : formatPaisa(line.unitPrice * (line.qtyMilli / 1000))}
                </span>
                <div className="qty-control">
                  <button onClick={() => setQty(line.product.id, line.qtyMilli - 1000)} title="-1">
                    −
                  </button>
                  <input
                    value={line.qtyMilli / 1000}
                    onChange={(e) => {
                      const parsed = Number(e.target.value.replace(/[^\d.]/g, ''));
                      if (Number.isFinite(parsed)) setQty(line.product.id, Math.round(parsed * 1000));
                    }}
                  />
                  <button onClick={() => setQty(line.product.id, line.qtyMilli + 1000)} title="+1">
                    +
                  </button>
                  <button onClick={() => removeLine(line.product.id)} title={t('delete')}>
                    ✕
                  </button>
                </div>
                <span className="meta">
                  {formatPaisa(line.unitPrice)} × {formatQty(line.qtyMilli)}
                  {line.product.unit_short ? ` ${line.product.unit_short}` : ''}
                  {line.product.stock_qty <= 0 ? (
                    <span className="text-danger"> · {lang === 'bn' ? 'স্টক নেই' : 'no stock'}</span>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="cart-totals">
          <div className="row">
            <span>{t('subtotal')}</span>
            <span className="mono">{formatPaisa(preview?.grossTotal ?? 0)}</span>
          </div>
          {(preview?.itemDiscount ?? 0) > 0 ? (
            <div className="row">
              <span>{lang === 'bn' ? 'পণ্যভিত্তিক ছাড়' : 'Line discounts'}</span>
              <span className="mono">−{formatPaisa(preview!.itemDiscount)}</span>
            </div>
          ) : null}
          {(preview?.invoiceDiscount ?? 0) > 0 ? (
            <div className="row">
              <span>{t('posInvoiceDiscount')}</span>
              <span className="mono">−{formatPaisa(preview!.invoiceDiscount)}</span>
            </div>
          ) : null}
          {(preview?.taxTotal ?? 0) > 0 ? (
            <div className="row">
              <span>{t('vat')}</span>
              <span className="mono">{formatPaisa(preview!.taxTotal)}</span>
            </div>
          ) : null}
          <div className="row total">
            <span>{t('total')}</span>
            <span className="mono">{formatPaisa(total)}</span>
          </div>
        </div>

        <div className="cart-actions">
          <div className="row" style={{ gap: 8 }}>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{t('posCustomer')}</span>
              <select className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value={WALK_IN}>{t('posWalkIn')}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.phone ? ` · ${c.phone}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ width: 120 }}>
              <span className="field-label">{t('posInvoiceDiscount')}</span>
              <MoneyInput valuePaisa={invoiceDiscount} onChange={setInvoiceDiscount} />
            </label>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{t('posPayment')}</span>
              <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {lang === 'bn' ? m.nameBn : m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ width: 150 }}>
              <span className="field-label">{t('posPaidAmount')}</span>
              <MoneyInput valuePaisa={paidInput} onChange={setPaidInput} />
            </label>
          </div>

          <div className="row wrap" style={{ gap: 4 }}>
            {quickCash.map((amount) => (
              <Button key={amount} size="sm" onClick={() => setPaidInput(amount)}>
                {formatPaisa(amount, { decimals: false })}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setPaidInput(total)}>
              {lang === 'bn' ? 'পূর্ণ' : 'Exact'}
            </Button>
          </div>

          {due > 0 ? (
            <div className="row between small">
              <span className="muted">{t('due')}</span>
              <span className="mono text-warning">{formatPaisa(due)}</span>
            </div>
          ) : null}
          {paidInput > total && total > 0 ? (
            <div className="row between small">
              <span className="muted">{lang === 'bn' ? 'ফেরত দিতে হবে' : 'Change'}</span>
              <span className="mono">{formatPaisa(paidInput - total)}</span>
            </div>
          ) : null}

          <div className="row" style={{ gap: 8 }}>
            <Button variant="secondary" onClick={() => void hold()} disabled={cart.length === 0 || submitting}>
              {t('posHold')}
            </Button>
            <Button
              variant="success"
              size="lg"
              block
              loading={submitting}
              onClick={() => void completeSale()}
              disabled={cart.length === 0}
            >
              {t('posComplete')} · {formatPaisa(total)}
            </Button>
          </div>
        </div>
      </aside>

      {receipt ? (
        <Modal
          title={`${lang === 'bn' ? 'বিক্রয় সম্পন্ন' : 'Sale completed'} · ${receipt.invoiceNo}`}
          onClose={() => setReceipt(null)}
          wide
          footer={
            <>
              <Select
                options={[
                  { value: 'bn', label: 'বাংলা' },
                  { value: 'en', label: 'English' },
                ]}
                value={printLanguage}
                onChange={(e) => {
                  const next = e.target.value as 'bn' | 'en';
                  setPrintLanguage(next);
                  void call<{ html: string }>('printing', 'invoiceReceipt', {
                    invoiceId: receipt.invoiceId,
                    lang: next,
                  }).then((r) => setReceiptHtml(r.html));
                }}
                style={{ width: 110 }}
              />
              <Button onClick={() => navigate('sales')}>{t('navSales')}</Button>
              <Button variant="primary" onClick={() => void printReceipt()}>
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
    </div>
  );
}
