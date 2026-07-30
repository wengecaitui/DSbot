/**
 * ShadowIntentBoundary — sequence-aware observation boundary.
 *
 * Requires a real ShadowRuntimeStateMachine reference (rejects non-instance in constructor).
 * observe(event, outcome) is synchronous and fail-closed: returns rejected
 * ObserveResult instead of throwing. Never mutates caller inputs.
 * Sequence conflict, late, and gap still transition to RECOVERY_REQUIRED
 * and leave all maps unchanged.
 *
 * Stage 4B4.2 adds:
 * - prepare(event, outcome): zero-mutation validation that returns a PreparedToken.
 * - commit(token): atomically applies a prepared token after integrity checks.
 * - restore(event, observation): SHADOW_READY-only replay from ledger entries.
 *
 * Uses ONLY verifiedEvent after verifyCanonicalShadowEvent — never reads
 * the original event after verification.
 */
import * as crypto from 'node:crypto';
import type { CanonicalShadowEvent } from './CanonicalShadowEvent';
import { verifyCanonicalShadowEvent } from './CanonicalShadowEvent';
import type { ShadowDecisionOutcome } from './ShadowDecisionOutcome';
import { isShadowDecisionOutcome } from './ShadowDecisionOutcome';
import type { ShadowIntentObservation } from './ShadowIntentObservation';
import { createShadowIntentObservation, verifyShadowIntentObservation } from './ShadowIntentObservation';
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

// ─── Prepared token ──────────────────────────────────────────────────────────

export type PreparedToken = {
  readonly status: 'accepted' | 'rejected';
  readonly observation: ShadowIntentObservation | null;
  readonly preparedId: string;
  readonly code?: RejectedCode;
  readonly reason?: string;
  // Sequence status for conflict/late/gap detection
  readonly _sequenceStatus?: 'conflict' | 'late' | 'gap' | null;
  // Internal binding — never exposed to caller
  readonly _boundaryTag: string;
  readonly _version: number;
  readonly _eventId: string;
  readonly _key: string;
  readonly _sourceSequence: number;
};

const PREPARE_DOMAIN = 'CLODDSBOT_SHADOW_PREPARE\u0000v1\u0000';

function computePreparedId(
  status: string,
  observationId: string | null,
  boundaryTag: string,
  version: number,
  eventId: string,
  key: string,
  sourceSequence: number,
): string {
  const preimage = PREPARE_DOMAIN + JSON.stringify({
    status,
    observationId,
    boundaryTag,
    version,
    eventId,
    key,
    sourceSequence,
  });
  return 'sp-' + crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ─── Restore result ──────────────────────────────────────────────────────────

export type RestoreResult =
  | { status: 'restored'; observation: ShadowIntentObservation }
  | { status: 'rejected'; code: RejectedCode; reason: string }
  | { status: 'gap' }
  | { status: 'duplicate' };

// ─── Boundary ─────────────────────────────────────────────────────────────────

export class ShadowIntentBoundary {
  readonly #sm: ShadowRuntimeStateMachine;
  readonly #boundaryTag: string;

  /** Map eventId → observation */
  private readonly observationsByEventId = new Map<string, ShadowIntentObservation>();

  /** Map sequenceKey → last accepted sequence */
  private readonly lastSequenceByKey = new Map<string, number>();

  /** Map sequenceKey + sequence → eventId */
  private readonly eventIdByKeyAndSequence = new Map<string, string>();

  /** Single-use tracking: committed preparedIds */
  #committedIds = new Set<string>();

  /** Object-identity tracking: only tokens issued by this boundary instance pass commit */
  #issuedTokens = new WeakSet<object>();

  /** Version counter: incremented on every successful commit */
  #version = 0;

  constructor(sm: ShadowRuntimeStateMachine) {
    // Reject anything not instanceof ShadowRuntimeStateMachine
    if (!(sm instanceof ShadowRuntimeStateMachine)) {
      throw new Error(
        'ShadowIntentBoundary: constructor requires instanceof ShadowRuntimeStateMachine',
      );
    }
    this.#sm = sm;
    // Unique per-instance tag for token binding
    this.#boundaryTag = crypto.randomBytes(16).toString('hex');
  }

  // ─── prepare — validate without mutation ─────────────────────────────────

  prepare(
    event: CanonicalShadowEvent,
    outcome: ShadowDecisionOutcome,
  ): PreparedToken {
    // 1. Invalid state → rejected, no mutation
    if (this.#sm.state !== 'SHADOW_ACTIVE') {
      return this.#makeRejectedToken('INVALID_STATE',
        `ShadowIntentBoundary: prepare only allowed in SHADOW_ACTIVE, current state: ${this.#sm.state}`);
    }

    // 2. Verify event → rejected if tampered
    const verifiedEvent = verifyCanonicalShadowEvent(event);
    if (!verifiedEvent) {
      return this.#makeRejectedToken('INVALID_EVENT',
        'ShadowIntentBoundary: event verification failed');
    }

    // 3. Verify outcome brand → rejected if unbranded
    if (!isShadowDecisionOutcome(outcome)) {
      return this.#makeRejectedToken('INVALID_OUTCOME',
        'ShadowIntentBoundary: outcome is not a valid ShadowDecisionOutcome');
    }

    // 4. Cross-check bindings between verifiedEvent and outcome
    if (outcome.exchange !== verifiedEvent.exchange) {
      return this.#makeRejectedToken('CROSS_BINDING',
        'ShadowIntentBoundary: outcome exchange mismatch');
    }
    if (outcome.symbol !== verifiedEvent.symbol) {
      return this.#makeRejectedToken('CROSS_BINDING',
        'ShadowIntentBoundary: outcome symbol mismatch');
    }
    if (outcome.decision !== verifiedEvent.eventType) {
      return this.#makeRejectedToken('CROSS_BINDING',
        'ShadowIntentBoundary: outcome decision ≠ event eventType');
    }

    // 5. Build candidate observation
    let candidate: ShadowIntentObservation;
    try {
      candidate = createShadowIntentObservation(verifiedEvent, outcome);
    } catch (err: unknown) {
      return this.#makeRejectedToken('CROSS_BINDING',
        `ShadowIntentBoundary: candidate observation construction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Duplicate check
    const existing = this.observationsByEventId.get(verifiedEvent.eventId);
    if (existing) {
      if (candidate.observationId === existing.observationId) {
        // Duplicate — return accepted token (will be recognized as duplicate on commit)
        return this.#makeAcceptedToken(candidate, verifiedEvent.eventId, '', 0);
      }
      return this.#makeRejectedToken('CROSS_BINDING',
        'ShadowIntentBoundary: duplicate eventId with mismatched observation');
    }

    // 7. Sequence check
    const key = makeSequenceKey(verifiedEvent.exchange, verifiedEvent.symbol, verifiedEvent.source);
    const lastSeq = this.lastSequenceByKey.get(key);

    if (lastSeq === undefined) {
      if (verifiedEvent.sourceSequence !== 0) {
        return this.#makeRejectedToken('CROSS_BINDING',
          'ShadowIntentBoundary: first sequence must be zero (gap)',
          'gap');
      }
    } else {
      if (verifiedEvent.sourceSequence === lastSeq) {
        return this.#makeRejectedToken('CROSS_BINDING',
          'ShadowIntentBoundary: conflict — same sequence with different eventId',
          'conflict');
      }
      if (verifiedEvent.sourceSequence < lastSeq) {
        return this.#makeRejectedToken('CROSS_BINDING',
          'ShadowIntentBoundary: late event',
          'late');
      }
      if (verifiedEvent.sourceSequence !== lastSeq + 1) {
        return this.#makeRejectedToken('CROSS_BINDING',
          'ShadowIntentBoundary: gap in sequence',
          'gap');
      }
    }

    return this.#makeAcceptedToken(candidate, verifiedEvent.eventId, key, verifiedEvent.sourceSequence);
  }

  // ─── commit — atomically apply a prepared token ──────────────────────────

  commit(token: PreparedToken): void {
    // 0. Must be in SHADOW_ACTIVE
    if (this.#sm.state !== 'SHADOW_ACTIVE') {
      throw new Error('ShadowIntentBoundary.commit: only allowed in SHADOW_ACTIVE');
    }

    // 1. Validate token shape — must have internal fields
    if (!token || typeof token !== 'object') {
      throw new Error('ShadowIntentBoundary.commit: invalid token');
    }

    // 2. Object-identity check: token must be an object issued by THIS boundary instance.
    // A shallow/deep copy, Proxy wrapper, or Object.create clone will fail this check.
    // MUST happen BEFORE any property read — prevents attacker-observable side-channels.
    if (!this.#issuedTokens.has(token as object)) {
      throw new Error('ShadowIntentBoundary.commit: token is a copy/forgery — not issued by this boundary');
    }

    // 3. Validate token fields (only after identity is confirmed)
    if (typeof token.preparedId !== 'string' || !token.preparedId.startsWith('sp-')) {
      throw new Error('ShadowIntentBoundary.commit: invalid preparedId');
    }
    if (typeof token._boundaryTag !== 'string') {
      throw new Error('ShadowIntentBoundary.commit: token not prepared by this boundary');
    }
    if (typeof token._version !== 'number' || !Number.isSafeInteger(token._version)) {
      throw new Error('ShadowIntentBoundary.commit: invalid token version');
    }

    // 4. Boundary-instance binding
    if (token._boundaryTag !== this.#boundaryTag) {
      throw new Error('ShadowIntentBoundary.commit: token prepared by different boundary instance');
    }

    // 5. Version check — token must match current version
    if (token._version !== this.#version) {
      throw new Error('ShadowIntentBoundary.commit: stale token (version mismatch)');
    }

    // 6. Single-use check
    if (this.#committedIds.has(token.preparedId)) {
      throw new Error('ShadowIntentBoundary.commit: token already committed (single-use)');
    }

    // 7. Integrity check — recompute preparedId
    const recomputedId = computePreparedId(
      token.status,
      token.observation ? token.observation.observationId : null,
      token._boundaryTag,
      token._version,
      token._eventId,
      token._key,
      token._sourceSequence,
    );
    if (recomputedId !== token.preparedId) {
      throw new Error('ShadowIntentBoundary.commit: forged token (preparedId mismatch)');
    }

    // 8. Verify the observation is valid
    if (token.status !== 'accepted' || !token.observation) {
      throw new Error('ShadowIntentBoundary.commit: cannot commit rejected token');
    }

    // 9. Verify observation integrity against an event (we check the maps)
    const eventId = token._eventId;
    const existing = this.observationsByEventId.get(eventId);
    if (existing) {
      if (token.observation.observationId === existing.observationId) {
        // Exact duplicate — mark as used and return silently
        this.#committedIds.add(token.preparedId);
        return;
      }
      throw new Error('ShadowIntentBoundary.commit: eventId already exists with different observation');
    }

    // 10. Sequence re-check (race condition guard)
    const key = token._key;
    const lastSeq = this.lastSequenceByKey.get(key);
    if (lastSeq === undefined) {
      if (token._sourceSequence !== 0) {
        throw new Error('ShadowIntentBoundary.commit: first sequence must be zero');
      }
    } else {
      if (token._sourceSequence !== lastSeq + 1) {
        throw new Error('ShadowIntentBoundary.commit: non-contiguous sequence (race)');
      }
    }

    // 11. Mark as used BEFORE mutations (atomic from this point)
    this.#committedIds.add(token.preparedId);

    // 12. Atomically update all three maps
    this.observationsByEventId.set(eventId, token.observation);
    this.lastSequenceByKey.set(key, token._sourceSequence);
    this.eventIdByKeyAndSequence.set(
      `${key}${SEP}${token._sourceSequence}`,
      eventId,
    );

    // 13. Bump version to invalidate all outstanding tokens
    this.#version++;
  }

  // ─── observe — backward-compatible compose of prepare + commit ──────────

  observe(
    event: CanonicalShadowEvent,
    outcome: ShadowDecisionOutcome,
  ): ObserveResult {
    // 1. Invalid state → rejected, no mutation
    if (this.#sm.state !== 'SHADOW_ACTIVE') {
      return {
        status: 'rejected',
        code: 'INVALID_STATE',
        reason: `ShadowIntentBoundary: observe only allowed in SHADOW_ACTIVE, current state: ${this.#sm.state}`,
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
        this.#sm.transition('RECOVERY_REQUIRED');
        return { status: 'gap' };
      }
      // Accept — fall through to construction
    } else {
      if (verifiedEvent.sourceSequence === lastSeq) {
        // Same key, same sequence, different eventId = conflict
        this.#sm.transition('RECOVERY_REQUIRED');
        return { status: 'conflict' };
      }

      if (verifiedEvent.sourceSequence < lastSeq) {
        // Late
        this.#sm.transition('RECOVERY_REQUIRED');
        return { status: 'late' };
      }

      if (verifiedEvent.sourceSequence !== lastSeq + 1) {
        // Gap
        this.#sm.transition('RECOVERY_REQUIRED');
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

    // Bump version to keep prepare/commit version in sync
    this.#version++;

    return { status: 'accepted', observation: candidate };
  }

  // ─── restore — only in SHADOW_READY from verified ledger entries ────────

  restore(
    event: CanonicalShadowEvent,
    observation: ShadowIntentObservation,
  ): RestoreResult {
    // 1. Only allowed in SHADOW_READY
    if (this.#sm.state !== 'SHADOW_READY') {
      throw new Error(
        `ShadowIntentBoundary.restore: only allowed in SHADOW_READY, current state: ${this.#sm.state}`,
      );
    }

    // 2. Verify event
    const verifiedEvent = verifyCanonicalShadowEvent(event);
    if (!verifiedEvent) {
      throw new Error('ShadowIntentBoundary.restore: event verification failed');
    }

    // 3. Verify observation against the verified event
    const verifiedObs = verifyShadowIntentObservation(observation, verifiedEvent);
    if (!verifiedObs) {
      throw new Error('ShadowIntentBoundary.restore: observation verification failed');
    }

    // 4. Cross-binding: observation must reference this exact event
    if (verifiedObs.sourceEventId !== verifiedEvent.eventId) {
      throw new Error('ShadowIntentBoundary.restore: observation sourceEventId does not match event.eventId');
    }

    // 5. Duplicate check
    if (this.observationsByEventId.has(verifiedEvent.eventId)) {
      throw new Error('ShadowIntentBoundary.restore: duplicate eventId');
    }

    // 6. Sequence check — strict contiguous enforcement
    const key = makeSequenceKey(verifiedEvent.exchange, verifiedEvent.symbol, verifiedEvent.source);
    const lastSeq = this.lastSequenceByKey.get(key);

    if (lastSeq === undefined) {
      if (verifiedEvent.sourceSequence !== 0) {
        throw new Error(
          `ShadowIntentBoundary.restore: first sequence must be zero, got ${verifiedEvent.sourceSequence}`,
        );
      }
    } else {
      if (verifiedEvent.sourceSequence !== lastSeq + 1) {
        throw new Error(
          `ShadowIntentBoundary.restore: non-contiguous sequence (expected ${lastSeq + 1}, got ${verifiedEvent.sourceSequence})`,
        );
      }
    }

    // 7. Accept — atomically update all three maps
    this.observationsByEventId.set(verifiedEvent.eventId, verifiedObs);
    this.lastSequenceByKey.set(key, verifiedEvent.sourceSequence);
    this.eventIdByKeyAndSequence.set(
      `${key}${SEP}${verifiedEvent.sourceSequence}`,
      verifiedEvent.eventId,
    );

    return { status: 'restored', observation: verifiedObs };
  }

  // ─── Read-only accessors ─────────────────────────────────────────────────

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

  // ─── Private helpers ─────────────────────────────────────────────────────

  #makeAcceptedToken(
    observation: ShadowIntentObservation,
    eventId: string,
    key: string,
    sourceSequence: number,
  ): PreparedToken {
    const preparedId = computePreparedId('accepted', observation.observationId, this.#boundaryTag, this.#version, eventId, key, sourceSequence);
    const token: PreparedToken = {
      status: 'accepted',
      observation,
      preparedId,
      _boundaryTag: this.#boundaryTag,
      _version: this.#version,
      _eventId: eventId,
      _key: key,
      _sourceSequence: sourceSequence,
    };
    Object.freeze(token);
    this.#issuedTokens.add(token);
    return token;
  }

  #makeRejectedToken(code: RejectedCode, reason: string, sequenceStatus?: string): PreparedToken {
    const preparedId = computePreparedId('rejected', null, this.#boundaryTag, this.#version, '', '', -1);
    const token: PreparedToken = {
      status: 'rejected',
      observation: null,
      preparedId,
      code,
      reason,
      _sequenceStatus: (sequenceStatus as PreparedToken['_sequenceStatus']) ?? null,
      _boundaryTag: this.#boundaryTag,
      _version: this.#version,
      _eventId: '',
      _key: '',
      _sourceSequence: -1,
    };
    Object.freeze(token);
    this.#issuedTokens.add(token);
    return token;
  }
}

export function createShadowIntentBoundary(
  sm: ShadowRuntimeStateMachine,
): ShadowIntentBoundary {
  return new ShadowIntentBoundary(sm);
}
