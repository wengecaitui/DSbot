/**
 * ShadowIntentBoundary — sequence-aware observation boundary.
 *
 * Requires a real ShadowRuntimeStateMachine reference (rejects non-instance in constructor).
 * observe(event, outcome) is synchronous and fail-closed: returns rejected
 * ObserveResult instead of throwing. Never mutates caller inputs.
 * Sequence conflict, late, and gap still transition to RECOVERY_REQUIRED
 * and leave all maps unchanged.
 *
 * Uses ONLY verifiedEvent after verifyCanonicalShadowEvent — never reads
 * the original event after verification.
 */
import type { CanonicalShadowEvent } from './CanonicalShadowEvent';
import { verifyCanonicalShadowEvent } from './CanonicalShadowEvent';
import type { ShadowDecisionOutcome } from './ShadowDecisionOutcome';
import { isShadowDecisionOutcome } from './ShadowDecisionOutcome';
import type { ShadowIntentObservation } from './ShadowIntentObservation';
import { createShadowIntentObservation } from './ShadowIntentObservation';
import { ShadowRuntimeStateMachine } from './ShadowRuntimeStateMachine';

// ─── Sequence key ────────────────────────────────────────────────────────────

const SEP = '::';

function makeSequenceKey(exchange: string, symbol: string, source: string): string {
  return `${exchange}${SEP}${symbol}${SEP}${source}`;
}

// ─── Observe result ──────────────────────────────────────────────────────────

export type RejectedCode = 'INVALID_STATE' | 'INVALID_EVENT' | 'INVALID_OUTCOME' | 'CROSS_BINDING';

export type ObserveResult =
  | { status: 'accepted'; observation: ShadowIntentObservation }
  | { status: 'duplicate'; observation: ShadowIntentObservation }
  | { status: 'conflict' }
  | { status: 'late' }
  | { status: 'gap' }
  | { status: 'rejected'; code: RejectedCode; reason: string };

// ─── Boundary ─────────────────────────────────────────────────────────────────

export class ShadowIntentBoundary {
  private readonly sm: ShadowRuntimeStateMachine;

  /** Map eventId → observation */
  private readonly observationsByEventId = new Map<string, ShadowIntentObservation>();

  /** Map sequenceKey → last accepted sequence */
  private readonly lastSequenceByKey = new Map<string, number>();

  /** Map sequenceKey + sequence → eventId */
  private readonly eventIdByKeyAndSequence = new Map<string, string>();

  constructor(sm: ShadowRuntimeStateMachine) {
    // Reject anything not instanceof ShadowRuntimeStateMachine
    if (!(sm instanceof ShadowRuntimeStateMachine)) {
      throw new Error(
        'ShadowIntentBoundary: constructor requires instanceof ShadowRuntimeStateMachine',
      );
    }
    this.sm = sm;
  }

  observe(
    event: CanonicalShadowEvent,
    outcome: ShadowDecisionOutcome,
  ): ObserveResult {
    // 1. Invalid state → rejected, no mutation
    if (this.sm.state !== 'SHADOW_ACTIVE') {
      return {
        status: 'rejected',
        code: 'INVALID_STATE',
        reason: `ShadowIntentBoundary: observe only allowed in SHADOW_ACTIVE, current state: ${this.sm.state}`,
      };
    }

    // 2. Verify event → rejected if tampered
    const verifiedEvent = verifyCanonicalShadowEvent(event);
    if (!verifiedEvent) {
      return {
        status: 'rejected',
        code: 'INVALID_EVENT',
        reason: 'ShadowIntentBoundary: event verification failed',
      };
    }

    // 3. Verify outcome brand → rejected if unbranded
    if (!isShadowDecisionOutcome(outcome)) {
      return {
        status: 'rejected',
        code: 'INVALID_OUTCOME',
        reason: 'ShadowIntentBoundary: outcome is not a valid ShadowDecisionOutcome',
      };
    }

    // 4. Cross-check bindings between verifiedEvent and outcome — NEVER read original event
    if (outcome.exchange !== verifiedEvent.exchange) {
      return {
        status: 'rejected',
        code: 'CROSS_BINDING',
        reason: 'ShadowIntentBoundary: outcome exchange mismatch',
      };
    }
    if (outcome.symbol !== verifiedEvent.symbol) {
      return {
        status: 'rejected',
        code: 'CROSS_BINDING',
        reason: 'ShadowIntentBoundary: outcome symbol mismatch',
      };
    }
    if (outcome.decision !== verifiedEvent.eventType) {
      return {
        status: 'rejected',
        code: 'CROSS_BINDING',
        reason: 'ShadowIntentBoundary: outcome decision ≠ event eventType',
      };
    }

    // 5. Before duplicate detection, create and fully validate a candidate observation.
    // If candidate construction fails, return CROSS_BINDING rejected.
    let candidate: ShadowIntentObservation;
    try {
      candidate = createShadowIntentObservation(verifiedEvent, outcome);
    } catch (err: unknown) {
      return {
        status: 'rejected',
        code: 'CROSS_BINDING',
        reason: `ShadowIntentBoundary: candidate observation construction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 6. Check for exact duplicate — use verifiedEvent.eventId
    const existing = this.observationsByEventId.get(verifiedEvent.eventId);
    if (existing) {
      if (candidate.observationId === existing.observationId) {
        return { status: 'duplicate', observation: existing };
      }
      // Same eventId but different observation → reject (not duplicate)
      return {
        status: 'rejected',
        code: 'CROSS_BINDING',
        reason: 'ShadowIntentBoundary: duplicate eventId with mismatched observation',
      };
    }

    // 7. Sequence check — use verifiedEvent fields
    const key = makeSequenceKey(verifiedEvent.exchange, verifiedEvent.symbol, verifiedEvent.source);
    const lastSeq = this.lastSequenceByKey.get(key);

    if (lastSeq === undefined) {
      // First observation for this key
      if (verifiedEvent.sourceSequence !== 0) {
        // First sequence must be zero, otherwise gap
        this.sm.transition('RECOVERY_REQUIRED');
        return { status: 'gap' };
      }
      // Accept — fall through to construction
    } else {
      if (verifiedEvent.sourceSequence === lastSeq) {
        // Same key, same sequence, different eventId = conflict
        this.sm.transition('RECOVERY_REQUIRED');
        return { status: 'conflict' };
      }

      if (verifiedEvent.sourceSequence < lastSeq) {
        // Late
        this.sm.transition('RECOVERY_REQUIRED');
        return { status: 'late' };
      }

      if (verifiedEvent.sourceSequence !== lastSeq + 1) {
        // Gap
        this.sm.transition('RECOVERY_REQUIRED');
        return { status: 'gap' };
      }

      // Exact next sequence — fall through to accept
    }

    // 8. Accept: three synchronous Map updates — use verifiedEvent fields
    this.observationsByEventId.set(verifiedEvent.eventId, candidate);
    this.lastSequenceByKey.set(key, verifiedEvent.sourceSequence);
    this.eventIdByKeyAndSequence.set(
      `${key}${SEP}${verifiedEvent.sourceSequence}`,
      verifiedEvent.eventId,
    );

    return { status: 'accepted', observation: candidate };
  }

  getObservation(eventId: string): ShadowIntentObservation | undefined {
    return this.observationsByEventId.get(eventId);
  }

  getObservations(): readonly ShadowIntentObservation[] {
    const result = Array.from(this.observationsByEventId.values());
    // Return frozen copy — caller cannot mutate internal store
    Object.freeze(result);
    return result;
  }

  get size(): number {
    return this.observationsByEventId.size;
  }
}

export function createShadowIntentBoundary(
  sm: ShadowRuntimeStateMachine,
): ShadowIntentBoundary {
  return new ShadowIntentBoundary(sm);
}
