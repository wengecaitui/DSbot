/**
 * CanonicalShadowEvent — deterministic identity-bound shadow event.
 *
 * Stored fields are identity-bound except eventId itself.
 * Payload is an exact canonical snapshot of validated outcome semantic fields,
 * deep-cloned via cloneCanonicalValue (not a shallow spread/reference).
 */
import * as crypto from 'crypto';
import { canonicalSerialize, cloneCanonicalValue } from './CanonicalJson';
import type { ShadowDecisionOutcome } from './ShadowDecisionOutcome';
import { isShadowDecisionOutcome } from './ShadowDecisionOutcome';
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';

// ─── Types ───────────────────────────────────────────────────────────────────

export const EVENT_SCHEMA_VERSION = 'cloddsbot.shadow.event.v1' as const;

export type ShadowEventType = 'trade' | 'defense' | 'skip';

export interface CanonicalShadowEventPayload {
  readonly decision: ShadowEventType;
  readonly direction: 'long' | 'short' | 'hold';
  readonly reason: string;
  readonly blockedReason: string | null;
  readonly intentId: string | null;
  readonly riskAdmission: unknown;
}

export interface CanonicalShadowEvent {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly source: string;
  readonly eventType: ShadowEventType;
  readonly eventTimeMs: number;
  readonly sourceSequence: number;
  readonly payloadDigest: string;
  readonly eventId: string;
  readonly payload: CanonicalShadowEventPayload;
}

// ─── Exact key sets for verifier schema enforcement ──────────────────────────

const EVENT_TOP_KEYS = new Set([
  'schemaVersion', 'exchange', 'symbol', 'source',
  'eventType', 'eventTimeMs', 'sourceSequence',
  'payloadDigest', 'eventId', 'payload',
]);

const PAYLOAD_KEYS = new Set([
  'decision', 'direction', 'reason', 'blockedReason', 'intentId', 'riskAdmission',
]);

const RA_ADMITTED_KEYS = new Set(['status']);
const RA_BLOCKED_KEYS = new Set(['status', 'reason']);
const RA_NOT_APPLICABLE_KEYS = new Set(['status']);

// ─── Schema helper — validate object shape without invoking getters ───────────

/**
 * Check that an object passes the strict plain-object schema checks:
 * - prototype is Object.prototype or null
 * - no own symbol keys
 */
function isStrictPlainObject(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(obj).length > 0) return false;
  return true;
}

// ─── Payload hash ────────────────────────────────────────────────────────────

function computePayloadDigest(payload: CanonicalShadowEventPayload): string {
  const preimage = 'CLODDSBOT_SHADOW_PAYLOAD\u0000v1\u0000' + canonicalSerialize(payload);
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ─── Event ID ────────────────────────────────────────────────────────────────

function computeEventId(event: Omit<CanonicalShadowEvent, 'eventId' | 'payload'>): string {
  const { eventId: _, payload: __, ...storedFields } = event as any;
  const preimage = 'CLODDSBOT_SHADOW_EVENT\u0000v1\u0000' + canonicalSerialize(storedFields);
  return 'se-' + crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createCanonicalShadowEvent(
  source: string,
  eventTimeMs: number,
  sourceSequence: number,
  outcome: ShadowDecisionOutcome,
): CanonicalShadowEvent {
  if (!source || typeof source !== 'string') {
    throw new Error('CanonicalShadowEvent: source must be non-empty string');
  }
  if (!Number.isSafeInteger(eventTimeMs) || eventTimeMs < 0) {
    throw new Error(`CanonicalShadowEvent: eventTimeMs must be safe non-negative integer, got ${eventTimeMs}`);
  }
  if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 0) {
    throw new Error(`CanonicalShadowEvent: sourceSequence must be safe non-negative integer, got ${sourceSequence}`);
  }

  // Validate outcome brand BEFORE reading any fields
  if (!isShadowDecisionOutcome(outcome)) {
    throw new Error('CanonicalShadowEvent: outcome is not a valid ShadowDecisionOutcome');
  }

  // Validate exchange
  if (!isExchangeId(outcome.exchange)) {
    throw new Error(
      `CanonicalShadowEvent: invalid outcome exchange: ${JSON.stringify(outcome.exchange)}`,
    );
  }

  // Extract payload from outcome — deep-clone via cloneCanonicalValue
  const payloadUnvalidated = {
    decision: outcome.decision,
    direction: outcome.direction,
    reason: outcome.reason,
    blockedReason: outcome.blockedReason,
    intentId: outcome.intentId,
    riskAdmission: outcome.riskAdmission,
  };

  // Deep-clone and deep-freeze the payload (not shallow spread/reference)
  const payload = cloneCanonicalValue(payloadUnvalidated) as unknown as CanonicalShadowEventPayload;

  // Compute payloadDigest from the deep-cloned payload
  const payloadDigest = computePayloadDigest(payload);

  // Build event without eventId first
  const eventWithoutId = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    exchange: outcome.exchange,
    symbol: outcome.symbol,
    source,
    eventType: outcome.decision as ShadowEventType,
    eventTimeMs,
    sourceSequence,
    payloadDigest,
  };

  const eventId = computeEventId({
    ...eventWithoutId,
    payload,
  } as any);

  const event: CanonicalShadowEvent = {
    ...eventWithoutId,
    eventId,
    payload,
  };

  // Deep freeze
  Object.freeze(event);

  return event;
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

/**
 * Verify a CanonicalShadowEvent.
 *
 * Returns a newly assembled, deep-cloned, deeply frozen CanonicalShadowEvent
 * snapshot built only from validated descriptor values. The caller's input
 * is never frozen, mutated, or returned directly.
 */
export function verifyCanonicalShadowEvent(value: unknown): CanonicalShadowEvent | null {
  // Safety: inspect without invoking getters
  if (value === null || typeof value !== 'object') return null;

  // Strict plain-object check: prototype + no symbol keys
  if (!isStrictPlainObject(value as object)) return null;

  // Clone via descriptors to avoid getter invocation
  const descs = Object.getOwnPropertyDescriptors(value as object);

  // Exact top-level key check
  const ownKeys = Object.getOwnPropertyNames(value as object);
  if (ownKeys.length !== EVENT_TOP_KEYS.size) return null;
  for (const key of ownKeys) {
    if (!EVENT_TOP_KEYS.has(key)) return null;
    // No accessor keys allowed; must be own enumerable data property
    const d = descs[key];
    if (d.get !== undefined || d.set !== undefined) return null;
    if (d.enumerable !== true) return null;
  }

  const getOwn = (key: string): unknown => {
    const d = descs[key];
    if (!d) return undefined;
    if (d.get !== undefined || d.set !== undefined) return undefined; // accessor → fail
    return d.value;
  };

  const schemaVersion = getOwn('schemaVersion');
  const exchange = getOwn('exchange');
  const symbol = getOwn('symbol');
  const source = getOwn('source');
  const eventType = getOwn('eventType');
  const eventTimeMs = getOwn('eventTimeMs');
  const sourceSequence = getOwn('sourceSequence');
  const payloadDigest = getOwn('payloadDigest');
  const eventId = getOwn('eventId');
  const payload = getOwn('payload');

  // Schema check
  if (schemaVersion !== EVENT_SCHEMA_VERSION) return null;
  if (!isExchangeId(exchange)) return null;
  if (typeof symbol !== 'string' || !symbol) return null;
  if (typeof source !== 'string' || !source) return null;
  if (eventType !== 'trade' && eventType !== 'defense' && eventType !== 'skip') return null;
  if (!Number.isSafeInteger(eventTimeMs) || (eventTimeMs as number) < 0) return null;
  if (!Number.isSafeInteger(sourceSequence) || (sourceSequence as number) < 0) return null;
  // payloadDigest must be lowercase hex SHA-256 (64 hex chars)
  if (typeof payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(payloadDigest as string)) return null;
  // eventId must be se- prefix + 64 lowercase hex chars
  if (typeof eventId !== 'string' || !/^se-[a-f0-9]{64}$/.test(eventId as string)) return null;
  if (payload === null || typeof payload !== 'object') return null;

  // Strict plain-object check for payload
  if (!isStrictPlainObject(payload as object)) return null;

  // Verify payload content safely (avoiding getters)
  const payloadDescs = Object.getOwnPropertyDescriptors(payload as object);

  // Exact payload key check
  const payloadOwnKeys = Object.getOwnPropertyNames(payload as object);
  if (payloadOwnKeys.length !== PAYLOAD_KEYS.size) return null;
  for (const key of payloadOwnKeys) {
    if (!PAYLOAD_KEYS.has(key)) return null;
    const d = payloadDescs[key];
    if (d.get !== undefined || d.set !== undefined) return null;
    if (d.enumerable !== true) return null;
  }

  const pGet = (key: string): unknown => {
    const d = payloadDescs[key];
    if (!d) return undefined;
    if (d.get !== undefined || d.set !== undefined) return undefined;
    return d.value;
  };

  const pDecision = pGet('decision');
  const pDirection = pGet('direction');
  const pReason = pGet('reason');
  const pBlockedReason = pGet('blockedReason');
  const pIntentId = pGet('intentId');
  const pRiskAdmission = pGet('riskAdmission');

  if (pDecision !== 'trade' && pDecision !== 'defense' && pDecision !== 'skip') return null;
  if (pDirection !== 'long' && pDirection !== 'short' && pDirection !== 'hold') return null;
  if (typeof pReason !== 'string' || !pReason) return null;
  if (pBlockedReason !== null && typeof pBlockedReason !== 'string') return null;
  if (pIntentId !== null && typeof pIntentId !== 'string') return null;

  // Validate riskAdmission safely with exact key checks
  if (pRiskAdmission === null || typeof pRiskAdmission !== 'object') return null;
  if (!isStrictPlainObject(pRiskAdmission as object)) return null;

  const raDescs = Object.getOwnPropertyDescriptors(pRiskAdmission as object);
  const raOwnKeys = Object.getOwnPropertyNames(pRiskAdmission as object);

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

  // eventType must equal payload.decision
  if (eventType !== pDecision) return null;

  // Semantic consistency
  if (pDecision === 'trade') {
    if (pDirection !== 'long' && pDirection !== 'short') return null;
    if (pIntentId === null) return null;
    if (pBlockedReason !== null) return null;
    if (raStatus !== 'admitted') return null;
  } else if (pDecision === 'defense') {
    if (pDirection !== 'hold') return null;
    if (pIntentId !== null) return null;
    if (typeof pBlockedReason !== 'string' || !pBlockedReason) return null;
    if (raStatus !== 'blocked') return null;
    // defense: risk reason must equal reason and blockedReason
    const raReason = raGet('reason');
    if (raReason !== pReason || raReason !== pBlockedReason) return null;
  } else {
    // skip
    if (pDirection !== 'hold') return null;
    if (pIntentId !== null) return null;
    if (pBlockedReason !== null) return null;
    if (raStatus !== 'not_applicable') return null;
  }

  // Recompute payloadDigest from the exact payload fields
  const computedPayloadDigest = computePayloadDigest({
    decision: pDecision as ShadowEventType,
    direction: pDirection as 'long' | 'short' | 'hold',
    reason: pReason as string,
    blockedReason: pBlockedReason as string | null,
    intentId: pIntentId as string | null,
    riskAdmission: pRiskAdmission,
  });

  if (computedPayloadDigest !== payloadDigest) return null;

  // Recompute eventId
  const computedEventId = computeEventId({
    schemaVersion: EVENT_SCHEMA_VERSION,
    exchange: exchange as string,
    symbol: symbol as string,
    source: source as string,
    eventType: eventType as ShadowEventType,
    eventTimeMs: eventTimeMs as number,
    sourceSequence: sourceSequence as number,
    payloadDigest: payloadDigest as string,
    payload: payload as CanonicalShadowEventPayload,
  } as any);

  if (computedEventId !== eventId) return null;

  // ── Build verified snapshot from descriptor values ──────────────────────
  // Never return the caller's object. Assemble a new deeply frozen snapshot
  // from the validated descriptor values only.

  // RiskAdmission snapshot
  const raSnapshot: Record<string, unknown> = {};
  if (raStatus === 'blocked') {
    raSnapshot.status = 'blocked';
    raSnapshot.reason = raGet('reason');
  } else {
    raSnapshot.status = raStatus as string;
  }
  Object.freeze(raSnapshot);

  // Payload snapshot
  const payloadSnapshot: Record<string, unknown> = {
    decision: pDecision,
    direction: pDirection,
    reason: pReason,
    blockedReason: pBlockedReason,
    intentId: pIntentId,
    riskAdmission: raSnapshot,
  };
  Object.freeze(payloadSnapshot);

  // Top-level event snapshot
  const eventSnapshot: Record<string, unknown> = {
    schemaVersion,
    exchange,
    symbol,
    source,
    eventType,
    eventTimeMs,
    sourceSequence,
    payloadDigest,
    eventId,
    payload: payloadSnapshot,
  };
  Object.freeze(eventSnapshot);

  return eventSnapshot as unknown as CanonicalShadowEvent;
}
