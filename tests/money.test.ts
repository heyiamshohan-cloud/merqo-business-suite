import { describe, expect, it } from 'vitest';
import {
  allocate,
  applyBasisPoints,
  formatPaisa,
  formatQty,
  formatQty as fmtQty,
  mulPriceQty,
  percentToBasisPoints,
  roundHalfUp,
  toPaisa,
  toQtyMilli,
} from '../src/core/foundation/money';

describe('money: parsing', () => {
  it('parses plain, grouped and Bengali numerals', () => {
    expect(toPaisa('1234.56')).toBe(123456);
    expect(toPaisa('1,234.56')).toBe(123456);
    expect(toPaisa('৳1,234.56')).toBe(123456);
    expect(toPaisa('১২৩৪.৫০')).toBe(123450);
    expect(toPaisa(' 1 000 ')).toBe(100000);
    expect(toPaisa(1234.5)).toBe(123450);
    expect(toPaisa('0')).toBe(0);
    expect(toPaisa('-45.50')).toBe(-4550);
  });

  it('rounds HALF-UP at the paisa boundary', () => {
    expect(toPaisa('1.005')).toBe(101);
    expect(toPaisa('1.004')).toBe(100);
    expect(toPaisa('2.999')).toBe(300);
  });

  it('rejects invalid input instead of silently producing NaN', () => {
    expect(() => toPaisa('abc')).toThrow();
    expect(() => toPaisa('')).toThrow();
    expect(() => toPaisa('1.2.3')).toThrow();
  });

  it('parses quantities into milli-units exactly', () => {
    expect(toQtyMilli('2.5')).toBe(2500);
    expect(toQtyMilli(1)).toBe(1000);
    expect(toQtyMilli('0.001')).toBe(1);
    expect(toQtyMilli('০.৫')).toBe(500);
  });
});

describe('money: formatting', () => {
  it('formats paisa with the taka symbol and grouping', () => {
    expect(formatPaisa(123456)).toBe('৳1,234.56');
    expect(formatPaisa(-4550)).toBe('-৳45.50');
    expect(formatPaisa(0)).toBe('৳0.00');
    expect(formatPaisa(100000000)).toBe('৳1,000,000.00');
  });

  it('formats quantities without trailing zeros', () => {
    expect(formatQty(2500)).toBe('2.5');
    expect(formatQty(1000)).toBe('1');
    expect(formatQty(1)).toBe('0.001');
    expect(fmtQty(-1500)).toBe('-1.5');
  });
});

describe('money: arithmetic', () => {
  it('multiplies price by quantity with HALF-UP rounding', () => {
    expect(mulPriceQty(1000, 2500)).toBe(2500);
    expect(mulPriceQty(333, 1000)).toBe(333);
    expect(mulPriceQty(1, 500)).toBe(1); // 0.5 -> 1
  });

  it('applies VAT basis points', () => {
    expect(applyBasisPoints(100000, 500)).toBe(5000); // 5% of 1000.00
    expect(applyBasisPoints(100000, 750)).toBe(7500); // 7.5%
    expect(applyBasisPoints(33333, 500)).toBe(1667);
    expect(percentToBasisPoints('7.5')).toBe(750);
  });

  it('rounds half up symmetrically', () => {
    expect(roundHalfUp(5, 2)).toBe(3);
    expect(roundHalfUp(-5, 2)).toBe(-3);
    expect(roundHalfUp(4, 2)).toBe(2);
  });

  it('allocates a total without losing or inventing a paisa', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);

    const weighted = allocate(1000, [700, 300]);
    expect(weighted).toEqual([700, 300]);

    const tricky = allocate(100, [3, 3, 3]);
    expect(tricky.reduce((a, b) => a + b, 0)).toBe(100);

    const empty = allocate(250, [0, 0]);
    expect(empty.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it('never accumulates floating point error over many operations', () => {
    let total = 0;
    for (let i = 0; i < 1000; i++) total += toPaisa('0.10');
    expect(total).toBe(10000);
    expect(formatPaisa(total)).toBe('৳100.00');
  });
});
