/**
 * Phase 7A — typed lifecycle-hook registry / adaptor.
 *
 * Binds to an EXISTING gateway lifecycle (start/stop) rather than owning or
 * duplicating it. The production `GatewayServer` already exposes `start()` /
 * `stop()`; this adaptor wraps such a lifecycle so that named hooks can run
 * around it without introducing a second lifecycle truth.
 *
 * Guarantees:
 * - Delegates start/stop to the supplied lifecycle (single source of truth).
 * - Idempotent: no double start / double stop of hooks or the delegate.
 * - Hook failure is contained (caught) and observable (recorded), and never
 *   prevents the delegate lifecycle from running.
 */

import { Mutex } from './internal';

export interface LifecycleHookContext {
  phase: 'start' | 'stop';
  /** Monotonic cycle count for this adaptor (increments on each successful start). */
  cycle: number;
  at: number;
}

export interface LifecycleHooks {
  onStart?: (context: LifecycleHookContext) => void | Promise<void>;
  onStop?: (context: LifecycleHookContext) => void | Promise<void>;
}

/** Minimal structural contract satisfied by the existing gateway lifecycle. */
export interface GatewayLifecycleLike {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface HookErrorRecord {
  name: string;
  phase: 'start' | 'stop';
  message: string;
  at: number;
}

export interface LifecycleHookRegistrySnapshot {
  registered: string[];
  cycle: number;
  running: boolean;
  errors: HookErrorRecord[];
}

export interface LifecycleHookRegistry {
  /** Register a named set of hooks. Returns an unregister function. */
  register(name: string, hooks: LifecycleHooks): () => void;
  /** Remove a named hook set. */
  unregister(name: string): void;
  /** List registered hook names. */
  list(): string[];
  /**
   * Wrap an existing gateway lifecycle so hooks run around it. The returned
   * lifecycle delegates to `lifecycle` and is safe to call repeatedly.
   */
  adapt(lifecycle: GatewayLifecycleLike): GatewayLifecycleLike;
  getSnapshot(): LifecycleHookRegistrySnapshot;
}

export interface LifecycleHookRegistryOptions {
  /** Injectable clock used in hook/error contexts (default Date.now). */
  now?: () => number;
}

export function createLifecycleHookRegistry(
  options: LifecycleHookRegistryOptions = {}
): LifecycleHookRegistry {
  const hooks = new Map<string, LifecycleHooks>();
  let running = false;
  let cycle = 0;
  const errors: HookErrorRecord[] = [];
  const now = options.now ?? (() => Date.now());
  const mutex = new Mutex();
  const MAX_ERRORS = 50;

  function recordError(name: string, phase: 'start' | 'stop', error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ name, phase, message, at: now() });
    if (errors.length > MAX_ERRORS) errors.shift();
  }

  async function runHooks(phase: 'start' | 'stop', context: LifecycleHookContext): Promise<void> {
    for (const [name, hookSet] of hooks) {
      const hook = phase === 'start' ? hookSet.onStart : hookSet.onStop;
      if (!hook) continue;
      try {
        await hook(context);
      } catch (error) {
        recordError(name, phase, error);
      }
    }
  }

  return {
    register(name: string, hookSet: LifecycleHooks): () => void {
      hooks.set(name, hookSet);
      return () => {
        if (hooks.get(name) === hookSet) hooks.delete(name);
      };
    },

    unregister(name: string): void {
      hooks.delete(name);
    },

    list(): string[] {
      return [...hooks.keys()];
    },

    adapt(lifecycle: GatewayLifecycleLike): GatewayLifecycleLike {
      return {
        start(): Promise<void> {
          return mutex.run(async () => {
            if (running) return; // serialized no double start
            try {
              await lifecycle.start();
            } catch (error) {
              // A failed start must leave a non-running, retryable state and
              // must not run any onStart hook nor advance the successful cycle.
              running = false;
              throw error;
            }
            // Only after the authoritative delegate start succeeds do we
            // surface the running state and run onStart hooks (P1-6 repair).
            running = true;
            cycle += 1;
            const context: LifecycleHookContext = { phase: 'start', cycle, at: now() };
            await runHooks('start', context);
          });
        },

        stop(): Promise<void> {
          return mutex.run(async () => {
            if (!running) return; // serialized no double stop
            try {
              await lifecycle.stop();
            } catch (error) {
              // Conservatively remain running so a later stop can retry.
              throw error;
            }
            const context: LifecycleHookContext = { phase: 'stop', cycle, at: now() };
            await runHooks('stop', context);
            running = false;
          });
        },
      };
    },

    getSnapshot(): LifecycleHookRegistrySnapshot {
      return {
        registered: [...hooks.keys()],
        cycle,
        running,
        errors: errors.map(e => ({ ...e })),
      };
    },
  };
}
