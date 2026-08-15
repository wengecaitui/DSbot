/**
 * Phase 7A internal helpers (not part of the public module index).
 *
 * These provide race-safe serialization and defensive-copy primitives used by
 * the coordinator and notifier. They are deliberately small and free of any
 * I/O so they remain deterministic in tests.
 */

/** A promise-chained mutual-exclusion lock for serializing async operations. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => fn());
    // Keep the chain alive regardless of whether fn() resolves or rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** Deep-freeze a plain object so callers cannot mutate returned snapshots. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Race a promise against a timeout; rejects with a generic timeout error. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('operation timed out'));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
