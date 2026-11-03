/**
 * Shared UI primitives implementing the MERQO design system.
 * Screens compose these only — no screen defines its own spacing or colours.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatPaisa, toPaisa } from '../core/foundation/money';
import { translate, type Lang, type StringKey } from './i18n';

// ---------------------------------------------------------------------------
// UI context (language, translator, toasts)
// ---------------------------------------------------------------------------
export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface UiContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: StringKey) => string;
  toast: (level: Toast['level'], message: string) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

const UiContext = createContext<UiContextValue | null>(null);

export function UiProvider({
  lang,
  setLang,
  children,
}: {
  lang: Lang;
  setLang: (lang: Lang) => void;
  children: React.ReactNode;
}): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((level: Toast['level'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, level, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, level === 'error' ? 7000 : 3800);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo<UiContextValue>(
    () => ({
      lang,
      setLang,
      t: (key: StringKey) => translate(key, lang),
      toast,
      toasts,
      dismissToast,
    }),
    [lang, setLang, toast, toasts, dismissToast],
  );

  return (
    <UiContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`toast ${item.level}`}
            onClick={() => dismissToast(item.id)}
            role="status"
          >
            {item.message}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  );
}

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside UiProvider');
  return ctx;
}

/** Bengali if available, else English — used for product/party names. */
export function useName(): (bn: string | null | undefined, en: string | null | undefined) => string {
  const { lang } = useUi();
  return (bn, en) => (lang === 'bn' && bn ? bn : (en ?? bn ?? ''));
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'ghost';

export function Button({
  variant = 'secondary',
  size,
  block,
  loading,
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'lg';
  block?: boolean;
  loading?: boolean;
}): JSX.Element {
  const classes = [
    'btn',
    `btn-${variant}`,
    size ? `btn-${size}` : '',
    block ? 'btn-block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={rest.disabled || loading} {...rest}>
      {loading ? <span className={`spin ${variant === 'secondary' ? 'dark' : ''}`} /> : null}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export function Card({
  title,
  actions,
  children,
  footer,
  className = '',
  bodyClass = '',
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  bodyClass?: string;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="card-title">{title}</div>
          <div className="row">{actions}</div>
        </header>
      )}
      <div className={`card-body ${bodyClass}`}>{children}</div>
      {footer ? <footer className="card-footer">{footer}</footer> : null}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      <div className="row wrap">{actions}</div>
    </div>
  );
}

export function Kpi({
  label,
  value,
  foot,
  tone,
}: {
  label: string;
  value: string;
  foot?: string;
  tone?: 'positive' | 'negative';
}): JSX.Element {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {foot ? <div className="kpi-foot">{foot}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'brand' | 'info';
}): JSX.Element {
  return <span className={`badge ${tone === 'default' ? '' : tone}`}>{children}</span>;
}

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: React.ReactNode;
}): JSX.Element {
  return <div className={`alert ${tone}`}>{children}</div>;
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="loading-block">
      <span className="spin dark" />
      {label ? <span className="small">{label}</span> : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="empty-block">
      <div className="title">{title}</div>
      {hint ? <div className="small">{hint}</div> : null}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------
export function Field({
  label,
  required,
  error,
  hint,
  children,
  className = '',
}: {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">
        {label}
        {required ? <span className="req">*</span> : null}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : null}
      {!error && hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`input ${className}`} {...rest} />;
});

export function Select({
  options,
  className = '',
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ value: string; label: string }>;
}): JSX.Element {
  return (
    <select className={`select ${className}`} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Money input. Accepts Bengali numerals, thousands separators and a currency
 * symbol; stores integer paisa so no floating point ever touches an amount.
 */
export function MoneyInput({
  valuePaisa,
  onChange,
  disabled,
  placeholder,
  className = '',
  autoFocus,
}: {
  valuePaisa: number;
  onChange: (paisa: number) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}): JSX.Element {
  const [text, setText] = useState(valuePaisa === 0 ? '' : (valuePaisa / 100).toString());
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef(valuePaisa);

  useEffect(() => {
    if (valuePaisa !== lastEmitted.current) {
      setText(valuePaisa === 0 ? '' : (valuePaisa / 100).toString());
      lastEmitted.current = valuePaisa;
    }
  }, [valuePaisa]);

  return (
    <input
      className={`input num ${className}`}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      placeholder={placeholder ?? '0.00'}
      autoFocus={autoFocus}
      title={error ?? undefined}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === '') {
          setError(null);
          lastEmitted.current = 0;
          onChange(0);
          return;
        }
        try {
          const paisa = toPaisa(raw);
          if (paisa < 0) {
            setError('Negative');
            return;
          }
          setError(null);
          lastEmitted.current = paisa;
          onChange(paisa);
        } catch {
          setError('Invalid');
        }
      }}
      onBlur={() => {
        if (text.trim() === '') return;
        try {
          const paisa = toPaisa(text);
          setText(paisa === 0 ? '' : (paisa / 100).toFixed(2));
        } catch {
          setText('');
          onChange(0);
        }
      }}
    />
  );
}

export function QuantityInput({
  valueMilli,
  onChange,
  disabled,
  allowDecimal = false,
}: {
  valueMilli: number;
  onChange: (milli: number) => void;
  disabled?: boolean;
  allowDecimal?: boolean;
}): JSX.Element {
  const [text, setText] = useState((valueMilli / 1000).toString());
  const last = useRef(valueMilli);
  useEffect(() => {
    if (valueMilli !== last.current) {
      setText((valueMilli / 1000).toString());
      last.current = valueMilli;
    }
  }, [valueMilli]);
  return (
    <input
      className="input num"
      value={text}
      disabled={disabled}
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const parsed = Number(raw.replace(/[^\d.]/g, ''));
        if (Number.isFinite(parsed)) {
          const milli = Math.round(parsed * 1000);
          last.current = milli;
          onChange(milli);
        }
      }}
    />
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
}): JSX.Element {
  return (
    <div className="search-box" style={{ width: '100%' }}>
      <span className="icon">⌕</span>
      <input
        ref={inputRef}
        className="input"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <header className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  dangerous,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  dangerous?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={dangerous ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{message}</p>
      {children}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Data table
// ---------------------------------------------------------------------------
export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

export function DataTable<T>({
  columns,
  rows,
  keyOf,
  empty,
  loading,
  onRowClick,
  footer,
  selectedKey,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  keyOf: (row: T) => string;
  empty?: React.ReactNode;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  footer?: React.ReactNode;
  selectedKey?: string | null;
}): JSX.Element {
  if (loading) return <Spinner />;
  if (rows.length === 0) {
    return <>{empty ?? <div className="table-empty">No records</div>}</>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : ''}
                style={c.width ? { width: c.width } : undefined}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={keyOf(row)}
              className={selectedKey === keyOf(row) ? 'selected' : ''}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={c.align === 'right' ? 'money' : c.align === 'center' ? 'center' : ''}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

export function Money({ paisa }: { paisa: number }): JSX.Element {
  return <span className={paisa < 0 ? 'text-danger' : undefined}>{formatPaisa(paisa)}</span>;
}

export function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}): JSX.Element {
  return (
    <div className="pagination">
      <span>
        {total} records · page {page} / {totalPages}
      </span>
      <Button size="sm" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>
        ‹
      </Button>
      <Button
        size="sm"
        onClick={() => onPage(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        ›
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------
export type RangePreset = 'today' | 'week' | 'month' | 'year' | 'custom';

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function presetRange(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (preset === 'today') return { from: to, to };
  if (preset === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString().slice(0, 10), to };
  }
  if (preset === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: d.toISOString().slice(0, 10), to };
  }
  const d = new Date(now.getFullYear(), 0, 1);
  return { from: d.toISOString().slice(0, 10), to };
}

export function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}): JSX.Element {
  const { t } = useUi();
  const [preset, setPreset] = useState<RangePreset>('month');
  const applyPreset = (p: RangePreset) => {
    setPreset(p);
    if (p !== 'custom') onChange(presetRange(p));
  };
  return (
    <div className="row wrap">
      <div className="row" style={{ gap: 4 }}>
        {(['today', 'week', 'month', 'year'] as RangePreset[]).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={preset === p ? 'primary' : 'secondary'}
            onClick={() => applyPreset(p)}
          >
            {t(p === 'today' ? 'today' : p === 'week' ? 'thisWeek' : p === 'month' ? 'thisMonth' : 'thisYear')}
          </Button>
        ))}
      </div>
      <input
        type="date"
        className="input"
        style={{ width: 140 }}
        value={from}
        onChange={(e) => {
          setPreset('custom');
          onChange({ from: e.target.value, to });
        }}
      />
      <span className="muted small">{t('to')}</span>
      <input
        type="date"
        className="input"
        style={{ width: 140 }}
        value={to}
        onChange={(e) => {
          setPreset('custom');
          onChange({ from, to: e.target.value });
        }}
      />
    </div>
  );
}
