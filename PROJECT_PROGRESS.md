# MERQO — Project Progress

**Last updated:** 2026-11-03
**Application version:** 1.0.0
**Branch:** `arena/e9988ac4-merqo-business-suite`
**Database migration:** v1 `initial_schema`
**Latest commit:** see `git log -1`

This file is the durable state of the build: if the session is interrupted, resume from the
first row below that is not ✅ and do not recreate finished modules.

---

## Phase status

| Phase | Description | Status |
| --- | --- | --- |
| 0 | Environment & access audit | ✅ complete — `ENVIRONMENT_AUDIT.md` |
| 1 | Requirements analysis & traceability | ✅ complete — `REQUIREMENTS_TRACEABILITY.md` (R1–R50 + explicit non-claims) |
| 2 | System architecture | ✅ complete — `docs/architecture/` (architecture, accounting, inventory, database) |
| 3 | UI/UX foundation | ✅ complete — design tokens, light-only palette, bundled Noto Sans Bengali + Inter, 14 screens |
| 4 | Database & domain foundation | ✅ complete, tested |
| 5 | Core business modules | ✅ complete, tested — accounts, catalogue, inventory, sales, purchases, returns, payments, expenses, reports |
| 6 | Hardware & operational features | 🟡 implemented; physical printing/scanner unverified (no hardware) |
| 7 | Licensing & security | ✅ core complete + tested; activation UI complete |
| 8 | Additional EXE & installer | 🟡 owner tools verified as CLI bundles; Windows `.exe`/NSIS builds only from CI |
| 9 | Automated testing | ✅ 137 tests / 11 files passing |
| 10 | Manual & visual QA | ⬜ blocked — no display, no Windows host |
| 11 | Performance & security audit | 🟡 security posture implemented and documented; no profiling possible without a GUI |
| 12 | Documentation | ✅ architecture, printing, owner tools, user guide, changelog, README, licence |
| 13 | Final build | 🟡 bundles build locally; installer built in CI |
| 14 | Release | ⬜ pending — requires a Windows CI run and owner go-ahead |
| 15 | Final verification | ⬜ pending — Windows smoke test, printer test, installer test |

---

## What exists and is verified here

### Commands

| Command | Result in this environment |
| --- | --- |
| `npm run typecheck` | ✅ clean (`tsc --noEmit`, core + main + preload + renderer + tools) |
| `npm test` | ✅ **11 files / 137 tests passing** |
| `npm run build:renderer` | ✅ `dist/renderer` (Vite, ~268 kB JS + bundled fonts) |
| `npm run build:main` | ✅ `dist/main/index.cjs` (337 kB), `dist/preload/index.cjs` |
| `npm run build:owner-tools` | ✅ `dist/tools/{license-generator,db-utility}.cjs`; Windows `.exe` skipped off-Windows by design |
| `node dist/tools/license-generator.cjs …` | ✅ keygen → issue → inspect → verify (correct device passes, wrong device rejected) |
| `node dist/tools/db-utility.cjs …` | ✅ info / check / backup / verify / export / audit against a real database |

### Module inventory

| Layer | Modules |
| --- | --- |
| Foundation | money (integer paisa), clock, ids, errors, text, validation |
| Database | driver abstraction (`better-sqlite3` ↔ `node:sqlite` with automatic fallback), migrator with checksums, schema v1 (30 tables), bootstrap seed |
| Accounting | 30-account chart, journal posting/reversal, trial balance, ledgers, P&L, balance sheet, cash flow |
| Services | settings, sequences, audit trail |
| Catalogue | products, categories, brands, units, barcodes, stock levels |
| Inventory | moving weighted average, stock in/out/exact, opening stock, adjustments, valuation, low/out-of-stock, reconciliation |
| Sales | pricing, atomic sale, payments, void, held carts, listing, invoice detail |
| Purchases | landed cost, VAT input, supplier payable, void |
| Returns | sales returns (3 restock policies), purchase returns at exact cost |
| Payments | customer receipts, supplier payments, FIFO allocation |
| Expenses | categories, vouchers, edit-by-reversal, void |
| Reports | 25 builders + catalogue + dispatch + dashboard summary |
| Export | CSV (BOM, CRLF), dependency-free XLSX, print-ready Bengali HTML |
| Printing | receipt HTML (58/80 mm, bn/en), receipt text fallback, ESC/POS builder (QR, CODE128, raster, drawer), receipt model builders |
| Backup | `VACUUM INTO`, SHA-256, log, retention, verification, restore with safety copy, auto policy |
| Licensing | Ed25519 sign/verify, canonical JSON, key fingerprint, device fingerprint, activation, status, evaluation policy |
| Main process | paths, logger (rotation + redaction), device identity, app core (DB + auto-backup + audit), IPC registry (whitelist + licence guard), printing service |
| Preload | single frozen bridge (`call`, `onEvent`, `versions`) |
| Renderer | design tokens, ~40 primitives, 14 screens, i18n (bn/en), typed API client with Bengali error surfacing |
| Owner tools | licence generator, database utility |
| Delivery | `electron-builder.yml` (NSIS), CI workflow, Windows release workflow, icon pipeline |

---

## Known limitations (honest)

| # | Limitation | Impact |
| --- | --- | --- |
| L1 | No Windows machine, display or desktop session in the sandbox | the app window, visual QA and installer execution are unverified; bundles are built but not launched |
| L2 | `objects.githubusercontent.com` blocked | Electron and NSIS cannot be downloaded locally; Windows artefacts come only from CI |
| L3 | No thermal printer, cash drawer or barcode scanner | print *content* and ESC/POS *bytes* are tested; paper output is not |
| L4 | No Authenticode certificate | released installers will be unsigned; SmartScreen will warn |
| L5 | `better-sqlite3` cannot be compiled/downloaded here | the test suite runs on `node:sqlite`; the driver now falls back automatically when the native binding is missing |
| L6 | No GitHub Actions permission to inspect settings (403) | workflow behaviour must be confirmed by an actual run |
| L7 | No lawyer review of `LICENSE` | commercial terms are drafted, not legally reviewed |
| L8 | Offline licences cannot be revoked remotely | documented in README and traceability |

## Blockers requiring the owner

| # | Blocker | Needed for |
| --- | --- | --- |
| B1 | Confirm commercial terms (price, support, refund policy) and legal review of `LICENSE` | final licence text |
| B2 | Authenticode code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) | removing SmartScreen warnings |
| B3 | Actual printer and scanner models used by customers | hardware sign-off and per-model paper settings |
| B4 | Trademark search for the name "MERQO" | any claim of name availability |
| B5 | A Windows machine (or approval to publish from CI) for the final smoke test | phase 14/15 release verification |

---

## Next steps, in order

1. Push this branch and open the pull request; confirm CI (typecheck + tests + bundles) is green.
2. Run the Windows release workflow as a **draft** (`gh workflow run release.yml -f version=1.0.0 -f draft=true`) and inspect the produced `MERQO-Setup-1.0.0.exe` plus both owner `.exe` files.
3. Smoke-test the installer on a real Windows 10/11 machine: fresh install, first run, product creation, one cash sale, one credit sale, one return, one purchase, backup → restore, print on a 58 mm and an 80 mm printer.
4. With the owner present, generate the production key pair if the embedded development key is to be replaced, reissue licences, and confirm the fingerprint shown in **Licence** matches `owner-keys/merqo-public.pem`.
5. Record hardware results in `docs/PRINTING.md` (replace the "not tested" section with the models and outcomes that were actually tested).
6. Only after 3–5 pass: publish the release and hand over the owner tooling privately.
