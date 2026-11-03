# MERQO — Database Design

Single SQLite database file per installation: `%APPDATA%/MERQO/data/merqo.db`
(WAL sidecars `-wal`/`-shm` alongside). Migrations are defined in `src/core/db/schema.ts`.

## 1. Pragmas (production)

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;     -- committed data survives power loss
PRAGMA busy_timeout = 10000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -16000;    -- ~16 MB
PRAGMA wal_autocheckpoint = 1000;
```

`synchronous = FULL` is deliberate: the target market has frequent unannounced power cuts and
losing a completed sale is not acceptable. The cost (more fsyncs) is irrelevant at shop volume.

## 2. Tables

### Identity & control
| Table | Purpose |
| --- | --- |
| `schema_migrations` | applied version, name, SHA-256 checksum, timestamp |
| `settings` | typed key/value configuration |
| `users` | operator identity and role (owner/manager/cashier) |
| `audit_log` | append-only trail of privileged operations |
| `document_sequences` | per-document counters (INV-, PUR-, RCP-, …) |
| `app_meta` | install metadata (seeded flag, app version, installed_at) |

### Accounting
| Table | Purpose |
| --- | --- |
| `accounts` | chart of accounts (code, name, name_bn, type, subtype, system flag) |
| `journal_entries` | balanced entry header (no, instant, business date, source, memo, reversal links) |
| `journal_lines` | debit/credit + optional `(party_type, party_id)` sub-ledger dimension |

### Catalogue & stock
`categories`, `brands`, `units`, `products`, `product_barcodes` (unique across products),
`stock_levels` (qty/value), `stock_moves` (immutable movement ledger).

### Parties
`customers`, `suppliers` — balances derived from the journal, never stored.

### Sales
`sales_invoices` (unique `invoice_no`, nullable unique `client_token` for idempotency),
`sale_lines` (price, discount, tax, COGS, `returned_qty`), `held_sales`.

### Purchases
`purchases`, `purchase_lines` (`stock_value` = capitalised value used for exact reversals).

### Payments
`payments` (receipt_no, direction in/out, party, method, amount, journal link),
`payment_allocations` (payment → invoice/purchase).

### Returns
`sales_returns` + `sales_return_lines`, `purchase_returns` + `purchase_return_lines`.

### Expenses
`expense_categories` (mapped to an expense account), `expenses` (`edited_count`, journal link).

### Operations
`license_state`, `backup_log`.

## 3. Relationships

```
categories 1─* products *─1 brands
                    │
                    ├─1 units
                    ├─* product_barcodes
                    ├─1 stock_levels
                    └─* stock_moves

customers 1─* sales_invoices 1─* sale_lines ─* products
                     │                 └─* sales_return_lines
                     └─* sales_returns
                     └─* payment_allocations *─1 payments

suppliers 1─* purchases 1─* purchase_lines ─* products
                     └─* purchase_returns
                     └─* payment_allocations

expense_categories 1─* expenses *─1 accounts

journal_entries 1─* journal_lines *─1 accounts
        ▲                     │
        └── source_id ◄── sales_invoices / purchases / payments / expenses /
                          sales_returns / purchase_returns (polymorphic reference)
```

## 4. Integrity rules in the schema

- Foreign keys on every relationship; `foreign_keys=ON` at connection level.
- `CHECK` constraints for enum-like columns (`status`, `type`, `movement`, `direction`,
  `restock`, …) so an invalid state cannot be written even by a bug.
- `CHECK (debit >= 0)`, `CHECK (credit >= 0)`,
  `CHECK (NOT (debit > 0 AND credit > 0))`, `CHECK (debit > 0 OR credit > 0)` on journal lines.
- Unique indexes: `products.sku`, `product_barcodes.code`, `sales_invoices.invoice_no`,
  `sales_invoices.client_token` (partial), `customers.code`, `suppliers.code`,
  `expenses.voucher_no`, `payments.receipt_no`.
- Indexes on every foreign key and every business-date column used by reports.

## 5. Migrations

- Append-only; checksum-verified against applied history.
- Each migration executes in its own transaction; failure rolls back that version only.
- A database newer than the application refuses to open (prevents downgrade corruption).
- `beforeMigration` hook creates a pre-upgrade backup automatically.

## 6. Capacity & performance

No artificial row limits are imposed. Money columns are `INTEGER` (SQLite stores 64-bit
integers), so amounts are limited only by ±9.2 × 10¹⁸ paisa. Reports are paginated and use
covering indexes; the test suite includes large-dataset benchmarks (see
`docs/testing/PERFORMANCE.md`).
