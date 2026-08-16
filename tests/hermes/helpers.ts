/**
 * Phase 7A test helpers: deterministic clock and ID factory.
 */

export interface Clock {
  now(): number;
  advance(ms: number): number;
  set(t: number): void;
}

export function createClock(start = 1_000_000): Clock {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
      return current;
    },
    set(t: number) {
      current = t;
    },
  };
}

export interface IdFactory {
  (): string;
  count: number;
}

export function createIdFactory(prefix = 'receipt-'): IdFactory {
  const fn = (() => {
    fn.count += 1;
    return `${prefix}${fn.count}`;
  }) as IdFactory;
  fn.count = 0;
  return fn;
}
