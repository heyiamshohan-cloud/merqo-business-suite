/**
 * Database schema — versioned migrations.
 *
 * Rules for this file:
 *  - Migrations are APPEND-ONLY. Never edit an applied migration; add a new
 *    one and, if needed, migrate data forward.
 *  - Every migration must be safe for existing business data: no destructive
 *    DDL without an explicit data migration step.
 *  - Monetary columns are INTEGER paisa. Quantity columns are INTEGER
 *    milli-units. See src/core/foundation/money.ts.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const M1_INITIAL = `
-- ---------------------------------------------------------------------------
-- Settings & identity
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  password_hash TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  biz_date   TEXT NOT NULL,
  user_id    TEXT REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  details    TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_bizdate ON audit_log(biz_date);

CREATE TABLE document_sequences (
  key        TEXT PRIMARY KEY,
  prefix     TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  padding    INTEGER NOT NULL DEFAULT 6
);

-- ---------------------------------------------------------------------------
-- Chart of accounts & double-entry ledger
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  name_bn    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  subtype    TEXT,
  parent_id  TEXT REFERENCES accounts(id),
  is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_accounts_type ON accounts(type);

CREATE TABLE journal_entries (
  id                  TEXT PRIMARY KEY,
  entry_no            INTEGER NOT NULL,
  at                  TEXT NOT NULL,
  biz_date            TEXT NOT NULL,
  memo                TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  source_id           TEXT,
  user_id             TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  is_reversal         INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reverses_entry_id   TEXT REFERENCES journal_entries(id),
  reversed_by_entry_id TEXT REFERENCES journal_entries(id)
);
CREATE INDEX idx_je_bizdate ON journal_entries(biz_date);
CREATE INDEX idx_je_source ON journal_entries(source_type, source_id);

CREATE TABLE journal_lines (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no    INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  debit      INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit     INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  party_type TEXT CHECK (party_type IN ('customer','supplier')),
  party_id   TEXT,
  memo       TEXT,
  CHECK (NOT (debit > 0 AND credit > 0)),
  CHECK (debit > 0 OR credit > 0)
);
CREATE INDEX idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX idx_jl_account ON journal_lines(account_id);
CREATE INDEX idx_jl_party ON journal_lines(party_type, party_id);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_bn    TEXT,
  parent_id  TEXT REFERENCES categories(id),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_categories_name ON categories(name COLLATE NOCASE);

CREATE TABLE brands (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_brands_name ON brands(name COLLATE NOCASE);

CREATE TABLE units (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_bn       TEXT,
  short_name    TEXT NOT NULL,
  allow_decimal INTEGER NOT NULL DEFAULT 0 CHECK (allow_decimal IN (0,1)),
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_units_short ON units(short_name);

CREATE TABLE products (
  id             TEXT PRIMARY KEY,
  sku            TEXT NOT NULL,
  name           TEXT NOT NULL,
  name_bn        TEXT,
  category_id    TEXT REFERENCES categories(id),
  brand_id       TEXT REFERENCES brands(id),
  unit_id        TEXT REFERENCES units(id),
  purchase_price INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  sale_price     INTEGER NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  wholesale_price INTEGER NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0),
  min_stock      INTEGER NOT NULL DEFAULT 0,
  max_stock      INTEGER,
  tax_rate_bp    INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 10000),
  track_stock    INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0,1)),
  description    TEXT,
  notes          TEXT,
  supplier_id    TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_products_sku ON products(sku);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_brand ON products(brand_id);
CREATE INDEX idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX idx_products_status ON products(status);

CREATE TABLE product_barcodes (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'barcode' CHECK (kind IN ('barcode','qr')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_barcode_code ON product_barcodes(code);

CREATE TABLE stock_levels (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL DEFAULT 0,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE stock_moves (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  biz_date     TEXT NOT NULL,
  product_id   TEXT NOT NULL REFERENCES products(id),
  qty          INTEGER NOT NULL,
  unit_cost    INTEGER NOT NULL DEFAULT 0,
  value        INTEGER NOT NULL DEFAULT 0,
  movement     TEXT NOT NULL,
  ref_type     TEXT,
  ref_id       TEXT,
  reason       TEXT,
  note         TEXT,
  user_id      TEXT REFERENCES users(id)
);
CREATE INDEX idx_stock_moves_product ON stock_moves(product_id, at);
CREATE INDEX idx_stock_moves_bizdate ON stock_moves(biz_date);
CREATE INDEX idx_stock_moves_ref ON stock_moves(ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT,
  address     TEXT,
  note        TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_customers_code ON customers(code);
CREATE INDEX idx_customers_name ON customers(name COLLATE NOCASE);
CREATE INDEX idx_customers_phone ON customers(phone);

CREATE TABLE suppliers (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT,
  address     TEXT,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_suppliers_code ON suppliers(code);
CREATE INDEX idx_suppliers_name ON suppliers(name COLLATE NOCASE);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
CREATE TABLE sales_invoices (
  id                TEXT PRIMARY KEY,
  invoice_no        TEXT NOT NULL,
  at                TEXT NOT NULL,
  biz_date          TEXT NOT NULL,
  customer_id       TEXT REFERENCES customers(id),
  status            TEXT NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','voided')),
  gross_total       INTEGER NOT NULL DEFAULT 0,
  item_discount     INTEGER NOT NULL DEFAULT 0,
  invoice_discount  INTEGER NOT NULL DEFAULT 0,
  tax_total         INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  paid              INTEGER NOT NULL DEFAULT 0,
  due               INTEGER NOT NULL DEFAULT 0,
  cogs              INTEGER NOT NULL DEFAULT 0,
  profit            INTEGER NOT NULL DEFAULT 0,
  payment_method    TEXT,
  journal_id        TEXT REFERENCES journal_entries(id),
  note              TEXT,
  client_token      TEXT,
  user_id           TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_sales_invoice_no ON sales_invoices(invoice_no);
CREATE UNIQUE INDEX ux_sales_client_token ON sales_invoices(client_token)
  WHERE client_token IS NOT NULL;
CREATE INDEX idx_sales_bizdate ON sales_invoices(biz_date);
CREATE INDEX idx_sales_customer ON sales_invoices(customer_id);
CREATE INDEX idx_sales_status ON sales_invoices(status);

CREATE TABLE sale_lines (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  product_id    TEXT NOT NULL REFERENCES products(id),
  name_snapshot TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  unit_price    INTEGER NOT NULL,
  discount      INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp   INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  cogs          INTEGER NOT NULL DEFAULT 0,
  returned_qty  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sale_lines_invoice ON sale_lines(invoice_id);
CREATE INDEX idx_sale_lines_product ON sale_lines(product_id);

CREATE TABLE held_sales (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  label      TEXT NOT NULL,
  payload    TEXT NOT NULL,
  user_id    TEXT REFERENCES users(id)
);
CREATE INDEX idx_held_sales_at ON held_sales(at DESC);

-- ---------------------------------------------------------------------------
-- Purchases
-- ---------------------------------------------------------------------------
CREATE TABLE purchases (
  id                TEXT PRIMARY KEY,
  purchase_no       TEXT NOT NULL,
  at                TEXT NOT NULL,
  biz_date          TEXT NOT NULL,
  supplier_id       TEXT REFERENCES suppliers(id),
  supplier_ref      TEXT,
  status            TEXT NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','voided')),
  gross_total       INTEGER NOT NULL DEFAULT 0,
  item_discount     INTEGER NOT NULL DEFAULT 0,
  additional_cost   INTEGER NOT NULL DEFAULT 0,
  tax_total         INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  paid              INTEGER NOT NULL DEFAULT 0,
  due               INTEGER NOT NULL DEFAULT 0,
  journal_id        TEXT REFERENCES journal_entries(id),
  note              TEXT,
  user_id           TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_purchases_no ON purchases(purchase_no);
CREATE INDEX idx_purchases_bizdate ON purchases(biz_date);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE purchase_lines (
  id            TEXT PRIMARY KEY,
  purchase_id   TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  product_id    TEXT NOT NULL REFERENCES products(id),
  name_snapshot TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  unit_cost     INTEGER NOT NULL,
  discount      INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp   INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL,
  landed_cost   INTEGER NOT NULL DEFAULT 0,
  stock_value   INTEGER NOT NULL DEFAULT 0,
  returned_qty  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_purchase_lines_purchase ON purchase_lines(purchase_id);
CREATE INDEX idx_purchase_lines_product ON purchase_lines(product_id);

-- ---------------------------------------------------------------------------
-- Payments & allocations
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id          TEXT PRIMARY KEY,
  receipt_no  TEXT NOT NULL,
  at          TEXT NOT NULL,
  biz_date    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  party_type  TEXT NOT NULL CHECK (party_type IN ('customer','supplier')),
  party_id    TEXT NOT NULL,
  method      TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  note        TEXT,
  journal_id  TEXT REFERENCES journal_entries(id),
  client_token TEXT,
  user_id     TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_payments_no ON payments(receipt_no);
CREATE UNIQUE INDEX ux_payments_client_token ON payments(client_token)
  WHERE client_token IS NOT NULL;
CREATE INDEX idx_payments_bizdate ON payments(biz_date);
CREATE INDEX idx_payments_party ON payments(party_type, party_id);

CREATE TABLE payment_allocations (
  id         TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  doc_type   TEXT NOT NULL CHECK (doc_type IN ('sales_invoice','purchase')),
  doc_id     TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX idx_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX idx_alloc_doc ON payment_allocations(doc_type, doc_id);

-- ---------------------------------------------------------------------------
-- Returns
-- ---------------------------------------------------------------------------
CREATE TABLE sales_returns (
  id            TEXT PRIMARY KEY,
  return_no     TEXT NOT NULL,
  at            TEXT NOT NULL,
  biz_date      TEXT NOT NULL,
  invoice_id    TEXT NOT NULL REFERENCES sales_invoices(id),
  customer_id   TEXT REFERENCES customers(id),
  net_sales     INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  cogs          INTEGER NOT NULL DEFAULT 0,
  restock       TEXT NOT NULL DEFAULT 'resalable'
                CHECK (restock IN ('resalable','damaged','none')),
  refund_method TEXT NOT NULL,
  journal_id    TEXT REFERENCES journal_entries(id),
  reason        TEXT,
  user_id       TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_sales_returns_no ON sales_returns(return_no);
CREATE INDEX idx_sales_returns_invoice ON sales_returns(invoice_id);

CREATE TABLE sales_return_lines (
  id           TEXT PRIMARY KEY,
  return_id    TEXT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  sale_line_id TEXT NOT NULL REFERENCES sale_lines(id),
  product_id   TEXT NOT NULL REFERENCES products(id),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  unit_price   INTEGER NOT NULL,
  tax          INTEGER NOT NULL DEFAULT 0,
  line_total   INTEGER NOT NULL,
  unit_cost    INTEGER NOT NULL DEFAULT 0,
  cogs         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sales_return_lines_return ON sales_return_lines(return_id);

CREATE TABLE purchase_returns (
  id           TEXT PRIMARY KEY,
  return_no    TEXT NOT NULL,
  at           TEXT NOT NULL,
  biz_date     TEXT NOT NULL,
  purchase_id  TEXT NOT NULL REFERENCES purchases(id),
  supplier_id  TEXT REFERENCES suppliers(id),
  total        INTEGER NOT NULL DEFAULT 0,
  journal_id   TEXT REFERENCES journal_entries(id),
  reason       TEXT,
  user_id      TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_purchase_returns_no ON purchase_returns(return_no);
CREATE INDEX idx_purchase_returns_purchase ON purchase_returns(purchase_id);

CREATE TABLE purchase_return_lines (
  id               TEXT PRIMARY KEY,
  return_id        TEXT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  purchase_line_id TEXT NOT NULL REFERENCES purchase_lines(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_cost        INTEGER NOT NULL,
  line_total       INTEGER NOT NULL
);
CREATE INDEX idx_purchase_return_lines_return ON purchase_return_lines(return_id);

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------
CREATE TABLE expense_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_bn    TEXT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_expense_categories_name ON expense_categories(name COLLATE NOCASE);

CREATE TABLE expenses (
  id          TEXT PRIMARY KEY,
  voucher_no  TEXT NOT NULL,
  at          TEXT NOT NULL,
  biz_date    TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES expense_categories(id),
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  method      TEXT NOT NULL,
  payee       TEXT,
  reference   TEXT,
  note        TEXT,
  journal_id  TEXT REFERENCES journal_entries(id),
  user_id     TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  edited_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_expenses_no ON expenses(voucher_no);
CREATE INDEX idx_expenses_bizdate ON expenses(biz_date);

-- ---------------------------------------------------------------------------
-- Licensing, backup & diagnostics
-- ---------------------------------------------------------------------------
CREATE TABLE license_state (
  id             TEXT PRIMARY KEY,
  license_id     TEXT NOT NULL,
  organization   TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  signature      TEXT NOT NULL,
  device_hash    TEXT NOT NULL,
  activated_at   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','revoked'))
);

CREATE TABLE backup_log (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  biz_date   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('manual','auto','pre_restore','pre_migration')),
  path       TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('success','failed')),
  note       TEXT
);
CREATE INDEX idx_backup_at ON backup_log(at DESC);

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial_schema', sql: M1_INITIAL },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
