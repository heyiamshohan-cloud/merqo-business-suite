# MERQO — Accounting Architecture

MERQO keeps a **real double-entry ledger**. Every business document posts a balanced journal
entry; every financial report in the product is derived from that ledger or reconciled against
it by automated tests.

## 1. Invariants

Enforced in `src/core/accounting/journal.ts` — not in the UI, not by convention:

1. At least two lines per entry.
2. Each line is exactly one of debit / credit, and positive.
3. **Total debits === total credits**, in integer paisa, exactly. Unbalanced entries are refused.
4. Every referenced account must exist and be active.
5. Posted entries are never edited. Corrections are reversal entries.

`verifyAllJournalsBalanced()` re-checks the whole database and is used by the health checks and
the test suite.

## 2. Money & rounding

| Concern | Decision |
| --- | --- |
| Representation | integer **paisa** (1 BDT = 100 paisa) |
| Floats | never used for money or quantity |
| Quantity | integer **milli-units** (1 unit = 1000) for kg/litre/metre items |
| Rounding | HALF-UP, applied once when an amount is materialised |
| Allocation | largest-remainder (`allocate()`), sums exactly to the total |
| Tax rate | basis points (10 000 bp = 100 %) |

## 3. Chart of accounts (system codes)

| Code | Account | Type | Normal |
| --- | --- | --- | --- |
| 1000 | Cash in Hand | asset | Dr |
| 1010 | Bank Account | asset | Dr |
| 1020 | Mobile Financial Service (bKash/Nagad/Rocket) | asset | Dr |
| 1030 | Card Settlement Receivable | asset | Dr |
| 1100 | Accounts Receivable (Customers) | asset | Dr |
| 1200 | Inventory | asset | Dr |
| 1300 | VAT Input | asset | Dr |
| 2000 | Accounts Payable (Suppliers) | liability | Cr |
| 2100 | VAT Payable | liability | Cr |
| 2200 | Customer Advance | liability | Cr |
| 3000 | Owner Capital | equity | Cr |
| 3100 | Opening Balance Equity | equity | Cr |
| 3200 | Retained Earnings | equity | Cr |
| 3300 | Owner Drawings | equity | Cr |
| 4000 | Sales Revenue | revenue | Cr |
| 4010 | Sales Discount | revenue (contra) | Dr |
| 4020 | Sales Returns | revenue (contra) | Dr |
| 4900 | Other Income | revenue | Cr |
| 5000 | Cost of Goods Sold | expense | Dr |
| 5100 | Inventory Adjustment | expense | Dr |
| 5200 | Cash Short / Over | expense | Dr |
| 6000–6090 | Operating expenses (rent, electricity, internet, salary, transport, packaging, maintenance, other) | expense | Dr |

## 4. Posting rules

Notation: amounts net of tax unless stated. `D` = discount, `T` = tax.

### 4.1 Sale (completed invoice)
Let `G` = gross sales (Σ unit price × qty, tax-exclusive), `D` = item + invoice discounts,
`T` = VAT, `P` = amount paid, `AR` = `G − D + T − P`, `C` = COGS at moving-average cost.

```
Dr  Cash/Bank/MFS/Card ...... P        (one line per payment method)
Dr  Accounts Receivable ..... AR       (party = customer)
Dr  Sales Discount .......... D
    Cr  Sales Revenue ....... G
    Cr  VAT Payable ......... T
Dr  Cost of Goods Sold ...... C
    Cr  Inventory ........... C
```
Total debits `P + AR + D + C = (G − D + T) + D + C = G + T + C` = total credits. ✔

### 4.2 Purchase
Let `G` = gross purchase, `D` = discounts, `A` = additional landed costs, `T` = input VAT,
`I = G − D + A` (capitalised), total invoice `= I + T`.

```
Dr  Inventory ............... I
Dr  VAT Input ............... T
    Cr  Accounts Payable .... I + T    (party = supplier)
```
Supplier payment is a **separate** entry: `Dr AP / Cr Cash|Bank|MFS`.

### 4.3 Sales return (resalable goods)
```
Dr  Sales Returns ........... net
Dr  VAT Payable ............. tax
    Cr  Cash/Bank ........... total     (cash refund)      OR
    Cr  Accounts Receivable . total     (credit to customer)
Dr  Inventory ............... cost
    Cr  Cost of Goods Sold .. cost
```
Damaged goods: the cost lines are **omitted** — the cost stays in COGS as a real loss and the
goods are not restocked.

### 4.4 Purchase return
```
Dr  Accounts Payable (or Cash) ... landed cost
    Cr  Inventory ................. landed cost
```

### 4.5 Customer receipt
```
Dr  Cash/Bank/MFS .... amount
    Cr  Accounts Receivable ... allocated portion   (party = customer)
    Cr  Customer Advance ...... unallocated portion (advance only)
```

### 4.6 Supplier payment
```
Dr  Accounts Payable ... amount   (party = supplier)
    Cr  Cash/Bank/MFS .. amount
```

### 4.7 Expense
```
Dr  <expense category account> ... amount
    Cr  Cash/Bank/MFS ............. amount
```

### 4.8 Opening balances
Posted as a balanced journal (`Dr Inventory / Cr Opening Balance Equity`, and similarly for
cash and capital). Nothing is injected directly into a balance column.

## 5. Party sub-ledger

`journal_lines` carries an optional `(party_type, party_id)` dimension. Receivable and payable
balances per customer/supplier are computed from those lines, which means:

* customer due report = Σ AR party lines,
* party statement = AR/AP party lines with running balance,
* both reconcile with the 1100/2000 control accounts **by construction**.

## 6. Reports

| Report | Source |
| --- | --- |
| Trial balance | `accountBalances()` over the journal window |
| General / account ledger | `ledger()` with running balance |
| Customer / supplier statement | `ledger()` filtered by party |
| Profit & Loss | revenue − contra-revenue − COGS − operating expenses + other income |
| Balance sheet | account types + current-period earnings, asserted balanced |
| Cash flow | cash/bank/MFS/card lines grouped by source document |

P&L presentation:

```
Gross sales
 − Sales discounts
 − Sales returns
= Net sales
 − Cost of goods sold
= Gross profit
 − Operating expenses (incl. inventory adjustments)
 + Other income
= Net profit
```

Revenue recognition follows the **accrual** basis: an invoice creates revenue even when the
customer pays later; the cash report is separate. This distinction is asserted by tests.

## 7. VAT

VAT is configurable per product (basis points) and globally switchable. Prices may be entered
tax-inclusive or tax-exclusive (`tax.prices_include_tax`); inclusive prices are converted to a
tax-exclusive basis before discounts and revenue are computed, so reported revenue is identical
either way.

MERQO does **not** claim compliance with any specific VAT authority. It provides the mechanics;
the rate, registration and filing obligations are the business's responsibility.

## 8. Immutability & audit

- No code path updates or deletes a `journal_entries` / `journal_lines` row.
- Voids and corrections create reversal entries linked both ways
  (`reverses_entry_id`, `reversed_by_entry_id`).
- Every mutation appends to `audit_log` (actor, instant, action, entity, before/after JSON).
