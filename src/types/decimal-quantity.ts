/** Exact decimal arithmetic on finite, already-normalized number facts.
 * No epsilon-to-zero, precision truncation, lot rounding, or minimum-size uplift.
 * BigInt is transient; public/journal quantities remain the existing number contract.
 */
function parts(value: number): { coefficient: bigint; exponent: number } {
  if (!Number.isFinite(value)) throw new Error('QUANTITY_NOT_FINITE');
  const [mantissa, power = '0'] = value.toString().split('e');
  const decimals = mantissa!.split('.')[1]?.length ?? 0;
  return { coefficient: BigInt(mantissa!.replace('.', '')), exponent: Number(power) - decimals };
}
function number(coefficient: bigint, exponent: number): number {
  const value = Number(`${coefficient}e${exponent}`);
  if (!Number.isFinite(value) || (value === 0 && coefficient !== 0n))
    throw new Error('QUANTITY_OUT_OF_RANGE');
  return value;
}
export function addQuantity(a: number, b: number): number {
  const x = parts(a), y = parts(b), exponent = Math.min(x.exponent, y.exponent);
  return number(x.coefficient * 10n ** BigInt(x.exponent - exponent)
    + y.coefficient * 10n ** BigInt(y.exponent - exponent), exponent);
}
export function subtractQuantity(a: number, b: number): number { return addQuantity(a, -b); }
export function multiplyQuantity(a: number, b: number): number {
  const x = parts(a), y = parts(b);
  return number(x.coefficient * y.coefficient, x.exponent + y.exponent);
}
