/**
 * Phase 7A — Hermes handshake contract and lifecycle core (public API).
 *
 * This module exports the CloddsBot-side handshake core. It deliberately does
 * NOT wire HTTP routes or the installed Hermes transport — those belong to
 * Phase 7B, after this contract is reviewed.
 *
 * Components:
 * - `createHandshakeCoordinator` — health-first pull authorization state machine.
 * - `createLifecycleHookRegistry` — typed hook registry bound to an existing
 *   gateway lifecycle (no second lifecycle truth).
 * - `createFlushNotifier` — monotonic configuration-flush notification contract.
 * - `createHandshakeCircuitBreaker` — fail-closed health-confirmation breaker.
 */

export type {
  CircuitState,
  CollectedHealth,
  CoordinatorLifecycleState,
  CoordinatorSnapshot,
  FlushNotifierSnapshot,
  FlushNotification,
  FlushResult,
  FlushRevision,
  HealthConfirmationResult,
  HealthReceipt,
  LifecycleGeneration,
  PullRejectionReason,
  PullResult,
} from './types';
export {
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_HEALTH_FRESHNESS_MS,
  DEFAULT_INSTRUCTION_TIMEOUT_MS,
  DEFAULT_MAX_TRACKED_RECEIPTS,
  DEFAULT_RECEIPT_TTL_MS,
  DEFAULT_SINK_TIMEOUT_MS,
} from './types';

export {
  createHandshakeCircuitBreaker,
  type HandshakeCircuitBreaker,
  type HandshakeCircuitBreakerOptions,
  type HandshakeCircuitBreakerSnapshot,
} from './circuit-breaker';

export {
  createLifecycleHookRegistry,
  type GatewayLifecycleLike,
  type HookErrorRecord,
  type LifecycleHookContext,
  type LifecycleHookRegistry,
  type LifecycleHookRegistryOptions,
  type LifecycleHookRegistrySnapshot,
  type LifecycleHooks,
} from './lifecycle-hooks';

export {
  createFlushNotifier,
  type FlushNotifier,
  type FlushNotifierOptions,
  type FlushSink,
} from './flush-notifier';

export {
  createHandshakeCoordinator,
  type HandshakeCoordinator,
  type HandshakeCoordinatorOptions,
  type HealthCollector,
  type InstructionSupplier,
} from './handshake-coordinator';
