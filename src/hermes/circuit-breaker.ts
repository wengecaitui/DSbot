/**
 * Phase 7A — fail-closed handshake circuit breaker.
 *
 * A small, dedicated breaker for the health-confirmation path. It is
 * intentionally separate from the trading circuit breakers (src/risk,
 * src/execution), which encode volatility/loss/spread semantics and pull in
 * feature-engineering dependencies. This one only tracks consecutive health
 * confirmation failures against an explicit threshold and cooldown.
 *
 * State machine:
 *
 *   CLOSED     — health confirmations are permitted; failures accumulate.
 *   OPEN       — confirmations are blocked until the cooldown elapses.
 *   HALF_OPEN  — one cooldown probe is permitted; its outcome (success or
 *                failure) decides recovery back to CLOSED or re-OPEN.
 *
 * The breaker never transitions CLOSED -> CLOSED except by a successful probe
 * in HALF_OPEN; there is no implicit reset path, so recovery can only happen
 * under the defined state machine.
 */

import type { CircuitState } from './types';
import { DEFAULT_BREAKER_FAILURE_THRESHOLD, DEFAULT_BREAKER_COOLDOWN_MS } from './types';

export interface HandshakeCircuitBreakerOptions {
  /** Consecutive health failures required to open the circuit (default 3). */
  failureThreshold?: number;
  /** Cooldown period before an OPEN circuit may attempt a HALF_OPEN probe (default 30_000 ms). */
  cooldownMs?: number;
  /** Injectable clock (default Date.now). */
  now?: () => number;
}

export interface HandshakeCircuitBreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface HandshakeCircuitBreaker {
  /** True only while CLOSED — the gate an instruction pull must pass. */
  allowsPull(): boolean;
  /** True when a health check may run: CLOSED, or OPEN with elapsed cooldown (→ HALF_OPEN probe). */
  acquireProbe(): boolean;
  /** Record a successful health confirmation. */
  recordSuccess(): void;
  /** Record a failed health confirmation. */
  recordFailure(): void;
  /** Reset to CLOSED with zero failures (used on lifecycle restart). */
  reset(): void;
  getState(): HandshakeCircuitBreakerSnapshot;
}

export function createHandshakeCircuitBreaker(
  options: HandshakeCircuitBreakerOptions = {}
): HandshakeCircuitBreaker {
  const failureThreshold =
    options.failureThreshold && options.failureThreshold > 0
      ? options.failureThreshold
      : DEFAULT_BREAKER_FAILURE_THRESHOLD;
  const cooldownMs =
    options.cooldownMs && options.cooldownMs > 0 ? options.cooldownMs : DEFAULT_BREAKER_COOLDOWN_MS;
  const now = options.now ?? (() => Date.now());

  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let openedAt: number | null = null;

  return {
    allowsPull(): boolean {
      return state === 'closed';
    },

    acquireProbe(): boolean {
      if (state === 'closed') return true;
      if (state === 'half_open') return false;
      // OPEN: permit a probe only once the cooldown has elapsed.
      if (openedAt !== null && now() - openedAt >= cooldownMs) {
        state = 'half_open';
        return true;
      }
      return false;
    },

    recordSuccess(): void {
      consecutiveFailures = 0;
      if (state === 'half_open') {
        state = 'closed';
        openedAt = null;
      }
    },

    recordFailure(): void {
      consecutiveFailures += 1;
      if (state === 'half_open') {
        // A failed cooldown probe re-opens immediately.
        state = 'open';
        openedAt = now();
        return;
      }
      if (consecutiveFailures >= failureThreshold) {
        state = 'open';
        openedAt = now();
      }
    },

    reset(): void {
      state = 'closed';
      consecutiveFailures = 0;
      openedAt = null;
    },

    getState(): HandshakeCircuitBreakerSnapshot {
      return { state, consecutiveFailures, openedAt };
    },
  };
}
