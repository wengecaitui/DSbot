/**
 * Phase 7A — Hermes handshake contract: shared types.
 *
 * These types describe the CloddsBot-side core that a later real Hermes
 * transport (Phase 7B) will wire against. Nothing here performs outbound
 * messaging, network I/O, or trading side effects; every non-deterministic
 * dependency (clock, ID generation, health collection, instruction supply,
 * flush notification) is injectable.
 */

/** Opaque, non-empty, single-use health-confirmation receipt material. */
export type HealthReceipt = string;

/** Monotonic lifecycle generation — increments on each start cycle. */
export type LifecycleGeneration = number;

/** Monotonic configuration-flush revision. */
export type FlushRevision = number;

/** Result of a health collection. Only `healthy` authorizes instruction pull. */
export type CollectedHealth = 'healthy' | 'unhealthy' | 'unknown';

/** Top-level coordinator lifecycle state. */
export type CoordinatorLifecycleState = 'stopped' | 'running';

/** Handshake circuit-breaker state. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** Why an instruction pull was rejected (fail-closed). */
export type PullRejectionReason =
  | 'STOPPED'
  | 'UNHEALTHY'
  | 'TIMED_OUT'
  | 'CIRCUIT_OPEN'
  | 'EMPTY_RECEIPT'
  | 'UNKNOWN_RECEIPT'
  | 'EXPIRED_RECEIPT'
  | 'REPLAYED_RECEIPT'
  | 'GENERATION_MISMATCH'
  | 'INSTRUCTION_UNAVAILABLE'
  | 'RECEIPT_UNAVAILABLE';

/** Outcome of an instruction pull. */
export type PullResult =
  | {
      authorized: true;
      receipt: HealthReceipt;
      generation: LifecycleGeneration;
      instruction: unknown;
    }
  | { authorized: false; reason: PullRejectionReason };

/** Outcome of a health-confirmation attempt. */
export interface HealthConfirmationResult {
  confirmed: boolean;
  receipt: HealthReceipt | null;
  generation: LifecycleGeneration;
  state: CoordinatorLifecycleState;
  health: CollectedHealth;
  circuitState: CircuitState;
  /** Present only when `confirmed` is false. */
  reason?: PullRejectionReason;
}

/** Immutable public snapshot of the handshake coordinator. */
export interface CoordinatorSnapshot {
  state: CoordinatorLifecycleState;
  generation: LifecycleGeneration;
  health: CollectedHealth;
  circuitState: CircuitState;
  consecutiveHealthFailures: number;
  startedAt: number | null;
  stoppedAt: number | null;
  lastHealthConfirmedAt: number | null;
  lastHealthStatus: CollectedHealth | null;
  /** Total number of receipts currently tracked (issued and not yet discarded). */
  trackedReceiptCount: number;
  /** Number of receipts that have been consumed by an authorized pull. */
  consumedReceiptCount: number;
}

/** Immutable public snapshot of the flush notifier. */
export interface FlushNotifierSnapshot {
  revision: FlushRevision;
  lastFlushedAt: number | null;
  lastAcknowledged: boolean;
  failures: number;
}

/** Result of a single configuration flush. */
export interface FlushResult {
  revision: FlushRevision;
  acknowledged: boolean;
  error?: string;
}

/** A configuration-flush notification delivered to the injected sink. */
export interface FlushNotification {
  revision: FlushRevision;
  flushedAt: number;
  payload?: unknown;
}

/** Default policy values (all overridable via factory options). */
export const DEFAULT_RECEIPT_TTL_MS = 30_000;
export const DEFAULT_HEALTH_FRESHNESS_MS = 60_000;
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 10_000;
export const DEFAULT_INSTRUCTION_TIMEOUT_MS = 10_000;
export const DEFAULT_SINK_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TRACKED_RECEIPTS = 1_000;
export const DEFAULT_BREAKER_FAILURE_THRESHOLD = 3;
export const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
