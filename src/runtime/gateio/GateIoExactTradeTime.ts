/**
 * Gate trade event seconds are a decimal fact. Project to the canonical integer
 * millisecond clock without first multiplying an IEEE-754 approximation.
 */
export function gateIoExactSecondsToMilliseconds(source: string): number | null {
  if (typeof source !== 'string' || source.length === 0 || source.length > 256) return null;
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(source);
  if (match === null) return null;
  const exponentText = match[3];
  if (exponentText !== undefined && exponentText.length > 5) return null;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const fraction = match[2] ?? '';
  const digits = match[1]! + fraction;
  const shift = exponent - fraction.length + 3;
  const integerDigits = shift >= 0
    ? digits + '0'.repeat(shift)
    : digits.slice(0, Math.max(0, digits.length + shift));
  const milliseconds = BigInt(integerDigits || '0');
  if (milliseconds <= 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(milliseconds);
}
