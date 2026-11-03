# MERQO — Inventory & Costing

## 1. Method: moving weighted average (perpetual)

MERQO uses **perpetual moving weighted average** costing. It was chosen over FIFO because it is
exact with integer arithmetic, needs no lot tracking, and behaves predictably for the mixed
catalogue a Bangladeshi general retail shop carries (groceries, cosmetics, electronics,
clothing).

### State

`stock_levels` holds, per product:

| Column | Meaning |
| --- | --- |
| `qty` | quantity on hand, **milli-units** (1 unit = 1000) |
| `value` | **total** inventory value on hand, integer paisa |

Unit cost is *derived*: `value / qty`. It is never stored, so it can never drift.

### Why total value instead of a rounded unit cost

If a per-unit average cost were rounded and stored, every receipt/sale would introduce a
rounding error that accumulates; inventory value would stop matching the ledger. By keeping the
aggregate value and slicing it proportionally, the sum of COGS over the life of the item plus
closing stock equals exactly the cost of goods available. When the last unit leaves, any
residual value is absorbed into COGS so inventory can never hold a phantom balance.

### Movements

| Movement | Effect on qty | Effect on value |
| --- | --- | --- |
| `opening` | +qty | + stated cost |
| `purchase` | +qty | + landed cost (net of discount, plus allocated additional cost) |
| `sale` | −qty | − proportional value (this *is* COGS) |
| `sale_return` (resalable) | +qty | + original cost of the returned units |
| `sale_return` (damaged) | 0 | 0 (cost remains in COGS as a loss) |
| `purchase_return` | −qty | − exact capitalised value returned |
| `adjustment` / `damage` | ±qty | ± value at current average |
| `purchase void` | −qty | − exact capitalised value |

Sales-return and purchase-return value reversals use **exact** values rather than the current
average, so returning goods to a supplier after prices changed cannot shift the valuation of
the remaining stock.

### Issue price

```
cogs = round_half_up(value × qty_out / qty_on_hand)
```
If `qty_after == 0`, `cogs = value` (absorbing residual). Negative stock, when enabled, is
valued at the last known average cost.

## 2. Negative stock

Default: **blocked**. Selling more than on hand raises `INSUFFICIENT_STOCK` with a Bengali
message naming the product and both quantities. The behaviour can be enabled explicitly in
Settings (`inventory.allow_negative`) for shops that invoice before entering goods; it is
recorded, never silent.

## 3. Guarantees proven by tests

`tests/inventory.test.ts`, `tests/accounting.test.ts`, `tests/returns.test.ts`,
`tests/purchases.test.ts` assert:

1. `stock_levels.value` always equals the **Inventory (1200)** account balance
   (`reconcileInventoryWithLedger().difference === 0`) after sales, purchases, returns,
   adjustments and voids.
2. COGS + closing stock equals cost of goods available.
3. Emptied stock has zero value.
4. No stock change exists without a `stock_moves` row carrying product, quantity, direction,
   instant, business date, reason, reference and operator.

## 4. Stock movements ledger

Every movement row records: product, signed quantity, unit cost, signed value, movement type,
reference document, free-text reason, note and operator. The Stock Movement report and the
product history screen read this table directly — stock can never change silently.

## 5. Adjustments

Manual adjustments (physical count, damage, expiry) require a reason and return the value delta
so the caller can post `Dr Inventory Adjustment / Cr Inventory` (loss) or the reverse (gain).
Opening stock is only allowed while a product has zero stock, and posts through
`Dr Inventory / Cr Opening Balance Equity`.
