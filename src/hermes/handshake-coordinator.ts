/**
 * Phase 7A — health-first handshake coordinator.
 *
 * The authoritative CloddsBot-side gate between Hermes and the runtime. A
 * Hermes instruction pull is rejected unless it presents a fresh, unexpired,
 * unreplayed health-confirmation receipt that was issued by the SAME lifecycle
 * generation while the coordinator was running and healthy.
 *
 * Default state is non-authorizing. Unhealthy, timed-out, expired, replayed,
 * generation-mismatched, stopped, and open-circuit states never authorize a
 * pull. Every non-deterministic dependency (clock, ID generation, health
 * collection, instruction supply) is injectable, so the state machine is fully
 * deterministic in tests.
 */

import { randomBytes } from 'node:crypto';
import type {
  CollectedHealth,
  CoordinatorLifecycleState,
  CoordinatorSnapshot,
  HealthConfirmationResult,
  HealthReceipt,
  LifecycleGeneration,
  PullRejectionReason,
  PullResult,
} from './types';
import {
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_HEALTH_FRESHNESS_MS,
  DEFAULT_RECEIPT_TTL_MS,
} from './types';
import { Mutex, deepFreeze, withTimeout } from './internal';
import {
  createHandshakeCircuitBreaker,
  type HandshakeCircuitBreaker,
} from './circuit-breaker';

export type HealthCollector = () => Promise<CollectedHealth | boolean> | CollectedHealth | boolean;
export type InstructionSupplier = () => Promise<unknown> | unknown;

export interface HandshakeCoordinatorOptions {
  /** Injectable clock (default Date.now). */
  now?: () => number;
  /** Injectable ID source for opaque receipts (default crypto random 24 bytes → 48 hex chars). */
  randomId?: () => string;
  /** Health collector (default: always healthy, no I/O). */
  healthCollector?: HealthCollector;
  /** Instruction supplier (default: null — no real instruction in this phase). */
  instructionSupplier?: InstructionSupplier;
  /** Receipt time-to-live (default 30_000 ms). */
  receiptTtlMs?: number;
  /** Maximum age of the last successful health confirmation before a pull times out (default 60_000 ms). */
  healthFreshnessMs?: number;
  /** Timeout applied to the health collector (default 10_000 ms). */
  healthCheckTimeoutMs?: number;
  /** Circuit-breaker tuning. */
  breaker?: { failureThreshold?: number; cooldownMs?: number };
}

interface ReceiptRecord {
  generation: LifecycleGeneration;
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface HandshakeCoordinator {
  /** Transition into a new lifecycle generation (idempotent within a cycle). */
  start(): Promise<void>;
  /** Leave the running state (idempotent within a cycle). */
  stop(): Promise<void>;
  /** Collect health and, if authorizing, issue a fresh confirmation receipt. */
  confirmHealth(): Promise<HealthConfirmationResult>;
  /** Authorize an instruction pull against a presented receipt (single-use). */
  pullInstruction(receipt: HealthReceipt): Promise<PullResult>;
  getSnapshot(): CoordinatorSnapshot;
}

function defaultRandomId(): string {
  return randomBytes(24).toString('hex');
}

function normalizeHealth(value: CollectedHealth | boolean): CollectedHealth {
  if (value === true) return 'healthy';
  if (value === false) return 'unhealthy';
  return value;
}

export function createHandshakeCoordinator(
  options: HandshakeCoordinatorOptions = {}
): HandshakeCoordinator {
  const now = options.now ?? (() => Date.now());
  const randomId = options.randomId ?? defaultRandomId;
  const healthCollector = options.healthCollector ?? (() => 'healthy');
  const instructionSupplier = options.instructionSupplier ?? (() => null);

  const receiptTtlMs =
    options.receiptTtlMs !== undefined && options.receiptTtlMs > 0
      ? options.receiptTtlMs
      : DEFAULT_RECEIPT_TTL_MS;
  const healthFreshnessMs =
    options.healthFreshnessMs !== undefined && options.healthFreshnessMs > 0
      ? options.healthFreshnessMs
      : DEFAULT_HEALTH_FRESHNESS_MS;
  const healthCheckTimeoutMs =
    options.healthCheckTimeoutMs !== undefined && options.healthCheckTimeoutMs > 0
      ? options.healthCheckTimeoutMs
      : DEFAULT_HEALTH_CHECK_TIMEOUT_MS;

  const breaker: HandshakeCircuitBreaker = createHandshakeCircuitBreaker({
    failureThreshold: options.breaker?.failureThreshold,
    cooldownMs: options.breaker?.cooldownMs,
    now,
  });

  const mutex = new Mutex();
  const receipts = new Map<HealthReceipt, ReceiptRecord>();

  let running = false;
  let generation: LifecycleGeneration = 0;
  let health: CollectedHealth = 'unknown';
  let startedAt: number | null = null;
  let stoppedAt: number | null = null;
  let lastHealthConfirmedAt: number | null = null;
  let lastHealthStatus: CollectedHealth | null = null;
  let consumedReceiptCount = 0;

  function issueReceipt(): HealthReceipt {
    const receipt = randomId();
    // A receipt must be non-empty; if a test double returns an empty string,
    // fall back to a non-empty token so the invariant always holds.
    const value = receipt && receipt.length > 0 ? receipt : defaultRandomId();
    const issuedAt = now();
    receipts.set(value, {
      generation,
      issuedAt,
      expiresAt: issuedAt + receiptTtlMs,
      consumed: false,
    });
    return value;
  }

  function reject(reason: PullRejectionReason): PullResult {
    return { authorized: false, reason };
  }

  return {
    start(): Promise<void> {
      return mutex.run(async () => {
        if (running) return; // no double start
        running = true;
        generation += 1;
        health = 'unknown';
        startedAt = now();
        stoppedAt = null;
        lastHealthConfirmedAt = null;
        lastHealthStatus = null;
        consumedReceiptCount = 0;
        // A fresh generation starts with a clean, closed circuit but remains
        // non-authorizing until the first successful health confirmation.
        breaker.reset();
      });
    },

    stop(): Promise<void> {
      return mutex.run(async () => {
        if (!running) return; // no double stop
        running = false;
        health = 'unknown';
        stoppedAt = now();
        lastHealthConfirmedAt = null;
      });
    },

    confirmHealth(): Promise<HealthConfirmationResult> {
      return mutex.run(async () => {
        const base = {
          generation,
          state: (running ? 'running' : 'stopped') as CoordinatorLifecycleState,
          health,
          circuitState: breaker.getState().state,
        };

        if (!running) {
          return { ...base, confirmed: false, receipt: null, reason: 'STOPPED' as PullRejectionReason };
        }

        if (!breaker.acquireProbe()) {
          return { ...base, confirmed: false, receipt: null, reason: 'CIRCUIT_OPEN' as PullRejectionReason };
        }

        let status: CollectedHealth;
        try {
          const collected = await withTimeout(
            Promise.resolve().then(() => healthCollector()),
            healthCheckTimeoutMs
          );
          status = normalizeHealth(collected);
        } catch {
          status = 'unhealthy';
        }

        lastHealthStatus = status;
        health = status;

        if (status === 'healthy') {
          breaker.recordSuccess();
          lastHealthConfirmedAt = now();
          const receipt = issueReceipt();
          return {
            confirmed: true,
            receipt,
            generation,
            state: 'running',
            health: 'healthy',
            circuitState: breaker.getState().state,
          };
        }

        breaker.recordFailure();
        return {
          confirmed: false,
          receipt: null,
          generation,
          state: 'running',
          health: status,
          circuitState: breaker.getState().state,
          reason: 'UNHEALTHY',
        };
      });
    },

    pullInstruction(receipt: HealthReceipt): Promise<PullResult> {
      return mutex.run(async () => {
        // State gates first — the coordinator itself must be authorizing.
        if (!running) return reject('STOPPED');
        if (!breaker.allowsPull()) return reject('CIRCUIT_OPEN');
        if (health !== 'healthy') return reject('UNHEALTHY');
        if (
          lastHealthConfirmedAt === null ||
          now() - lastHealthConfirmedAt > healthFreshnessMs
        ) {
          return reject('TIMED_OUT');
        }

        // Receipt gates.
        if (!receipt || receipt.length === 0) return reject('EMPTY_RECEIPT');
        const record = receipts.get(receipt);
        if (!record) return reject('UNKNOWN_RECEIPT');
        if (record.generation !== generation) return reject('GENERATION_MISMATCH');
        if (now() > record.expiresAt) return reject('EXPIRED_RECEIPT');
        if (record.consumed) return reject('REPLAYED_RECEIPT');

        // Single-use: consume atomically within the serialized section.
        record.consumed = true;
        consumedReceiptCount += 1;

        let instruction: unknown = null;
        try {
          instruction = await Promise.resolve().then(() => instructionSupplier());
        } catch {
          // Instruction supply failure does not re-open the handshake; the
          // pull is still authorized but yields no instruction payload.
          instruction = null;
        }

        return { authorized: true, receipt, generation, instruction };
      });
    },

    getSnapshot(): CoordinatorSnapshot {
      const breakerState = breaker.getState();
      return deepFreeze({
        state: (running ? 'running' : 'stopped') as CoordinatorLifecycleState,
        generation,
        health,
        circuitState: breakerState.state,
        consecutiveHealthFailures: breakerState.consecutiveFailures,
        startedAt,
        stoppedAt,
        lastHealthConfirmedAt,
        lastHealthStatus,
        trackedReceiptCount: receipts.size,
        consumedReceiptCount,
      });
    },
  };
}
