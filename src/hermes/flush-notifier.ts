/**
 * Phase 7A — monotonic configuration-flush notification contract.
 *
 * Produces a strictly increasing flush revision on every flush and delivers a
 * notification to an injected sink. The real Hermes transport is intentionally
 * absent: the default sink is a no-op, and outbound messaging is wired later
 * (Phase 7B) via dependency injection.
 *
 * Guarantees:
 * - Revisions are strictly monotonic (serialized; never reused or replayed).
 * - A duplicate or stale revision can never be presented as fresh.
 * - Sink failure is contained and observable; the revision still advances.
 */

import type {
  FlushNotifierSnapshot,
  FlushNotification,
  FlushResult,
  FlushRevision,
} from './types';
import { Mutex, deepFreeze } from './internal';

export type FlushSink = (notification: FlushNotification) => void | Promise<void>;

export interface FlushNotifierOptions {
  /** Injectable clock (default Date.now). */
  now?: () => number;
  /** Injected notification sink (default no-op — no real outbound messaging). */
  sink?: FlushSink;
}

export interface FlushNotifier {
  /** Advance to the next revision and deliver a notification to the sink. */
  flush(payload?: unknown): Promise<FlushResult>;
  /** Current revision (0 before the first flush). */
  getRevision(): FlushRevision;
  /** True only for the latest, already-issued revision (> 0). */
  isFresh(revision: FlushRevision): boolean;
  getSnapshot(): FlushNotifierSnapshot;
}

export function createFlushNotifier(options: FlushNotifierOptions = {}): FlushNotifier {
  const now = options.now ?? (() => Date.now());
  const sink = options.sink ?? (() => undefined);
  const mutex = new Mutex();

  let revision: FlushRevision = 0;
  let lastFlushedAt: number | null = null;
  let lastAcknowledged = true;
  let failures = 0;

  return {
    flush(payload?: unknown): Promise<FlushResult> {
      return mutex.run(async () => {
        revision += 1;
        const flushedAt = now();
        const notification: FlushNotification = { revision, flushedAt, payload };
        let acknowledged = true;
        let error: string | undefined;
        try {
          await sink(notification);
        } catch (cause) {
          acknowledged = false;
          failures += 1;
          error = cause instanceof Error ? cause.message : String(cause);
        }
        lastFlushedAt = flushedAt;
        lastAcknowledged = acknowledged;
        const result: FlushResult = { revision, acknowledged };
        if (error !== undefined) result.error = error;
        return result;
      });
    },

    getRevision(): FlushRevision {
      return revision;
    },

    isFresh(candidate: FlushRevision): boolean {
      return candidate > 0 && candidate === revision;
    },

    getSnapshot(): FlushNotifierSnapshot {
      return deepFreeze({
        revision,
        lastFlushedAt,
        lastAcknowledged,
        failures,
      });
    },
  };
}
