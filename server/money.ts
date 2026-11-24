import { Decimal } from 'decimal.js';

// Exact decimal arithmetic for every peso amount. Never use JS floats for money.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type Dec = Decimal;
export const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
export const ZERO = new Decimal(0);
/** Round to centavos. */
export const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Database / JSON representation: fixed 2-decimal string. */
export const m = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
export const sum = (values: Decimal.Value[]) => values.reduce<Decimal>((a, b) => a.plus(b), ZERO);
export const maxD = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b);
export const minD = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);
