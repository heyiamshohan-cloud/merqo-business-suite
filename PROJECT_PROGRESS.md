# MERQO — Project Progress

**Last updated:** 2026-11-03
**Application version:** 1.0.0 (in development)
**Current phase:** Phase 5 → 7 (core modules implemented; reporting, licensing, UI, packaging in progress)
**Branch:** `arena/e9988ac4-merqo-business-suite`
**Latest commit:** see `git log -1`
**Database migration:** v1 `initial_schema`

---

## Phase status

| Phase | Description | Status |
| --- | --- | --- |
| 0 | Environment & access audit | ✅ complete — `ENVIRONMENT_AUDIT.md` |
| 1 | Requirements analysis & traceability | 🟡 in progress — `REQUIREMENTS_TRACEABILITY.md` |
| 2 | System architecture | ✅ documented — `docs/architecture/` |
| 3 | UI/UX foundation | ⬜ not started |
| 4 | Database & domain foundation | ✅ complete, tested |
| 5 | Core business modules | 🟡 accounts, catalogue, inventory, sales, purchases, returns, payments, expenses done; reports/dashboard pending |
| 6 | Hardware & operational features | ⬜ not started (printing, barcode, backup) |
| 7 | Licensing & security | ⬜ not started |
| 8 | Additional EXE & installer | ⬜ not started |
| 9 | Automated testing | 🟡 76 tests green, expanding |
| 10 | Manual & visual QA | ⬜ not started (blocked: no Windows/display) |
| 11 | Performance & security audit | ⬜ not started |
| 12 | Documentation | 🟡 architecture docs written |
| 13 | Final build | ⬜ not started |
| 14 | Release | ⬜ not started |
| 15 | Final verification | ⬜ not started |

---

## Completed and verified in this environment

### Foundation
- Integer-paisa money engine with HALF-UP rounding, Bengali numeral parsing, exact
  largest-remainder allocation — **11 tests**.
- SQLite driver abstraction: `better-sqlite3` (production) / `node:sqlite` (headless tests) —
  verified working under Vitest.
- Versioned migration runner with SHA-256 checksum verification, downgrade protection and
  pre-migration backup hook.
- Bootstrap seed: 30-account chart of accounts, 10 units, 8 expense categories, 11 document
  sequences, default settings, owner user.

### Double-entry accounting
- Balanced-journal enforcement, reversal-based corrections, party sub-ledger dimension.
- Trial balance, general/account/party ledger with running balance, P&L, balance sheet,
  cash flow, cash balance — **15 tests**, including the specification's exact scenario
  (sell ৳1,000 / cost ৳600 / paid ৳700 → revenue 1,000, COGS 600, gross profit 400,
  cash 700, receivable 300, ledger balanced).

### Inventory (moving weighted average)
- Perpetual WAC on aggregate value; exact-value reversals for purchase voids/returns;
  residual absorption; negative-stock policy; adjustment workflow; low/out-of-stock queries;
  valuation report; ledger reconciliation — **11 tests**.

### Sales / POS
- Atomic sale: invoice → lines → stock issue → COGS → payments → receivable → journal → audit.
- Item and invoice discounts with exact allocation, VAT (inclusive or exclusive), multiple
  payment methods, partial payment with customer requirement, credit-limit enforcement,
  idempotency token, void with reversal, held carts, invoice listing — **19 tests**.

### Purchases
- Landed-cost capitalisation (discount reduces cost, additional cost allocated), VAT input,
  supplier payable, partial payment, supplier payment, void — **11 tests**.

### Returns & payments
- Sales return (resalable / damaged / not restocked), over-return prevention, cumulative
  `returned_qty` control, credit vs cash refund rules, purchase returns at exact landed cost,
  FIFO receipt allocation — **9 tests**.

### Expenses
- Category → account posting, edit-by-reversal with audit trail, void.

**Current test suite: 76 tests, 6 files, all passing.** Run with `npm test`.

---

## Actively in progress / next

1. Reports module (27 required reports) + CSV/Excel/PDF export.
2. Backup & restore with checksum validation and integrity verification.
3. Licensing: Ed25519 keypair, signed licence files, verification, device binding, recovery.
4. Electron main process + IPC + preload, React UI with the Bengali design system.
5. Thermal receipt printing (ESC/POS raster) and barcode/QR generation.
6. Licence Generator EXE and Database Utility EXE.
7. GitHub Actions Windows CI: build, test, package, sign checksums, publish release.
8. Bengali user manual and remaining documentation.

## Known limitations (honest)

| # | Limitation | Impact |
| --- | --- | --- |
| L1 | No Windows machine or GUI in the sandbox | app window, installer and printing cannot be executed here; produced and smoke-tested in CI only |
| L2 | `objects.githubusercontent.com` blocked | Electron/NSIS binaries cannot be fetched locally |
| L3 | No thermal printer or barcode scanner attached | ESC/POS output is generated and structurally tested, but physical printing is untested |
| L4 | No Authenticode certificate | released EXEs will be unsigned; Windows SmartScreen will warn |
| L5 | UI/visual QA pending | design system and screens not yet built |

## Blockers requiring the owner

| # | Blocker | Needed for |
| --- | --- | --- |
| B1 | Confirm licence terms (EULA text, price, support policy) | `LICENSE` file finalisation |
| B2 | Authenticode code-signing certificate (optional) | removing SmartScreen warnings |
| B3 | Physical printer + scanner models used by customers | hardware compatibility sign-off |
