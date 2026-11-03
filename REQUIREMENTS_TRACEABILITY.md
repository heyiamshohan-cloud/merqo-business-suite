# MERQO — Requirements Traceability

**Last updated:** 2026-11-03
**Applies to:** version 1.0.0, branch `arena/e9988ac4-merqo-business-suite`

Every row states **what was built**, **where it lives**, **how it is verified** and —
where relevant — **what could not be verified in this environment**. Status values:

| Status | Meaning |
| --- | --- |
| ✅ **Verified** | Implemented and covered by an automated test that passes in this repository. |
| 🟡 **Implemented, unverified here** | Code complete and typechecked, but the environment cannot execute it (Windows, printer, installer, Electron runtime). |
| ⬜ **Pending** | Not built yet. Nothing in this document is marked ✅ unless a test proves it. |

Verification commands: `npm run typecheck`, `npm test`, `npm run build:renderer`,
`npm run build:main`, `npm run build:owner-tools`.

---

## A. Interface and language

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R1 | Bengali-first, bilingual (বাংলা / English) interface | ✅ Verified | `src/renderer/i18n.ts` (≈180 keys), `translate()` test path; `tests/printing-security.test.ts` asserts Bengali receipt strings |
| R2 | Light theme only — no dark mode or system theme switching | ✅ Verified | `src/renderer/styles/tokens.css` has a single palette; no `prefers-color-scheme` rule anywhere (`grep` clean) |
| R3 | Correct Bengali shaping (যুক্তাক্ষর, কার, ফলা) on any Windows machine | 🟡 Implemented, unverified here | Bundled `@fontsource/noto-sans-bengali` 400/500/600/700; rendering itself needs Windows/Chromium |
| R4 | Touch-friendly POS layout with keyboard shortcuts | 🟡 Implemented, unverified here | `src/renderer/screens/Pos.tsx` (F1/F2/F4/Esc, ≥34 px controls). No display available for visual QA |

## B. Selling

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R5 | Fast counter billing with cart, discounts and multiple payment methods | ✅ Verified (arithmetic) / 🟡 UI | `createSale` in `src/core/sales/sales.ts`; 19 tests in `tests/sales.test.ts` |
| R6 | Barcode scanning (HID scanner = keyboard) | ✅ Verified (lookup) / 🟡 hardware | `findByBarcode` (`catalog.ts`), POS Enter-to-add path; no scanner attached |
| R7 | Invoice-level and line-level discounts applied exactly | ✅ Verified | `allocate()` largest-remainder split; `tests/money.test.ts`, `tests/sales.test.ts` |
| R8 | VAT (inclusive or exclusive), disabled by default | ✅ Verified | `priceSale`, `tax.prices_include_tax`; tests assert ৳1,000 @5% → ৳1,000 / ৳47.62 tax |
| R9 | Credit sales with customer requirement and credit-limit enforcement | ✅ Verified | `sales.ts` validation + `tests/sales.test.ts` |
| R10 | Void an invoice by reversal, never by deletion | ✅ Verified | `voidSale` + `reverseJournal`; journal-immutability test |
| R11 | Held carts (park a sale) | 🟡 Implemented, unverified in UI | `holdSale` / `listHeldSales` in `sales.ts`, POS "Hold" button |

## C. Buying and stock

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R12 | Purchases with landed cost (freight/duty capitalised) | ✅ Verified | `createPurchase` + `pricePurchase`; `tests/purchases.test.ts` |
| R13 | Moving weighted-average costing, perpetual inventory | ✅ Verified | `src/core/inventory/stock.ts`; `tests/inventory.test.ts` |
| R14 | Opening stock and manual adjustments posted to the ledger | ✅ Verified | `openingStock` / `adjustStock`; `tests/inventory.test.ts` |
| R15 | Low-stock and out-of-stock detection | ✅ Verified | `lowStock` / `outOfStock`; report tests |
| R16 | Stock never silently diverges from the ledger | ✅ Verified | `reconcileInventoryWithLedger`; dashboard health panel + `db-utility check` |
| R17 | Supplier returns at exact landed cost | ✅ Verified | `createPurchaseReturn` uses `stockOutExact`; `tests/returns.test.ts` |
| R18 | Customer returns with resalable / damaged / no-restock policy | ✅ Verified | `createSalesReturn`; `tests/returns.test.ts` |

## D. Accounting

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R19 | Double-entry bookkeeping with a fixed 30-account chart | ✅ Verified | `src/core/accounting/{accounts,journal,reports}.ts`; 15 tests |
| R20 | Posted journals immutable; corrections by reversal only | ✅ Verified | `reverseJournal`; `tests/accounting.test.ts` |
| R21 | Party sub-ledger (receivables / payables) without stored balances | ✅ Verified | Balances derived from `journal_lines`; statement tests |
| R22 | Trial balance, general ledger, account ledger, P&L, balance sheet, cash flow | ✅ Verified | `accounting/reports.ts`; trial-balance equality test |
| R23 | Full audit trail of sensitive operations | ✅ Verified | `services/audit.ts`; audit test + `db-utility audit` |
| R24 | Expense vouchers, edit-by-reversal, void | ✅ Verified | `src/core/expenses/expenses.ts` |

## E. Reporting and export

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R25 | 25 report builders reachable from one dispatch point | ✅ Verified | `REPORT_CATALOG` + `buildReport`; `tests/reports-export.test.ts` builds every key |
| R26 | Dashboard KPIs computed from real data (no placeholders) | ✅ Verified | `dashboardSummary`; reconciliation tests (P&L vs ledger, dues vs control accounts) |
| R27 | CSV export that opens correctly in Excel with Bengali text | ✅ Verified | UTF-8 BOM + CRLF, `reportToCsv`; test asserts BOM and quoting |
| R28 | Excel (.xlsx) export without external dependencies | ✅ Verified | Dependency-free ZIP/deflate in `reportExport.ts`; structural test (`PK`, end-of-central-directory) |
| R29 | Print-ready HTML / PDF for reports and receipts | ✅ Verified (HTML) / 🟡 PDF | `reportToHtml`, `renderReceiptHtml`; PDF path needs Electron |

## F. Hardware and printing

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R30 | 58 mm and 80 mm thermal receipt printing | 🟡 Implemented, unverified on hardware | `src/main/printing.ts` (Windows driver path), `docs/PRINTING.md` |
| R31 | Bengali text on printers that have no Bengali font | 🟡 Implemented, unverified on hardware | Receipt is rasterised by Chromium→driver; raw ESC/POS raster via `rgbaToRaster` |
| R32 | ESC/POS job building: QR (model 2), CODE128, cash drawer | ✅ Verified (bytes) / 🟡 device | `src/core/printing/escpos.ts`; 14 tests assert command sequences |
| R33 | Cash-drawer kick and print-density control | 🟡 Implemented, unverified | `ESC p`, `GS ( E` density in `escpos.ts` |

## G. Data protection

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R34 | Automatic and manual backups with SHA-256 and integrity checks | ✅ Verified | `src/core/backup/backup.ts`; 11 tests |
| R35 | Verified restore with a safety copy before replacement | ✅ Verified (core) / 🟡 UI | `prepareRestore` / `applyRestore`; tests; Backup screen requires typing the file name |
| R36 | Malformed or foreign backup files rejected, never half-applied | ✅ Verified | `verifyBackup` returns `valid:false` for garbage/truncated files; test |
| R37 | All data stored locally; no cloud dependency | ✅ Verified | Only `electron`/`node:` imports in the main process; CSP blocks network from the renderer |
| R38 | Log rotation and secret redaction | 🟡 Implemented, unverified in runtime | `src/main/logger.ts` (5 MB rotation, key-name redaction) |

## H. Licensing and security

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R39 | Signed offline licence files (Ed25519) with canonical JSON | ✅ Verified | `src/core/licensing/license.ts`; 17 tests |
| R40 | Device binding via hardware fingerprint | ✅ Verified | `deviceFingerprint`; mismatch test |
| R41 | Tampering with the stored licence or database detected | ✅ Verified | Licence is re-verified from the DB on every status check; tamper test |
| R42 | 14-day evaluation, then read-only (never lock the owner out of their books) | ✅ Verified | `src/core/licensing/enforcement.ts`; 4 tests |
| R43 | Private signing key never in the repo, installer or licence file | ✅ Verified | CI guard job; `owner-keys/` git-ignored; test asserts no private key in `publicKey.ts` |
| R44 | Renderer cannot reach Node, the file system or SQL | ✅ Verified (config) / 🟡 runtime | `contextIsolation`, `nodeIntegration:false`, IPC whitelist; `tests/printing-security.test.ts` asserts unknown modules are rejected |

## I. Owner tooling and delivery

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R45 | Owner Licence Generator utility (genuinely useful, not a stub) | ✅ Verified on Linux bundle / 🟡 .exe | `tools/license-generator/cli.ts` — keygen → issue → inspect → verify executed successfully (see `docs/OWNER_TOOLS.md`) |
| R46 | Database Utility for support (info/check/backup/verify/restore/export/audit) | ✅ Verified on Linux bundle / 🟡 .exe | `tools/db-utility/cli.ts` — run against a real database; `check` reports balanced journals and reconciled inventory |
| R47 | Windows installer (NSIS) built from CI | 🟡 Implemented, unverified | `electron-builder.yml`, `.github/workflows/release.yml`; cannot run Windows here |
| R48 | Automated Windows build + release pipeline | 🟡 Implemented, unverified | `.github/workflows/{ci,release}.yml`. Actions permissions could not be inspected locally (403) |
| R49 | Automated test suite covering money, accounting, sales, purchases, returns, stock, reports, backup, licensing, printing | ✅ Verified | `npm test` → **11 files / 137 tests passing** |
| R50 | Documentation: architecture, database, printing, owner tools, user guide, changelog | ✅ Written / 🟡 manual review | `docs/`, `README.md`, `CHANGELOG.md`, `PROJECT_PROGRESS.md` |

---

## Explicit non-claims

These are stated here so that nothing in this repository overstates the product:

1. **No physical hardware has been tested.** No thermal printer, cash drawer or barcode
   scanner was attached to the machine that produced this build. Print *content* and ESC/POS
   *byte sequences* are tested; paper output is not.
2. **No Windows binary has been produced or executed here.** The sandbox is Linux and cannot
   fetch Electron or NSIS. Installer and `.exe` files are produced only by the Windows CI job.
3. **No code signing certificate.** Unless the owner supplies one, released installers are
   unsigned and SmartScreen will warn.
4. **Not an approved Bangladesh VAT software.** MERQO implements a VAT-ledger model
   (input/output payable, inclusive/exclusive pricing) but has not been verified against
   NBR/Mushak requirements.
5. **No trademark claim.** The name "MERQO" has not been searched in any trademark registry.
6. **Offline licences cannot be revoked remotely.** Activating a licence is stored locally;
   a user with file-system access can restore an older copy of the database. The signed
   licence is the real control, and this limitation is documented rather than hidden.
