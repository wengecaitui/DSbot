import { isDeepStrictEqual } from 'node:util';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/;

export function dictionaryViolation(reason: string): never {
  throw new Error(`PHASE_9B_RESEARCH_DICTIONARY_INVALID:${reason}`);
}

/**
 * Descriptor-only structural gate for caller-owned Phase 9B contract data.
 * It runs before semantic property reads so accessors are rejected, never
 * invoked. Shared references are allowed; cycles are not.
 */
export function assertPlainInertData(value: unknown, rootName: string): void {
  const active = new WeakSet<object>();

  function inspect(current: unknown, path: string): void {
    if (typeof current === 'function') dictionaryViolation(`FUNCTION:${path}`);
    if (typeof current === 'symbol') dictionaryViolation(`SYMBOL_VALUE:${path}`);
    if (current === null || typeof current !== 'object') return;

    if (active.has(current)) dictionaryViolation(`CYCLE:${path}`);
    active.add(current);
    try {
      if (Object.getOwnPropertySymbols(current).length > 0) {
        dictionaryViolation(`SYMBOL_PROPERTY:${path}`);
      }

      if (Array.isArray(current)) {
        const propertyNames = Object.getOwnPropertyNames(current);
        for (const propertyName of propertyNames) {
          if (propertyName === 'length') continue;
          if (!/^(0|[1-9]\d*)$/.test(propertyName) || Number(propertyName) >= current.length) {
            dictionaryViolation(`ARRAY_CUSTOM_PROPERTY:${path}`);
          }
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (descriptor === undefined) dictionaryViolation(`ARRAY_HOLE:${path}`);
          if (descriptor.get !== undefined || descriptor.set !== undefined) {
            dictionaryViolation(`ARRAY_ACCESSOR:${path}[${index}]`);
          }
          inspect(descriptor.value, `${path}[${index}]`);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        dictionaryViolation(`NON_PLAIN_OBJECT:${path}`);
      }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          dictionaryViolation(`ACCESSOR:${path}.${key}`);
        }
        inspect(descriptor.value, `${path}.${key}`);
      }
    } finally {
      active.delete(current);
    }
  }

  inspect(value, rootName);
}

export function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    dictionaryViolation(`${name}_NOT_OBJECT`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.getOwnPropertyNames(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    dictionaryViolation(`${name}_FIELDS`);
  }
}

export function denseArray(value: unknown, name: string, allowEmpty = false): readonly unknown[] {
  if (!Array.isArray(value)) dictionaryViolation(`${name}_NOT_ARRAY`);
  if (!allowEmpty && value.length === 0) dictionaryViolation(`${name}_EMPTY`);
  return value;
}

export function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) dictionaryViolation(name);
  return value;
}

export function version(value: unknown, name: string): string {
  if (typeof value !== 'string' || !VERSION.test(value)) dictionaryViolation(name);
  return value;
}

export function boundedProse(value: unknown, name: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || value.trim() !== value
  ) {
    dictionaryViolation(name);
  }
  return value;
}

export function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (!allowed.includes(value as T)) dictionaryViolation(name);
  return value as T;
}

export function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') dictionaryViolation(name);
  return value;
}

export function safeIntegerAtLeast(value: unknown, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) dictionaryViolation(name);
  return value as number;
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
