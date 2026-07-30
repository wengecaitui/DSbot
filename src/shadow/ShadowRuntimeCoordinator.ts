/**
 * ShadowRuntimeCoordinator — deterministic coordinator owning one
 * ShadowRuntimeStateMachine, ShadowIntentBoundary, ShadowEventLedger,
 * and snapshot store.
 *
 * Stage 4B4.2 revision:
 * - fail-closed startup (distinguishes missing/stale/valid/tampered snapshot)
 * - no mutable-object accessors (immutable observations + scalar metrics only)
 * - ledger duplicate mismatch → RECOVERY_REQUIRED
 * - SHADOW_ACTIVE snapshot stored durably after ACTIVATE
 * - no bare require (explicit node:fs imports)
 *
 * REFERENCE SHADOW INFRASTRUCTURE ONLY.
 * NOT APPROVED FOR PAPER TESTNET OR LIVE.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ShadowRuntimeStateMachine } from './ShadowRuntimeStateMachine';
import type { ShadowState } from './ShadowRuntimeStateMachine';
import { ShadowEventLedger } from './ShadowEventLedger';
import { createShadowIntentBoundary, ShadowIntentBoundary } from './ShadowIntentBoundary';
import type { ObserveResult } from './ShadowIntentBoundary';
import type { CanonicalShadowEvent } from './CanonicalShadowEvent';
import type { ShadowDecisionOutcome } from './ShadowDecisionOutcome';
import type { ShadowIntentObservation } from './ShadowIntentObservation';
import type { ShadowLedgerEntry } from './ShadowEventLedger';
import type { ShadowRuntimeSnapshot } from './ShadowRuntimeSnapshot';
import { createShadowRuntimeSnapshot, storeSnapshot, loadSnapshot } from './ShadowRuntimeSnapshot';

export class ShadowRuntimeCoordinator {
  readonly #sm: ShadowRuntimeStateMachine;
  readonly #boundary: ShadowIntentBoundary;
  readonly #ledger: ShadowEventLedger;
  readonly #snapshotFile: string;

  constructor(ledgerFile: string, snapshotFile: string) {
    this.#sm = new ShadowRuntimeStateMachine();
    this.#boundary = createShadowIntentBoundary(this.#sm);
    this.#ledger = new ShadowEventLedger(ledgerFile);
    this.#snapshotFile = snapshotFile;
  }

  // ─── Safe read-only accessors (Contract 5) ──────────────────────────────

  get state(): ShadowState {
    return this.#sm.state;
  }

  /** Immutable copy of all current boundary observations. */
  get observations(): readonly ShadowIntentObservation[] {
    return this.#boundary.getObservations();
  }

  /** Number of observations currently in the boundary. */
  get observationCount(): number {
    return this.#boundary.size;
  }

  /** Number of entries in the ledger. */
  get ledgerSize(): number {
    return this.#ledger.size;
  }

  /** Latest ledger entry digest, or null if ledger is empty. */
  get latestLedgerDigest(): string | null {
    return this.#ledger.latestDigest;
  }

  /** Immutable copy of all ledger entries. */
  get ledgerEntries(): readonly ShadowLedgerEntry[] {
    return this.#ledger.getEntries();
  }

  // ─── startup — STOPPED → PRECHECKED → SHADOW_READY → ACTIVATE ───────────

  /**
   * Startup lifecycle. Contract (4B4.2):
   * - STOPPED → PRECHECKED
   * - PRECHECK_PASSED → SHADOW_READY, replay ledger entries via boundary.restore
   * - Validate or rebuild snapshot (fail-closed on tampered/mismatched)
   * - ACTIVATE → SHADOW_ACTIVE
   * - Store SHADOW_ACTIVE snapshot; if store fails, enter RECOVERY_REQUIRED
   */
  startup(): void {
    // 1. STOPPED → PRECHECKED
    this.#sm.transition('BEGIN_PRECHECK');

    try {
      // 2. PRECHECKED → SHADOW_READY, then replay ledger entries
      this.#sm.transition('PRECHECK_PASSED');
      // Now in SHADOW_READY — restore ledger entries
      const entries = this.#ledger.getEntries();
      for (const entry of entries) {
        this.#boundary.restore(entry.event, entry.observation);
      }

      // 3. Validate or rebuild snapshot (fail-closed on tampered/mismatched)
      this.#validateOrRebuildSnapshot();

      // 4. ACTIVATE → SHADOW_ACTIVE
      this.#sm.transition('ACTIVATE');

      // 5. Contract: durably store snapshot reflecting SHADOW_ACTIVE
      const snapshot = createShadowRuntimeSnapshot(this.#ledger, this.#boundary, this.#sm);
      storeSnapshot(snapshot, this.#ledger, this.#snapshotFile);
    } catch (err) {
      // Any failure after BEGIN_PRECHECK must transition to RECOVERY_REQUIRED.
      // Don't double-transition if #validateOrRebuildSnapshot already did.
      if (this.#sm.state !== 'RECOVERY_REQUIRED') {
        this.#sm.transition('RECOVERY_REQUIRED');
      }
      throw new Error(
        `ShadowRuntimeCoordinator.startup: failed — recovery required: ${(err as Error).message}`,
      );
    }
  }

  // ─── process ────────────────────────────────────────────────────────────

  /**
   * Process an event+outcome pair through the transaction pipeline.
   *
   * Contract (4B4.2): preserve transaction order:
   *   boundary.prepare → ledger durable append → boundary.commit → active snapshot durable store.
   * Any failure after processing begins yields rejection and RECOVERY_REQUIRED, never success.
   */
  process(
    event: CanonicalShadowEvent,
    outcome: ShadowDecisionOutcome,
  ): ObserveResult {
    // Only SHADOW_ACTIVE
    if (this.#sm.state !== 'SHADOW_ACTIVE') {
      return {
        status: 'rejected',
        code: 'INVALID_STATE',
        reason: `ShadowRuntimeCoordinator.process: only allowed in SHADOW_ACTIVE, current state: ${this.#sm.state}`,
      };
    }

    // 1. Prepare via boundary (validate only, no mutation)
    const token = this.#boundary.prepare(event, outcome);

    if (token.status === 'rejected') {
      // Handle conflict/late/gap with RECOVERY_REQUIRED transition
      if (token._sequenceStatus === 'conflict' || token._sequenceStatus === 'late' || token._sequenceStatus === 'gap') {
        this.#sm.transition('RECOVERY_REQUIRED');
        if (token._sequenceStatus === 'conflict') {
          return { status: 'conflict' };
        }
        if (token._sequenceStatus === 'late') {
          return { status: 'late' };
        }
        return { status: 'gap' };
      }
      return {
        status: 'rejected',
        code: token.code!,
        reason: token.reason!,
      };
    }

    // 2. Append to ledger (durable, fsync). Duplicates must flow through
    // ledger.append so the ledger's external-file integrity check runs —
    // never short-circuit duplicates before the ledger sees them.
    let appendResult: { duplicate: boolean };
    try {
      appendResult = this.#ledger.append(event, token.observation!);
    } catch (err) {
      // Ledger append failed — boundary unchanged, transition RECOVERY_REQUIRED
      this.#sm.transition('RECOVERY_REQUIRED');
      return {
        status: 'rejected',
        code: 'INVALID_STATE',
        reason: `ShadowRuntimeCoordinator.process: ledger append failed — recovery required: ${(err as Error).message}`,
      };
    }

    // Contract (4B4.2): ledger duplicate with missing/inconsistent boundary observation
    // is an invariant violation — enter RECOVERY_REQUIRED and reject.
    if (appendResult.duplicate) {
      const boundaryObs = this.#boundary.getObservation(token._eventId);
      if (!boundaryObs) {
        // Ledger has the entry but boundary doesn't — invariant violation
        this.#sm.transition('RECOVERY_REQUIRED');
        return {
          status: 'rejected',
          code: 'INVALID_STATE',
          reason: 'ShadowRuntimeCoordinator.process: ledger duplicate but boundary missing observation — recovery required',
        };
      }
      if (boundaryObs.observationId !== token.observation!.observationId) {
        // Ledger and boundary disagree on observation content — invariant violation
        this.#sm.transition('RECOVERY_REQUIRED');
        return {
          status: 'rejected',
          code: 'INVALID_STATE',
          reason: 'ShadowRuntimeCoordinator.process: ledger/boundary observation mismatch — recovery required',
        };
      }
      // Genuine duplicate (both ledger and boundary agree)
      return { status: 'duplicate', observation: boundaryObs };
    }

    // 3. Commit to boundary (must succeed after durable ledger write)
    try {
      this.#boundary.commit(token);
    } catch (err) {
      // Boundary commit failed after durable ledger write → RECOVERY_REQUIRED
      this.#sm.transition('RECOVERY_REQUIRED');
      return {
        status: 'rejected',
        code: 'INVALID_STATE',
        reason: `ShadowRuntimeCoordinator.process: boundary commit failed after ledger write — recovery required: ${(err as Error).message}`,
      };
    }

    // 4. Persist snapshot (Contract: never swallow, fail-closed)
    try {
      const snapshot = createShadowRuntimeSnapshot(this.#ledger, this.#boundary, this.#sm);
      storeSnapshot(snapshot, this.#ledger, this.#snapshotFile);
    } catch (err) {
      // Snapshot write failed but ledger+boundary committed → RECOVERY_REQUIRED
      this.#sm.transition('RECOVERY_REQUIRED');
      return {
        status: 'rejected',
        code: 'INVALID_STATE',
        reason: `ShadowRuntimeCoordinator.process: snapshot write failed — persisted but snapshot failed, recovery required: ${(err as Error).message}`,
      };
    }

    return { status: 'accepted', observation: token.observation! };
  }

  // ─── Control operations ─────────────────────────────────────────────────

  stop(): void {
    this.#sm.transition('STOP');
    try {
      this.#storeCurrentSnapshot();
    } catch (err) {
      // STOPPED is already fail-closed and has no recovery transition. Mark
      // the coordinator terminally failed rather than leave a stale snapshot
      // while reporting a successful stop.
      this.#sm.transition('FAIL');
      throw new Error(
        `ShadowRuntimeCoordinator.stop: snapshot persistence failed: ${(err as Error).message}`,
      );
    }
  }

  pause(): void {
    this.#sm.transition('PAUSE');
    try {
      this.#storeCurrentSnapshot();
    } catch (err) {
      this.#sm.transition('RECOVERY_REQUIRED');
      throw new Error(
        `ShadowRuntimeCoordinator.pause: snapshot persistence failed — recovery required: ${(err as Error).message}`,
      );
    }
  }

  resume(): void {
    this.#sm.transition('RESUME');
    try {
      this.#storeCurrentSnapshot();
    } catch (err) {
      this.#sm.transition('RECOVERY_REQUIRED');
      throw new Error(
        `ShadowRuntimeCoordinator.resume: snapshot persistence failed — recovery required: ${(err as Error).message}`,
      );
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  #storeCurrentSnapshot(): void {
    const snapshot = createShadowRuntimeSnapshot(this.#ledger, this.#boundary, this.#sm);
    storeSnapshot(snapshot, this.#ledger, this.#snapshotFile);
  }

  /**
   * Validate or rebuild snapshot during startup.
   *
   * Contract (4B4.2):
   * - Missing snapshot => deterministic rebuild
   * - Valid stale prefix => rebuild
   * - Exact valid snapshot => accept
   * - Malformed/tampered/mismatched => fail closed, enter RECOVERY_REQUIRED
   * Never catch all snapshot errors and rebuild.
   */
  #validateOrRebuildSnapshot(): void {
    const resolved = path.resolve(this.#snapshotFile);

    // Case: missing snapshot → deterministic rebuild
    if (!fs.existsSync(resolved)) {
      const snapshot = createShadowRuntimeSnapshot(this.#ledger, this.#boundary, this.#sm);
      storeSnapshot(snapshot, this.#ledger, this.#snapshotFile);
      return;
    }

    // Try to load and verify existing snapshot
    let loaded: ShadowRuntimeSnapshot;
    try {
      loaded = loadSnapshot(this.#snapshotFile, this.#ledger);
    } catch (err) {
      // loadSnapshot throws on malformed/tampered file — fail closed
      this.#sm.transition('RECOVERY_REQUIRED');
      throw new Error(
        `ShadowRuntimeCoordinator.startup: snapshot load failed — tampered or malformed: ${(err as Error).message}`,
      );
    }

    // Valid snapshot loaded. Distinguish: exact match vs stale prefix.
    // Exact match: snapshot.ledgerSize === ledger.size
    // Stale prefix: snapshot.ledgerSize < ledger.size
    if (loaded.ledgerSize === this.#ledger.size) {
      // Exact match: snapshot is current, accept
      return;
    }

    if (loaded.ledgerSize < this.#ledger.size) {
      // Stale prefix: ledger has grown — rebuild
      const snapshot = createShadowRuntimeSnapshot(this.#ledger, this.#boundary, this.#sm);
      storeSnapshot(snapshot, this.#ledger, this.#snapshotFile);
      return;
    }

    // ledgerSize > actual ledger size — impossible, tampered
    this.#sm.transition('RECOVERY_REQUIRED');
    throw new Error(
      'ShadowRuntimeCoordinator.startup: snapshot ledgerSize exceeds actual ledger — tampered',
    );
  }
}

/**
 * Convenience function: create coordinator, startup, return active coordinator.
 */
export function startCoordinator(
  ledgerFile: string,
  snapshotFile: string,
): ShadowRuntimeCoordinator {
  const coordinator = new ShadowRuntimeCoordinator(ledgerFile, snapshotFile);
  coordinator.startup();
  return coordinator;
}
