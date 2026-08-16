/**
 * Phase 7A test helpers: deterministic clock, ID factory, and a free-port
 * resolver for real ephemeral HTTP-gateway integration tests.
 */

import { createServer } from 'node:net';

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

/** Resolve an available ephemeral TCP port for a real HTTP listener. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}
