# Changelog

All notable changes to MERQO Business Suite. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow semantic
versioning.

## [1.0.0] — 2026-11-03

First complete build of the suite: core domain, accounting, desktop application, licensing,
backup, printing, owner tooling and Windows delivery pipeline.

### Added — foundation

- Integer-paisa money engine (`৳` / BDT, lakh–crore grouping, Bengali numerals) with HALF-UP
  rounding and exact largest-remainder allocation. No binary floating point anywhere.
- SQLite abstraction with two interchangeable drivers: `better-sqlite3` (packaged app) and
  `node:sqlite` (tests/tooling, no native build required).
- Versioned migration runner with SHA-256 checksums, downgrade protection and a
  pre-migration backup hook.
- Seed data: 30-account chart of accounts, 10 units, 8 expense categories, 11 document
  sequences, default settings, owner user.

### Added — accounting and operations

- Immutable double-entry journals with balanced-journal enforcement and reversal-only
  corrections; party sub-ledger dimension on receivables/payables.
- Trial balance, general/account/party ledger with running balance, P&L, balance sheet,
  cash flow, cash & bank balance.
- Sales: atomic invoice (lines → stock issue → COGS → payments → receivable → journal → audit),
  line and invoice discounts, VAT inclusive/exclusive, split payment methods, partial credit,
  credit-limit checks, idempotency token, void, held carts.
- Purchases: landed-cost capitalisation, VAT input, supplier payable, partial payment,
  purchase void at exact stock value.
- Returns: sales returns (resalable / damaged / no restock), over-return prevention, credit vs
  cash refund; purchase returns at exact landed cost.
- Party payments with FIFO allocation across open documents; supplier payments; expenses with
  edit-by-reversal.
- Inventory: moving weighted average, opening stock, adjustments with ledger impact, stock
  moves, valuation, low/out-of-stock, reconciliation with the inventory account.

### Added — reporting and export

- 25 report builders behind `REPORT_CATALOG` + `buildReport`, plus dashboard summary.
- CSV export (UTF-8 BOM + CRLF so Excel opens Bengali correctly), dependency-free `.xlsx`
  writer, print-ready Bengali HTML for PDF.
- Report↔ledger reconciliation tests (P&L vs journal, dues vs control accounts, trial balance
  equality, stock report vs valuation).

### Added — data protection and licensing

- Backup via `VACUUM INTO` with SHA-256, `backup_log`, retention pruning, automatic daily or
  weekly policy, verification (integrity, schema, row counts) and restore with a safety copy.
- Ed25519 offline licences: canonical JSON signing, key fingerprint, device binding, expiry for
  trial/subscription, activation superseding prior licences with a critical audit entry,
  re-verification from the database on every status read.
- 14-day evaluation, then read-only mode: reading, exporting, printing and backups stay
  available; only posting is blocked.

### Added — desktop application

- Electron main process: single-instance lock, hardened window (`contextIsolation`, no node
  integration, navigation blocked, CSP), structured JSON logging with secret redaction,
  device identity collection, crash logging.
- IPC registry: whitelisted `module.method` calls, normalised `{code, message, messageBn}`
  errors, read-only licence guard, no filesystem or SQL surface for the renderer.
- React UI: dashboard, POS, products, sales, purchases, customers, suppliers, expenses,
  returns, reports, backup, settings, licence, about — bilingual (বাংলা / English), light mode
  only, bundled Bengali + Latin fonts.
- Printing: hidden-window HTML printing through the Windows driver (Bengali shaped by
  Chromium), PDF generation, ESC/POS job builder with raster, QR, CODE128, cash-drawer kick.

### Added — owner tooling and delivery

- `MERQO-License-Generator` (owner only): keygen, issue, inspect, verify, device, keyid.
  Verified end-to-end on the bundled CLI.
- `MERQO-DB-Utility` (owner/support only): info, check, backup, verify, restore, export,
  vacuum, audit, licenses. Verified against a real database.
- GitHub Actions: CI (typecheck, tests, bundles, key-material guard) and Windows release
  pipeline (NSIS installer, SEA owner executables, checksums, artifact-only owner tools).
- Documentation: architecture, accounting, inventory, database, printing, owner tools, user
  guide, requirements traceability, environment audit, third-party notices.

### Known limitations at 1.0.0

- Windows installer, application window and physical thermal printing have **not** been
  verified: the development environment is Linux with no display, no printer and no ability to
  download Electron/NSIS. Build and verification happen on `windows-latest`.
- Installer is unsigned unless the owner supplies an Authenticode certificate.
- MERQO is not an NBR-approved VAT software and makes no Mushak claim.
- Offline licences cannot be revoked remotely.
