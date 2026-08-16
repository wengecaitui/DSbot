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
import { DEFAULT_SINK_TIMEOUT_MS } from './types';
import { Mutex, deepFreeze, withTimeout } from './internal';

export type FlushSink = (notification: FlushNotification) => void | Promise<void>;

export interface FlushNotifierOptions {
  /** Injectable clock (default Date.now). */
  now?: () => number;
  /**
   * Injected notification sink. When omitted, flushes are NOT acknowledged:
   * no real outbound messaging happens until a sink is injected (Phase 7B).
   */
  sink?: FlushSink;
  /** Timeout applied to the sink (default 10_000 ms). */
  sinkTimeoutMs?: number;
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
  const sink = options.sink;
  const sinkTimeoutMs =
    options.sinkTimeoutMs !== undefined && options.sinkTimeoutMs > 0
      ? options.sinkTimeoutMs
      : DEFAULT_SINK_TIMEOUT_MS;
  const mutex = new Mutex();

  let revision: FlushRevision = 0;
  let lastFlushedAt: number | null = null;
  let lastAcknowledged = false;
  let failures = 0;

  return {
    flush(payload?: unknown): Promise<FlushResult> {
      return mutex.run(async () => {
        revision += 1;
        const flushedAt = now();
        const notification: FlushNotification = { revision, flushedAt, payload };
        let acknowledged = false;
        let error: string | undefined;

        if (!sink) {
          // No sink configured — fail closed rather than claim delivery.
          error = 'NO_SINK';
        } else {
          try {
            await withTimeout(
              Promise.resolve().then(() => sink(notification)),
              sinkTimeoutMs,
              'SINK_TIMEOUT'
            );
            acknowledged = true;
          } catch (cause) {
            acknowledged = false;
            // Never echo arbitrary sink exception text (it may contain
            // credentials). Distinguish the controlled timeout from a genuine
            // sink failure with stable, non-sensitive codes; NO_SINK is
            // retained above for the unconfigured case.
            error =
              cause instanceof Error && cause.message === 'SINK_TIMEOUT'
                ? 'SINK_TIMEOUT'
                : 'SINK_FAILED';
          }
        }

        if (!acknowledged) failures += 1;
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
      // A revision is fresh only if it is the latest AND was acknowledged.
      return candidate > 0 && candidate === revision && lastAcknowledged;
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
