/**
 * Phase 7B — bind the Hermes handshake coordinator to an existing lifecycle.
 *
 * The coordinator is the single source of Hermes authorizing state, and it must
 * follow the authoritative application lifecycle (createGateway's AppGateway
 * start/stop) rather than own a second lifecycle truth. This helper wires the
 * coordinator into a `LifecycleHookRegistry` so that:
 *
 * - `coordinator.start()` runs only AFTER the delegate lifecycle start has
 *   fully succeeded (never on a partial/failed start).
 * - `coordinator.stop()` (authorization revocation) runs at the BEGINNING of
 *   stop, so a previously issued, fresh, unconsumed receipt cannot authorize
 *   once stop begins — even if the delegate stop later throws. The onStop
 *   hook still fires after a successful delegate stop (idempotent), leaving
 *   the registry's conservative failed-stop retryability intact.
 * - A failed start leaves the coordinator stopped/non-authorizing, and stop
 *   preserves the Phase 7A generation + fail-closed invariants.
 *
 * When `onStartFailure` is supplied, a failed delegate start triggers a
 * compensating rollback of whatever the delegate started in that attempt (at
 * minimum the HTTP gateway/listener). The original start error is preserved and
 * rethrown unchanged, and the next start remains retryable (the listener must
 * be released rather than leaking an EADDRINUSE-prone socket).
 */

import type { GatewayLifecycleLike, LifecycleHookRegistry } from './lifecycle-hooks';
import { createLifecycleHookRegistry } from './lifecycle-hooks';
import type { HandshakeCoordinator } from './handshake-coordinator';

export interface LifecycleBindingOptions {
  /** The handshake coordinator to bind to the lifecycle. */
  coordinator: HandshakeCoordinator;
  /** Optional registry; one is created when omitted. */
  registry?: LifecycleHookRegistry;
  /** Optional hook name (default 'hermes-handshake'). */
  name?: string;
  /**
   * Optional compensating rollback invoked when the delegate lifecycle start
   * throws. Used to close resources partially started in that attempt (e.g. the
   * HTTP listener) so a later start is retryable. The original error is
   * preserved and rethrown after the rollback runs.
   */
  onStartFailure?: (error: unknown) => void | Promise<void>;
}

/** Strict lifecycle shape returned by the binding (methods always async). */
export interface BoundLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const DEFAULT_HANDSHAKE_HOOK_NAME = 'hermes-handshake';

/**
 * Wrap an existing gateway lifecycle so the handshake coordinator follows it.
 * Returns a lifecycle that delegates to `lifecycle` and is safe to call
 * repeatedly (no double start/stop). A failed start runs the optional
 * compensating rollback, leaves the coordinator stopped/non-authorizing, and
 * remains retryable.
 */
export function bindHandshakeToLifecycle(
  lifecycle: GatewayLifecycleLike,
  options: LifecycleBindingOptions
): BoundLifecycle {
  const registry = options.registry ?? createLifecycleHookRegistry();
  registry.register(options.name ?? DEFAULT_HANDSHAKE_HOOK_NAME, {
    onStart: () => options.coordinator.start(),
    onStop: () => options.coordinator.stop(),
  });
  const adapted = registry.adapt(lifecycle);

  return {
    async start(): Promise<void> {
      try {
        await adapted.start();
      } catch (error) {
        if (options.onStartFailure) {
          try {
            await options.onStartFailure(error);
          } catch {
            // The compensating rollback itself failed, but that must never
            // mask the original start error: its identity is preserved and
            // rethrown unchanged below.
          }
        }
        throw error;
      }
    },
    async stop(): Promise<void> {
      // Revoke authorization the moment authoritative stop begins: a
      // previously issued, fresh, unconsumed receipt must not authorize even
      // if the delegate stop later throws. Coordinator.stop() is idempotent
      // and does not advance the generation, so the onStop hook (which fires
      // again after a successful delegate stop) and a retried stop are safe.
      await options.coordinator.stop();
      await adapted.stop();
    },
  };
}
