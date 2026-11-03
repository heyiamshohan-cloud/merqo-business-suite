/**
 * MERQO money & quantity arithmetic.
 *
 * DESIGN RULE (non-negotiable): monetary values are stored and computed as
 * INTEGER paisa (1 BDT = 100 paisa). Binary floating point is never used to
 * hold or accumulate money. Quantities are stored as INTEGER milli-units
 * (1 unit = 1000 milli) so that fractional retail units (kg, litre, metre)
 * stay exact.
 *
 * Rounding policy: HALF-UP away from zero, applied at the point a value is
 * materialised into an integer paisa/milli amount (line totals, tax, COGS).
 *
 * See docs/architecture/ACCOUNTING.md ("Money & rounding") for the rationale.
 */

/** 1 taka = 100 paisa. */
export const PAISA_PER_TAKA = 100;
/** Quantity fixed-point scale: 1 unit = 1000 qty-milli. */
export const QTY_SCALE = 1000;
/** Basis points scale used for tax rates: 10_000 bp = 100%. */
export const BP_SCALE = 10_000;

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Convert Bengali numerals to ASCII numerals. */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const idx = BN_DIGITS.indexOf(ch);
    out += idx >= 0 ? String(idx) : ch;
  }
  return out;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Parse a decimal string into a scaled integer using HALF-UP rounding.
 * Handles: thousands separators, spaces, a leading currency symbol, and a
 * leading sign. Rejects empty / non-numeric input.
 */
export function parseScaled(
  value: string | number,
  scale: number,
  label = 'amount',
): number {
  const rawInput =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? decimalStringFromNumber(value)
        : String(value)
      : String(value);

  let s = normalizeDigits(rawInput).trim();
  if (s === '') throw new MoneyError(`${label} is required`);
  s = s.replace(/[৳$]/g, '').replace(/\b(BDT|Tk|tk|TAKA|taka)\b/g, '');
  s = s.replace(/[\s,_']/g, '');

  let sign = 1;
  if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s === '') throw new MoneyError(`${label} is not a valid number`);

  if (!/^\d*(\.\d*)?$/.test(s) || s === '.' || s === '') {
    throw new MoneyError(`${label} is not a valid number: "${rawInput}"`);
  }

  const [intPartRaw = '', fracPartRaw = ''] = s.split('.');
  const intPart = intPartRaw === '' ? '0' : intPartRaw;

  const scaleDigits = String(scale).length - 1; // 100 -> 2, 1000 -> 3
  let frac = fracPartRaw;
  let carryFromRounding = 0;
  if (frac.length > scaleDigits) {
    const keep = frac.slice(0, scaleDigits);
    const nextDigit = frac.charCodeAt(scaleDigits) - 48;
    frac = keep;
    if (nextDigit >= 5) carryFromRounding = 1;
  }
  frac = frac.padEnd(scaleDigits, '0');

  // Build the integer without Number() so very long inputs stay exact.
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, '');
  if (combined.length > 15) {
    throw new MoneyError(`${label} is too large`);
  }
  const magnitude = Number(combined) + carryFromRounding;
  return sign * magnitude;
}

/** Numeric input -> shortest round-trip decimal string (avoids 0.1+0.2 artefacts). */
function decimalStringFromNumber(n: number): string {
  const s = String(n);
  if (s.includes('e') || s.includes('E')) return n.toFixed(10);
  return s;
}

/** Parse user input (taka) into integer paisa. Accepts "1,234.50", "১২৩৪.৫০", 1234.5 */
export function toPaisa(value: string | number): number {
  return parseScaled(value, PAISA_PER_TAKA, 'amount');
}

/** Parse user input (taka) into paisa, allowing an empty value => 0. */
export function toPaisaOrZero(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (s === '') return 0;
  return toPaisa(s);
}

/** Parse a quantity into integer milli-units (3 decimal places). */
export function toQtyMilli(value: string | number): number {
  return parseScaled(value, QTY_SCALE, 'quantity');
}

/** Parse a quantity allowing empty => 0. */
export function toQtyMilliOrZero(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (s === '') return 0;
  return toQtyMilli(s);
}

/** paisa -> taka as a plain number. DISPLAY/TEST ONLY — never for arithmetic. */
export function fromPaisa(paisa: number): number {
  return paisa / PAISA_PER_TAKA;
}

/** milli-units -> plain quantity number. DISPLAY/TEST ONLY. */
export function fromQtyMilli(qtyMilli: number): number {
  return qtyMilli / QTY_SCALE;
}

/** HALF-UP rounding for a non-negative-or-negative rational result. */
export function roundHalfUp(numerator: number, denominator = 1): number {
  if (denominator === 0) throw new MoneyError('Division by zero');
  const q = numerator / denominator;
  return q >= 0 ? Math.round(q) : -Math.round(-q);
}

/** unit price (paisa per unit) × quantity (milli) -> paisa, HALF-UP. */
export function mulPriceQty(unitPaisa: number, qtyMilli: number): number {
  return roundHalfUp(unitPaisa * qtyMilli, QTY_SCALE);
}

/** Apply a basis-point rate to a paisa amount (tax, discount %). */
export function applyBasisPoints(paisa: number, basisPoints: number): number {
  return roundHalfUp(paisa * basisPoints, BP_SCALE);
}

/** Convert a human percentage (e.g. 5 or 7.5) to basis points. */
export function percentToBasisPoints(percent: string | number): number {
  return parseScaled(percent, BP_SCALE / 100, 'percentage');
}

/** Basis points -> percent number for display. */
export function basisPointsToPercent(bp: number): number {
  return bp / 100;
}

/** Group digits with thousands separators. */
function groupThousands(digits: string): string {
  let out = '';
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    out = digits[i] + out;
    count++;
    if (count % 3 === 0 && i > 0) out = ',' + out;
  }
  return out;
}

export interface FormatMoneyOptions {
  /** Include the ৳ symbol (default true). */
  symbol?: boolean;
  /** Force a leading + for positive values (useful in ledgers). */
  signed?: boolean;
  /** Show paisa decimals (default true). When false, rounds HALF-UP to taka. */
  decimals?: boolean;
}

/** Format integer paisa for display, e.g. 1234556 -> "৳12,345.56". */
export function formatPaisa(paisa: number, opts: FormatMoneyOptions = {}): string {
  const { symbol = true, signed = false, decimals = true } = opts;
  const negative = paisa < 0;
  let abs = Math.abs(Math.trunc(paisa));
  let fraction = '';
  if (decimals) {
    fraction = String(abs % PAISA_PER_TAKA).padStart(2, '0');
    abs = Math.floor(abs / PAISA_PER_TAKA);
  } else {
    // round to whole taka, HALF-UP
    const taka = roundHalfUp(Math.abs(Math.trunc(paisa)), PAISA_PER_TAKA);
    abs = taka;
  }
  const body = `${groupThousands(String(abs))}${decimals ? '.' + fraction : ''}`;
  const sign = negative ? '-' : signed ? '+' : '';
  return `${sign}${symbol ? '৳' : ''}${body}`;
}

/** Format a quantity from milli-units (trailing zeros stripped). */
export function formatQty(qtyMilli: number): string {
  const negative = qtyMilli < 0;
  const abs = Math.abs(Math.trunc(qtyMilli));
  const whole = Math.floor(abs / QTY_SCALE);
  const frac = String(abs % QTY_SCALE).padStart(3, '0').replace(/0+$/, '');
  const body = frac ? `${groupThousands(String(whole))}.${frac}` : groupThousands(String(whole));
  return negative ? `-${body}` : body;
}

/** Parse a quantity into milli units from formatted display text. */
export function parseFormattedQty(text: string): number {
  return toQtyMilli(text);
}

/**
 * Split an integer total across weights so that the parts sum EXACTLY to the
 * total (largest-remainder method). Used for invoice-level discounts,
 * additional purchase costs and proportional allocations.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    // Degenerate: distribute as evenly as possible.
    const base = Math.floor(total / weights.length);
    const result = new Array(weights.length).fill(base);
    let remainder = total - base * weights.length;
    for (let i = 0; i < result.length && remainder !== 0; i++) {
      result[i] += 1;
      remainder -= 1;
    }
    return result;
  }
  const exact = weights.map((w) => (total * w) / weightSum);
  const floored = exact.map((v, i) => {
    const f = v >= 0 ? Math.floor(v) : Math.ceil(v);
    void i;
    return f;
  });
  let assigned = floored.reduce((a, b) => a + b, 0);
  let remainder = total - assigned;
  const order = exact
    .map((v, i) => ({ i, frac: v - floored[i] }))
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (remainder !== 0 && order.length > 0) {
    const target = order[k % order.length];
    const step = remainder > 0 ? 1 : -1;
    floored[target.i] += step;
    remainder -= step;
    k++;
  }
  assigned = floored.reduce((a, b) => a + b, 0);
  return floored;
}

/** Sum a list of paisa amounts safely. */
export function sumPaisa(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Assert a non-negative integer paisa amount. */
export function assertPaisa(value: number, label = 'amount'): void {
  if (!Number.isInteger(value)) throw new MoneyError(`${label} must be a whole number of paisa`);
  if (value < 0) throw new MoneyError(`${label} cannot be negative`);
}
