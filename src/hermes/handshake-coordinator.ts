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
  DEFAULT_INSTRUCTION_TIMEOUT_MS,
  DEFAULT_MAX_TRACKED_RECEIPTS,
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
  /** Timeout applied to the instruction supplier (default 10_000 ms). */
  instructionTimeoutMs?: number;
  /** Maximum tracked-receipt bound; issuing beyond it fails closed (default 1_000). */
  maxTrackedReceipts?: number;
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
  // Fail-closed defaults: with no injected health dependency the collector is
  // "unknown" (never authorizing), and with no injected supplier the pull has
  // no instruction to offer.
  const healthCollector = options.healthCollector ?? (() => 'unknown');
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
  const instructionTimeoutMs =
    options.instructionTimeoutMs !== undefined && options.instructionTimeoutMs > 0
      ? options.instructionTimeoutMs
      : DEFAULT_INSTRUCTION_TIMEOUT_MS;
  const maxTrackedReceipts =
    options.maxTrackedReceipts !== undefined && options.maxTrackedReceipts > 0
      ? options.maxTrackedReceipts
      : DEFAULT_MAX_TRACKED_RECEIPTS;

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

  const MAX_RECEIPT_ID_ATTEMPTS = 3;

  function pruneReceipts(nowMs: number): void {
    for (const [receipt, record] of receipts) {
      // Expired records are dead weight. Consumed tombstones are retained until
      // expiry so replay detection holds for the receipt's entire lifetime.
      if (nowMs >= record.expiresAt) receipts.delete(receipt);
    }
  }

  /**
   * Issue a unique, non-empty receipt or fail closed. Never silently replaces an
   * invalid injected ID with a different randomness source, and never overwrites
   * an existing receipt (collisions are retried within a bounded window).
   */
  function issueReceipt(): HealthReceipt | null {
    const nowMs = now();
    pruneReceipts(nowMs);
    if (receipts.size >= maxTrackedReceipts) return null;
    for (let attempt = 0; attempt < MAX_RECEIPT_ID_ATTEMPTS; attempt++) {
      const candidate = randomId();
      if (typeof candidate !== 'string' || candidate.trim().length === 0) continue; // invalid — no fallback
      if (receipts.has(candidate)) continue; // collision — retry
      receipts.set(candidate, {
        generation,
        issuedAt: nowMs,
        expiresAt: nowMs + receiptTtlMs,
        consumed: false,
      });
      return candidate;
    }
    return null;
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
        // A new generation invalidates and removes every prior-generation
        // receipt/tombstone: old receipts can never authorize, so retaining
        // them would only consume the new generation's bounded capacity.
        receipts.clear();
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
          const receipt = issueReceipt();
          if (receipt === null) {
            // A unique, non-empty receipt could not be issued — fail closed.
            return {
              confirmed: false,
              receipt: null,
              generation,
              state: 'running',
              health: 'healthy',
              circuitState: breaker.getState().state,
              reason: 'RECEIPT_UNAVAILABLE',
            };
          }
          lastHealthConfirmedAt = now();
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
        if (now() >= record.expiresAt) return reject('EXPIRED_RECEIPT');
        if (record.consumed) return reject('REPLAYED_RECEIPT');

        // Single-use: consume atomically within the serialized section.
        record.consumed = true;
        consumedReceiptCount += 1;

        let instruction: unknown = null;
        try {
          instruction = await withTimeout(
            Promise.resolve().then(() => instructionSupplier()),
            instructionTimeoutMs
          );
        } catch {
          // Supply failure or timeout: the receipt is already consumed, so the
          // pull rejects fail-closed rather than authorizing without payload.
          return reject('INSTRUCTION_UNAVAILABLE');
        }

        if (instruction === null || instruction === undefined) {
          return reject('INSTRUCTION_UNAVAILABLE');
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
