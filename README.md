# MERQO Business Suite

**Offline point-of-sale, inventory and double-entry accounting for small businesses in Bangladesh.**

MERQO runs entirely on the shop's own computer: no internet, no subscription server, no
cloud dependency. Sales, purchases, stock, customer dues, supplier payables, expenses and the
books are one consistent set of records, written inside single SQLite transactions.

- **Product:** MERQO Business Suite 1.0.0
- **Founder / owner:** Shohan Khan — merqoonline@gmail.com
- **Platform:** Windows 10/11 (x64), Electron + React 18 + TypeScript
- **Language:** Bengali-first, English available
- **Money:** integer paisa everywhere; `৳` / BDT formatting with lakh–crore grouping
- **Status:** feature-complete and unit-tested; Windows installer and physical hardware still
  require verification — see [What is and is not verified](#what-is-and-is-not-verified)

---

## What it does

| Area | Highlights |
| --- | --- |
| **Point of sale** | Keyboard-first till, barcode scan-to-add, cart quantities, line and invoice discounts, VAT inclusive/exclusive, cash / bKash / Nagad / Rocket / card / bank, partial payment, held carts, instant receipt |
| **Products & stock** | Categories, brands, units, multiple barcodes, purchase/sale/wholesale prices, minimum stock, moving weighted-average valuation, opening stock, adjustments with ledger impact |
| **Sales** | Invoice register, full document detail, reprint, void by reversal, returns with resalable / damaged / no-restock policy, credit notes |
| **Purchases** | Supplier invoices, landed cost capitalisation (freight, labour, duty), VAT input, supplier payments, purchase returns at exact landed cost |
| **Parties** | Customers and suppliers with derived balances, statements straight from the ledger, receipt/payment allocation (oldest first) |
| **Expenses** | Category → account posting, edit-by-reversal, vouchers with payee and reference |
| **Accounting** | 30-account chart, balanced-journal enforcement, immutable entries, trial balance, general/account/party ledger, P&L, balance sheet, cash flow, cash balance |
| **Reports** | 25 report builders (sales, purchases, parties, stock, accounting), dashboard KPIs, CSV (Excel-safe Bengali), .xlsx, print-ready HTML → PDF |
| **Printing** | 58 mm and 80 mm receipts, Bengali rendered by Chromium and rasterised by the printer driver (no Bengali font needed on the device), ESC/POS job builder with QR, CODE128 and cash-drawer kick |
| **Data protection** | Manual + automatic backups (`VACUUM INTO`, SHA-256), verification before restore, safety copy on restore, WAL checkpointing |
| **Licensing** | Ed25519-signed offline licence files, device binding, 14-day evaluation then read-only (never locks an owner out of their own data) |

## Screens

Dashboard · POS · Products & stock · Sales · Purchases · Customers · Suppliers · Expenses ·
Returns · Reports · Backup · Settings · Licence · About.

All light mode, single palette, bundled Noto Sans Bengali + Inter so Bengali conjuncts shape
correctly even on a Windows install with no Bengali fonts.

## Architecture in one page

```
renderer (React, no Node)  ──preload bridge──►  main process  ──►  src/core (pure TypeScript)
        │                         │                    │                    │
        │  window.merqo.call()    │  IPC whitelist     │  services + DB     │  domain rules
        └────────────────────────►│  module.method     └───────────────────►│  money / journals
                                  │  + read-only guard                      │  stock / reports
                                  └─────────────────────────────────────────┘
```

- `src/core/**` — business logic, no Electron imports, fully unit-testable (137 tests).
- `src/main/**` — window, IPC registry, service container, printing, logging, device identity.
- `src/preload/**` — the only bridge; exposes one `call()` function.
- `src/renderer/**` — UI; cannot reach the database, the file system or Node.
- `tools/**` — owner-only utilities (licence generator, database utility).

See [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md),
[`ACCOUNTING.md`](docs/architecture/ACCOUNTING.md),
[`INVENTORY.md`](docs/architecture/INVENTORY.md),
[`DATABASE.md`](docs/architecture/DATABASE.md) and [`docs/PRINTING.md`](docs/PRINTING.md).

## Getting started (development)

```bash
npm ci --ignore-scripts     # tests use node:sqlite; no native build needed
npm run typecheck
npm test
npm run build:renderer
npm run build:main
npm run build:owner-tools
```

Run the desktop app (requires an Electron binary; not available in the Linux sandbox this
repository was developed in):

```bash
npm run build && npx electron .
```

| Script | Purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over core, main, preload, renderer and tools |
| `npm test` | Vitest, in-memory SQLite, no network |
| `npm run build:renderer` | Vite → `dist/renderer` |
| `npm run build:main` | esbuild → `dist/main/index.cjs`, `dist/preload/index.cjs` |
| `npm run build:owner-tools` | esbuild (+ SEA on Windows) → `dist/tools` |
| `npm run build` | typecheck + renderer + main |

## Installer

Windows builds are produced **only** by GitHub Actions on `windows-latest`:

```bash
gh workflow run release.yml -f version=1.0.0 -f draft=true
```

The workflow runs the tests, bundles the app, builds the owner tools as genuine single-file
Windows executables, builds `MERQO-Setup-<version>.exe` with electron-builder (NSIS), writes
`SHA256SUMS.txt`, and attaches only the **customer installer** to the release. Owner tools are
kept as workflow artefacts — see [`docs/OWNER_TOOLS.md`](docs/OWNER_TOOLS.md).

## What is and is not verified

| Verified here (Linux, no GUI) | Not verified here |
| --- | --- |
| 137 automated tests: money, accounting, sales, purchases, returns, inventory, reports, export, backup, licensing, printing, receipt model, evaluation policy | Windows installer execution |
| `tsc --noEmit` clean across all source and tools | Electron window, visuals, packaging |
| Renderer and main-process bundles build | Physical 58/80 mm thermal printing |
| Owner CLI tools run end-to-end (keygen → issue → verify; backup → verify → export) | Barcode scanner / cash drawer hardware |
| Database integrity, journal balance, stock↔ledger reconciliation on a created database | Code signing / SmartScreen behaviour |

No physical hardware was attached to the machine that produced this build; no Windows binary
was produced locally. Nothing in this repository claims otherwise. The full list with evidence
is in [`REQUIREMENTS_TRACEABILITY.md`](REQUIREMENTS_TRACEABILITY.md) and
[`PROJECT_PROGRESS.md`](PROJECT_PROGRESS.md).

## Data, privacy and security

- All data lives under `%APPDATA%/MERQO/` (`data/merqo.db`, `backups/`, `logs/`, `license/`).
- Nothing is uploaded. The renderer's Content-Security-Policy blocks network access; the main
  process installs no outbound calls.
- The renderer has no Node integration, no filesystem access and only whitelisted IPC calls.
- Private signing keys are never committed, never packaged and never included in a licence file.
  `owner-keys/` is git-ignored and CI fails the build if key material appears in the tree.

## Licence

Proprietary. See [`LICENSE`](LICENSE). Redistribution, resale or sub-licensing of the software
without written permission is not allowed. One licence covers the devices stated on the licence
file.

## Honest limitations

1. No Windows machine, display or printer in the development sandbox — UI, installer and paper
   output are unverified until CI and on-site testing.
2. The installer is unsigned unless the owner supplies an Authenticode certificate, so Windows
   SmartScreen will warn on first run.
3. MERQO models Bangladeshi VAT (input/output, inclusive/exclusive pricing) but is **not** an
   NBR-approved VAT software and makes no Mushak claim.
4. Offline licences cannot be revoked remotely. The signed licence is the control; a user with
   local file access can restore an older database copy.
5. The name "MERQO" has not been cleared in any trademark registry.

---

© 2026 Shohan Khan. MERQO is an independent product; Electron, React, SQLite and Noto are
third-party components under their own licences (see `THIRD_PARTY_NOTICES.md`).
