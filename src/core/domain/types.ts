/**
 * Persistence row shapes shared across services.
 * Column names mirror the schema so rows can be used directly by reports.
 */

export type Status = 'active' | 'archived';

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  name_bn: string | null;
  category_id: string | null;
  brand_id: string | null;
  unit_id: string | null;
  purchase_price: number;
  sale_price: number;
  wholesale_price: number;
  min_stock: number;
  max_stock: number | null;
  tax_rate_bp: number;
  track_stock: number;
  description: string | null;
  notes: string | null;
  supplier_id: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
  // joined presentation fields
  category_name?: string | null;
  brand_name?: string | null;
  unit_short?: string | null;
  unit_allow_decimal?: number | null;
  stock_qty?: number;
  stock_value?: number;
  barcodes?: string | null;
}

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  credit_limit: number;
  status: Status;
  created_at: string;
  updated_at: string;
  balance?: number;
}

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
  balance?: number;
}

export interface CategoryRow {
  id: string;
  name: string;
  name_bn: string | null;
  parent_id: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface BrandRow {
  id: string;
  name: string;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface UnitRow {
  id: string;
  name: string;
  name_bn: string | null;
  short_name: string;
  allow_decimal: number;
  created_at: string;
}

export interface ExpenseCategoryRow {
  id: string;
  name: string;
  name_bn: string | null;
  account_id: string;
  account_code?: string;
  status: Status;
  created_at: string;
}

export interface SalesInvoiceRow {
  id: string;
  invoice_no: string;
  at: string;
  biz_date: string;
  customer_id: string | null;
  status: 'completed' | 'voided';
  gross_total: number;
  item_discount: number;
  invoice_discount: number;
  tax_total: number;
  total: number;
  paid: number;
  due: number;
  cogs: number;
  profit: number;
  payment_method: string | null;
  journal_id: string | null;
  note: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  customer_name?: string | null;
  customer_phone?: string | null;
}

export interface SaleLineRow {
  id: string;
  invoice_id: string;
  line_no: number;
  product_id: string;
  name_snapshot: string;
  qty: number;
  unit_price: number;
  discount: number;
  tax_rate_bp: number;
  tax: number;
  line_total: number;
  unit_cost: number;
  cogs: number;
  returned_qty: number;
}

export interface PurchaseRow {
  id: string;
  purchase_no: string;
  at: string;
  biz_date: string;
  supplier_id: string | null;
  supplier_ref: string | null;
  status: 'completed' | 'voided';
  gross_total: number;
  item_discount: number;
  additional_cost: number;
  tax_total: number;
  total: number;
  paid: number;
  due: number;
  journal_id: string | null;
  note: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  supplier_name?: string | null;
}

export interface PurchaseLineRow {
  id: string;
  purchase_id: string;
  line_no: number;
  product_id: string;
  name_snapshot: string;
  qty: number;
  unit_cost: number;
  discount: number;
  tax_rate_bp: number;
  tax: number;
  line_total: number;
  landed_cost: number;
  stock_value: number;
  returned_qty: number;
}

export interface PaymentRow {
  id: string;
  receipt_no: string;
  at: string;
  biz_date: string;
  direction: 'in' | 'out';
  party_type: 'customer' | 'supplier';
  party_id: string;
  method: string;
  amount: number;
  note: string | null;
  journal_id: string | null;
  user_id: string | null;
  created_at: string;
}

export interface ExpenseRow {
  id: string;
  voucher_no: string;
  at: string;
  biz_date: string;
  category_id: string;
  account_id: string;
  amount: number;
  method: string;
  payee: string | null;
  reference: string | null;
  note: string | null;
  journal_id: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  category_name?: string | null;
  account_name?: string | null;
}

export interface StockMoveRow {
  id: string;
  at: string;
  biz_date: string;
  product_id: string;
  qty: number;
  unit_cost: number;
  value: number;
  movement: string;
  ref_type: string | null;
  ref_id: string | null;
  reason: string | null;
  note: string | null;
  user_id: string | null;
  product_name?: string;
  product_sku?: string;
}

export type StockMovementType =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'sale_return'
  | 'purchase_return'
  | 'adjustment'
  | 'damage'
  | 'expiry';

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function paginate<T>(rows: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
