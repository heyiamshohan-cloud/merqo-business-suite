# MERQO — System Architecture

**Version:** 1.0.0 · **Status:** implemented core, see `PROJECT_PROGRESS.md` for live status.

## 1. Product identity

| Field | Value |
| --- | --- |
| Product name | **MERQO Business Suite** |
| Brand | MERQO |
| Founder | Shohan Khan |
| Contact | merqoonline@gmail.com |
| Edition | Windows desktop, fully offline |
| Licensing | One-time purchase, lifetime licence, offline activation |
| Default currency | BDT (৳) |

The name *MERQO* is used consistently as the brand mark rendered in typography (no invented
logo symbol). A trademark search has **not** been performed; no legal availability is claimed.

## 2. Technology decision

Two realistic options were evaluated.

### Option A — C# / .NET 8 / WPF / EF Core / SQLite / Inno Setup

*Strengths:* native Windows look, small binary, first-class printing APIs, mature ecosystem.

*Why it was rejected for this build:* see `ENVIRONMENT_AUDIT.md` §4.1 — the environment has no
.NET SDK and no NuGet access, so the compiler and the test runner are unreachable. A financial
application whose ledger logic cannot be executed before release is not acceptable.

### Option B — TypeScript / Electron (main + renderer) / SQLite / React — **SELECTED**

*Strengths:*
- The whole business core is plain, framework-free TypeScript: compile-time checked and
  executable locally against real SQLite, so accounting rules are proven by tests.
- Chromium renders Bengali (যুক্তাক্ষর, কার, ফলা) correctly without any font-shaping work —
  critical for a Bengali-first product, and historically the hardest part of thermal receipt
  printing.
- `printToPDF` gives pixel-accurate invoice/report PDFs from the same HTML used for preview.
- One language across main process, renderer, owner tools and tests.
- Electron + SQLite desktop POS products are common in this market; the architecture is not
  experimental.

*Trade-offs accepted:* larger installer (~120–160 MB), higher RAM footprint than WPF. The
requirement explicitly allows a main executable above 150 MB and forbids removing
dependencies to shrink it.

### Selected stack

| Concern | Choice | Rationale |
| --- | --- | --- |
| Desktop shell | Electron 33 | mature, offline, Chromium rendering for Bengali |
| Language | TypeScript 5.7, `strict` | compile-time safety without a runtime cost |
| UI | React 18 + bespoke design system (no UI kit) | full control of spacing/typography for the Bengali grid |
| Database | SQLite 3 (WAL, `synchronous=FULL`) | single-file, transactional, proven for offline POS |
| DB driver | `better-sqlite3` in production, `node:sqlite` in headless tests | one narrow interface, see `src/core/db/driver.ts` |
| Data access | hand-written SQL + typed repositories | no ORM magic in the money path; every query is reviewable |
| Migrations | versioned SQL with checksum verification | see `src/core/db/schema.ts`, `migrator.ts` |
| Tests | Vitest | fast, runs the real core against real SQLite |
| Packaging | electron-builder → NSIS installer + portable EXEs | on `windows-latest` CI |
| Licensing crypto | Ed25519 via `node:crypto` | modern signature scheme, no custom crypto |
| Reporting/export | SQL → TS → CSV/HTML→PDF | single source of truth per report |

## 3. Layering

```
┌──────────────────────────────────────────────────────────────────────┐
│ src/renderer  (React, TSX)          Presentation                     │
│   screens, design system, i18n(bn/en), keyboard-first POS, reports   │
├──────────────────────────────────────────────────────────────────────┤
│ src/main      (Electron main)       Application / transport          │
│   window lifecycle, IPC handlers, printing, file dialogs, backups    │
├──────────────────────────────────────────────────────────────────────┤
│ src/preload   (contextBridge)       Trusted API surface              │
├──────────────────────────────────────────────────────────────────────┤
│ src/core      (framework-free TS)   Domain + Application + Infra     │
│   foundation/ money, clock, errors, ids                              │
│   db/         driver, schema, migrator, bootstrap, context           │
│   accounting/ chart of accounts, journal, reports                    │
│   inventory/  moving-average stock engine                            │
│   catalog/ parties/ sales/ purchases/ returns/ payments/ expenses/   │
│   reports/    export/ backup/ licensing/ printing/                   │
├──────────────────────────────────────────────────────────────────────┤
│ SQLite file                         Infrastructure                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Rule enforced by review:** business logic lives only in `src/core`. The renderer may format
and display; it may not compute money. The main process never contains business rules either —
it delegates to `src/core`.

## 4. Cross-cutting decisions

### 4.1 Money is integer paisa
`src/core/foundation/money.ts`. No floating point anywhere in the money path. Rounding is
HALF-UP and applied exactly once per materialised amount. Quantity is integer milli-units so
kg/litre items stay exact.

### 4.2 Every financial write is one transaction
`Db.transaction()` uses `BEGIN IMMEDIATE` with nested SAVEPOINTs. A sale persists invoice +
lines + stock movements + COGS + payments + receivable + journal entry atomically, or not at
all. Verified by rollback tests.

### 4.3 Posted records are immutable
Corrections are made by reversal entries (`reverseJournal`, `voidExpense`, `voidSale`), never
by editing history. The audit log records actor, time, action and before/after payloads.

### 4.4 Balances are derived, never stored
Customer due, supplier payable, stock value and account balances are all computed from the
journal or stock ledger. There is no denormalised `balance` column to drift out of sync.
`reconcileInventoryWithLedger()` and `verifyAllJournalsBalanced()` prove this in tests.

### 4.5 Offline by construction
No network calls exist in the product code. There is no telemetry, no activation server, no
cloud database. Licensing is a signed file verified with an embedded public key.

### 4.6 Reliability
- `synchronous=FULL` + WAL survives abrupt power loss of a committed transaction.
- Pre-migration automatic backup hook.
- Centralised error mapping: all driver failures become typed `AppError`s with Bengali+English
  messages, never raw SQL in the UI.
- Startup integrity check (`PRAGMA integrity_check`) exposed in the maintenance utility.

## 5. Process model

```
Electron main process ── owns Db (one writer) ── IPC ── renderer (no DB access)
                                          ├── printing / file system / backup
                                          └── licence verification
```

The renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false`. It can only
call the explicitly whitelisted methods exposed by `src/preload`. Every IPC payload is
validated in the main process before it reaches `src/core`.

## 6. Deployment

| Artefact | Producer | Contents |
| --- | --- | --- |
| MERQO Business Suite (installer + portable) | electron-builder, Windows CI | main application |
| MERQO Licence Generator | electron-builder, Windows CI | **owner-only** portable EXE |
| MERQO Database Utility | electron-builder, Windows CI | backup/verify/repair tool |

User data lives under `%APPDATA%/MERQO/` (database, logs, backups, licence), *not* inside the
install directory, so uninstalling never deletes business records.

See also: `DATABASE.md`, `ACCOUNTING.md`, `INVENTORY.md`, `LICENSING.md`, `SECURITY.md`,
`PRINTING.md`, `../TECH_STACK.md`.
