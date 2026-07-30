/**
 * ShadowIntentObservation — identity-bound observation with SHA-256 observationId.
 *
 * Factory receives verified CanonicalShadowEvent and validated ShadowDecisionOutcome.
 * First verifies the event and cross-checks every duplicated/semantic field.
 * Uses ONLY verifiedEvent fields, never reading the original event after verification.
 * Deep-clones/freezes riskAdmission and output via cloneCanonicalValue.
 */
import * as crypto from 'crypto';
import { canonicalSerialize, cloneCanonicalValue } from './CanonicalJson';
import type { CanonicalShadowEvent } from './CanonicalShadowEvent';
import { verifyCanonicalShadowEvent } from './CanonicalShadowEvent';
import type { ShadowDecisionOutcome, RiskAdmission } from './ShadowDecisionOutcome';
import { isShadowDecisionOutcome } from './ShadowDecisionOutcome';

// ─── Types ───────────────────────────────────────────────────────────────────

export const OBS_SCHEMA_VERSION = 'cloddsbot.shadow.observation.v1' as const;

export interface ShadowIntentObservation {
  readonly schemaVersion: typeof OBS_SCHEMA_VERSION;
  readonly sourceEventId: string;
  readonly exchange: string;
  readonly symbol: string;
  readonly source: string;
  readonly sourceSequence: number;
  readonly eventTimeMs: number;
  readonly decision: 'trade' | 'defense' | 'skip';
  readonly direction: 'long' | 'short' | 'hold';
  readonly reason: string;
  readonly blockedReason: string | null;
  readonly intentId: string | null;
  readonly riskAdmission: RiskAdmission;
  readonly observationId: string;
}

// ─── Exact key sets for verifier ──────────────────────────────────────────────

const OBS_KEYS = new Set([
  'schemaVersion', 'sourceEventId', 'exchange', 'symbol', 'source',
  'sourceSequence', 'eventTimeMs', 'decision', 'direction',
  'reason', 'blockedReason', 'intentId', 'riskAdmission', 'observationId',
]);

const RA_ADMITTED_KEYS = new Set(['status']);
const RA_BLOCKED_KEYS = new Set(['status', 'reason']);
const RA_NOT_APPLICABLE_KEYS = new Set(['status']);

// ─── Schema helper ───────────────────────────────────────────────────────────

function isStrictPlainObject(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(obj).length > 0) return false;
  return true;
}

// ─── Observation ID ──────────────────────────────────────────────────────────

function computeObservationId(obs: Omit<ShadowIntentObservation, 'observationId'>): string {
  const preimage = 'CLODDSBOT_SHADOW_OBSERVATION\u0000v1\u0000' + canonicalSerialize(obs);
  return 'so-' + crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createShadowIntentObservation(
  event: CanonicalShadowEvent,
  outcome: ShadowDecisionOutcome,
): ShadowIntentObservation {
  // 1. Verify event
  const verifiedEvent = verifyCanonicalShadowEvent(event);
  if (!verifiedEvent) {
    throw new Error('ShadowIntentObservation: event verification failed');
  }

  // 2. Verify outcome brand
  if (!isShadowDecisionOutcome(outcome)) {
    throw new Error('ShadowIntentObservation: outcome is not a valid ShadowDecisionOutcome');
  }

  // 3. Cross-check every duplicated field — use verifiedEvent only, never original event
  const vPayload = verifiedEvent.payload;
  if (outcome.exchange !== verifiedEvent.exchange) {
    throw new Error(
      `ShadowIntentObservation: outcome exchange "${outcome.exchange}" !== event exchange "${verifiedEvent.exchange}"`,
    );
  }
  if (outcome.symbol !== verifiedEvent.symbol) {
    throw new Error(
      `ShadowIntentObservation: outcome symbol "${outcome.symbol}" !== event symbol "${verifiedEvent.symbol}"`,
    );
  }
  if (outcome.decision !== verifiedEvent.eventType) {
    throw new Error(
      `ShadowIntentObservation: outcome decision "${outcome.decision}" !== event eventType "${verifiedEvent.eventType}"`,
    );
  }

  // 4. Cross-check payload content against verifiedEvent payload
  if (outcome.decision !== vPayload.decision) {
    throw new Error('ShadowIntentObservation: decision mismatch with payload');
  }
  if (outcome.direction !== vPayload.direction) {
    throw new Error('ShadowIntentObservation: direction mismatch with payload');
  }
  if (outcome.reason !== vPayload.reason) {
    throw new Error('ShadowIntentObservation: reason mismatch with payload');
  }
  if (outcome.blockedReason !== vPayload.blockedReason) {
    throw new Error('ShadowIntentObservation: blockedReason mismatch with payload');
  }
  if (outcome.intentId !== vPayload.intentId) {
    throw new Error('ShadowIntentObservation: intentId mismatch with payload');
  }

  // 5. Cross-check riskAdmission (structural equality) against verifiedEvent payload
  const raExpected = outcome.riskAdmission;
  const raActual = vPayload.riskAdmission as RiskAdmission;
  if (raExpected.status !== raActual.status) {
    throw new Error('ShadowIntentObservation: riskAdmission.status mismatch');
  }
  if (raExpected.status === 'blocked' && raActual.status === 'blocked') {
    if (raExpected.reason !== raActual.reason) {
      throw new Error('ShadowIntentObservation: riskAdmission.reason mismatch');
    }
  }

  // Deep-clone riskAdmission — no shared nested reference with outcome
  const riskAdmissionClone = cloneCanonicalValue(outcome.riskAdmission) as unknown as RiskAdmission;

  // Build observation (without observationId) — use verifiedEvent fields
  const obsWithoutId: Omit<ShadowIntentObservation, 'observationId'> = {
    schemaVersion: OBS_SCHEMA_VERSION,
    sourceEventId: verifiedEvent.eventId,
    exchange: verifiedEvent.exchange,
    symbol: verifiedEvent.symbol,
    source: verifiedEvent.source,
    sourceSequence: verifiedEvent.sourceSequence,
    eventTimeMs: verifiedEvent.eventTimeMs,
    decision: outcome.decision,
    direction: outcome.direction,
    reason: outcome.reason,
    blockedReason: outcome.blockedReason,
    intentId: outcome.intentId,
    riskAdmission: riskAdmissionClone,
  };

  const observationId = computeObservationId(obsWithoutId);

  const observation: ShadowIntentObservation = {
    ...obsWithoutId,
    observationId,
  };

  // Deep freeze (riskAdmission already frozen from cloneCanonicalValue)
  Object.freeze(observation);

  return observation;
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

/**
 * Verify a ShadowIntentObservation against its source event.
 *
 * sourceEvent is REQUIRED — not optional. The verifier first verifies the
 * sourceEvent, then inspects the observation via own data-property descriptors
 * (never invoking getters), requires exact own schemas with prototype/symbol/enumerable
 * checks, cross-checks every duplicated field, and finally recomputes observationId.
 *
 * Returns a newly assembled, deep-cloned, deeply frozen ShadowIntentObservation
 * snapshot built only from validated descriptor values. Never returns the
 * caller's input object directly.
 */
export function verifyShadowIntentObservation(
  value: unknown,
  sourceEvent: CanonicalShadowEvent,
): ShadowIntentObservation | null {
  if (value === null || typeof value !== 'object') return null;

  // 0. First verify sourceEvent
  const verifiedSource = verifyCanonicalShadowEvent(sourceEvent);
  if (!verifiedSource) return null;

  // Strict plain-object check for observation
  if (!isStrictPlainObject(value as object)) return null;

  // Safely read without invoking getters
  const descs = Object.getOwnPropertyDescriptors(value as object);

  // Exact own key check
  const ownKeys = Object.getOwnPropertyNames(value as object);
  if (ownKeys.length !== OBS_KEYS.size) return null;
  for (const key of ownKeys) {
    if (!OBS_KEYS.has(key)) return null;
    const d = descs[key];
    if (d.get !== undefined || d.set !== undefined) return null;
    if (d.enumerable !== true) return null;
  }

  const getOwn = (key: string): unknown => {
    const d = descs[key];
    if (!d) return undefined;
    if (d.get !== undefined || d.set !== undefined) return undefined;
    return d.value;
  };

  const schemaVersion = getOwn('schemaVersion');
  const sourceEventId = getOwn('sourceEventId');
  const exchange = getOwn('exchange');
  const symbol = getOwn('symbol');
  const source = getOwn('source');
  const sourceSequence = getOwn('sourceSequence');
  const eventTimeMs = getOwn('eventTimeMs');
  const decision = getOwn('decision');
  const direction = getOwn('direction');
  const reason = getOwn('reason');
  const blockedReason = getOwn('blockedReason');
  const intentId = getOwn('intentId');
  const riskAdmission = getOwn('riskAdmission');
  const observationId = getOwn('observationId');

  // Validate schema and fields
  if (schemaVersion !== OBS_SCHEMA_VERSION) return null;
  if (typeof sourceEventId !== 'string' || !/^se-[a-f0-9]{64}$/.test(sourceEventId as string)) return null;
  if (typeof exchange !== 'string' || !exchange) return null;
  if (typeof symbol !== 'string' || !symbol) return null;
  if (typeof source !== 'string' || !source) return null;
  if (!Number.isSafeInteger(sourceSequence) || (sourceSequence as number) < 0) return null;
  if (!Number.isSafeInteger(eventTimeMs) || (eventTimeMs as number) < 0) return null;
  if (decision !== 'trade' && decision !== 'defense' && decision !== 'skip') return null;
  if (direction !== 'long' && direction !== 'short' && direction !== 'hold') return null;
  if (typeof reason !== 'string' || !reason) return null;
  if (blockedReason !== null && typeof blockedReason !== 'string') return null;
  if (intentId !== null && typeof intentId !== 'string') return null;
  if (typeof observationId !== 'string' || !/^so-[a-f0-9]{64}$/.test(observationId as string)) return null;

  // Validate riskAdmission with exact key checks
  if (riskAdmission === null || typeof riskAdmission !== 'object') return null;
  if (!isStrictPlainObject(riskAdmission as object)) return null;

  const raDescs = Object.getOwnPropertyDescriptors(riskAdmission as object);
  const raOwnKeys = Object.getOwnPropertyNames(riskAdmission as object);

  const raGet = (key: string): unknown => {
    const d = raDescs[key];
    if (!d) return undefined;
    if (d.get !== undefined || d.set !== undefined) return undefined;
    return d.value;
  };

  const raStatus = raGet('status');

  if (raStatus === 'admitted') {
    if (raOwnKeys.length !== RA_ADMITTED_KEYS.size) return null;
    for (const k of raOwnKeys) {
      if (!RA_ADMITTED_KEYS.has(k)) return null;
      const d = raDescs[k];
      if (d.get !== undefined || d.set !== undefined) return null;
      if (d.enumerable !== true) return null;
    }
  } else if (raStatus === 'blocked') {
    if (raOwnKeys.length !== RA_BLOCKED_KEYS.size) return null;
    for (const k of raOwnKeys) {
      if (!RA_BLOCKED_KEYS.has(k)) return null;
      const d = raDescs[k];
      if (d.get !== undefined || d.set !== undefined) return null;
      if (d.enumerable !== true) return null;
    }
    const raReason = raGet('reason');
    if (typeof raReason !== 'string' || !raReason) return null;
  } else if (raStatus === 'not_applicable') {
    if (raOwnKeys.length !== RA_NOT_APPLICABLE_KEYS.size) return null;
    for (const k of raOwnKeys) {
      if (!RA_NOT_APPLICABLE_KEYS.has(k)) return null;
      const d = raDescs[k];
      if (d.get !== undefined || d.set !== undefined) return null;
      if (d.enumerable !== true) return null;
    }
  } else {
    return null;
  }

  // Semantic consistency
  if (decision === 'trade') {
    if (direction !== 'long' && direction !== 'short') return null;
    if (intentId === null) return null;
    if (blockedReason !== null) return null;
    if (raStatus !== 'admitted') return null;
  } else if (decision === 'defense') {
    if (direction !== 'hold') return null;
    if (intentId !== null) return null;
    if (typeof blockedReason !== 'string' || !blockedReason) return null;
    if (raStatus !== 'blocked') return null;
  } else {
    if (direction !== 'hold') return null;
    if (intentId !== null) return null;
    if (blockedReason !== null) return null;
    if (raStatus !== 'not_applicable') return null;
  }

  // Cross-check every duplicated field against verifiedSource (the verified snapshot)
  if (sourceEventId !== verifiedSource.eventId) return null;
  if (exchange !== verifiedSource.exchange) return null;
  if (symbol !== verifiedSource.symbol) return null;
  if (source !== verifiedSource.source) return null;
  if (sourceSequence !== verifiedSource.sourceSequence) return null;
  if (eventTimeMs !== verifiedSource.eventTimeMs) return null;
  if (decision !== verifiedSource.eventType) return null;

  // Cross-check decision/direction/reason/blockedReason/intentId/riskAdmission
  // against the source event's payload (safely, without getters)
  const srcPayloadDescs = Object.getOwnPropertyDescriptors(verifiedSource.payload as object);
  const srcPGet = (key: string): unknown => {
    const d = srcPayloadDescs[key];
    if (!d || d.get !== undefined || d.set !== undefined) return undefined;
    return d.value;
  };

  const srcPayloadDecision = srcPGet('decision');
  const srcPayloadDirection = srcPGet('direction');
  const srcPayloadReason = srcPGet('reason');
  const srcPayloadBlockedReason = srcPGet('blockedReason');
  const srcPayloadIntentId = srcPGet('intentId');

  if (decision !== srcPayloadDecision) return null;
  if (direction !== srcPayloadDirection) return null;
  if (reason !== srcPayloadReason) return null;
  if (blockedReason !== srcPayloadBlockedReason) return null;
  if (intentId !== srcPayloadIntentId) return null;

  // Cross-check riskAdmission against source event payload (structural)
  const srcPayloadRA = srcPGet('riskAdmission');
  if (srcPayloadRA === null || typeof srcPayloadRA !== 'object') return null;
  const srcRADescs = Object.getOwnPropertyDescriptors(srcPayloadRA as object);
  const srcRAGet = (key: string): unknown => {
    const d = srcRADescs[key];
    if (!d || d.get !== undefined || d.set !== undefined) return undefined;
    return d.value;
  };
  const srcRAStatus = srcRAGet('status');
  if (raStatus !== srcRAStatus) return null;
  if (raStatus === 'blocked' && srcRAStatus === 'blocked') {
    if (raGet('reason') !== srcRAGet('reason')) return null;
  }

  // Recompute observationId
  const obsWithoutId = {
    schemaVersion: OBS_SCHEMA_VERSION,
    sourceEventId,
    exchange,
    symbol,
    source,
    sourceSequence,
    eventTimeMs,
    decision,
    direction,
    reason,
    blockedReason,
    intentId,
    riskAdmission,
  };

  const computedId = computeObservationId(obsWithoutId as any);
  if (computedId !== observationId) return null;

  // ── Build verified snapshot from descriptor values ──────────────────────
  // Never return the caller's object. Assemble a new deeply frozen snapshot.

  // RiskAdmission snapshot
  const raSnapshot: Record<string, unknown> = {};
  if (raStatus === 'blocked') {
    raSnapshot.status = 'blocked';
    raSnapshot.reason = raGet('reason');
  } else {
    raSnapshot.status = raStatus as string;
  }
  Object.freeze(raSnapshot);

  // Observation snapshot
  const obsSnapshot: Record<string, unknown> = {
    schemaVersion,
    sourceEventId,
    exchange,
    symbol,
    source,
    sourceSequence,
    eventTimeMs,
    decision,
    direction,
    reason,
    blockedReason,
    intentId,
    riskAdmission: raSnapshot,
    observationId,
  };
  Object.freeze(obsSnapshot);

  return obsSnapshot as unknown as ShadowIntentObservation;
}
