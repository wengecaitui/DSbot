/**
 * Phase 7B — authoritative application lifecycle-health flag.
 *
 * The Hermes handshake coordinator's health collector must reflect the real
 * application lifecycle, not a constant "healthy". This module provides a
 * fail-closed flag that the gateway flips at the authoritative lifecycle
 * boundaries:
 *
 * - `false` initially (and after any failed start), so no receipt can be
 *   issued before a full start has succeeded.
 * - `true` only after the complete AppGateway start returns (success boundary).
 * - `false` again at the BEGINNING of stop, so no receipt can be issued during
 *   shutdown even though the coordinator may still be "running" until its
 *   onStop hook fires after the delegate stop completes.
 *
 * This is intentionally a separate signal from the gateway's `started` flag
 * (which guards hot-reload) and from the coordinator's own `running` state, so
 * none of those stop-retryability semantics are affected.
 */

export interface LifecycleHealthFlag {
  /** True only after a full application start has succeeded. */
  isHealthy(): boolean;
  /** Mark the application fully started (called only at the success boundary). */
  markHealthy(): void;
  /** Mark the application not healthy (initial state and the start of stop). */
  markUnhealthy(): void;
}

export function createLifecycleHealthFlag(): LifecycleHealthFlag {
  let healthy = false;
  return {
    isHealthy: () => healthy,
    markHealthy: () => {
      healthy = true;
    },
    markUnhealthy: () => {
      healthy = false;
    },
  };
}
