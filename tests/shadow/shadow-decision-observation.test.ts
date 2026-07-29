/**
 * TDD adversarial coverage for ShadowDecisionOutcome + ShadowIntentObservation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShadowDecisionOutcome, isShadowDecisionOutcome } from '../../src/shadow/ShadowDecisionOutcome';
import { createCanonicalShadowEvent, verifyCanonicalShadowEvent } from '../../src/shadow/CanonicalShadowEvent';
import { createShadowIntentObservation, verifyShadowIntentObservation } from '../../src/shadow/ShadowIntentObservation';
import { REF_EXCHANGE, REF_SYMBOL, REF_SOURCE, REF_REASON, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, makeRefTradeIntent } from '../helpers/shadow-reference-fixtures';

// =============================================================================
// SHADOW DECISION OUTCOME TESTS
// =============================================================================

// ─── Trade outcome ───────────────────────────────────────────────────────────

test('DO: trade outcome created and branded', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );

  assert.ok(isShadowDecisionOutcome(outcome));
  assert.equal(outcome.schemaVersion, 'cloddsbot.shadow.outcome.v1');
  assert.equal(outcome.exchange, REF_EXCHANGE);
  assert.equal(outcome.symbol, REF_SYMBOL);
  assert.equal(outcome.decision, 'trade');
  assert.equal(outcome.direction, 'long');
  assert.equal(outcome.reason, REF_REASON);
  assert.equal(outcome.blockedReason, null);
  assert.equal(outcome.intentId, intent.intentId);
  assert.deepEqual(outcome.riskAdmission, { status: 'admitted' });
});

test('DO: trade outcome is deeply frozen', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.riskAdmission));
});

test('DO: trade requires direction long or short', () => {
  const intent = makeRefTradeIntent();
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'hold', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: trade requires TradeIntent', () => {
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: trade requires positive finite positionUsd', () => {
  const intent = makeRefTradeIntent();
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 0, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: -100, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: NaN, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: trade requires intent exchange matches signalExchange', () => {
  const intent = makeRefTradeIntent({ exchange: 'binance' as any });
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: trade requires intent symbol matches signalSymbol', () => {
  const intent = makeRefTradeIntent({ symbol: 'ETHUSDT' });
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: trade requires intent direction matches result direction', () => {
  const intent = makeRefTradeIntent({ direction: 'short' });
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: trade requires intent positionUsd matches result positionUsd', () => {
  const intent = makeRefTradeIntent({ positionUsd: 9999 });
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: result exchange must equal signalExchange', () => {
  const intent = makeRefTradeIntent();
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: 'binance' as any, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

// ─── Defense outcome ─────────────────────────────────────────────────────────

test('DO: defense normalizes direction to hold', () => {
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'defense', direction: 'short', reason: 'Risk limit exceeded' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  assert.equal(outcome.decision, 'defense');
  assert.equal(outcome.direction, 'hold');
  assert.equal(outcome.blockedReason, 'Risk limit exceeded');
  assert.deepEqual(outcome.riskAdmission, { status: 'blocked', reason: 'Risk limit exceeded' });
  assert.equal(outcome.intentId, null);
});

test('DO: defense forbids TradeIntent', () => {
  const intent = makeRefTradeIntent();
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'defense', tradeIntent: intent, reason: 'x' } as any,
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: defense without symbol in result uses signalSymbol', () => {
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'defense', reason: 'Kill switch' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  assert.equal(outcome.symbol, REF_SYMBOL);
});

// ─── Skip outcome ────────────────────────────────────────────────────────────

test('DO: skip normalizes direction to hold', () => {
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'skip', reason: 'No signal' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  assert.equal(outcome.decision, 'skip');
  assert.equal(outcome.direction, 'hold');
  assert.equal(outcome.blockedReason, null);
  assert.deepEqual(outcome.riskAdmission, { status: 'not_applicable' });
  assert.equal(outcome.intentId, null);
});

test('DO: skip forbids TradeIntent', () => {
  const intent = makeRefTradeIntent();
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'skip', tradeIntent: intent, reason: 'x' } as any,
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

test('DO: skip without symbol uses signalSymbol', () => {
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'skip', reason: 'Cooldown' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  assert.equal(outcome.symbol, REF_SYMBOL);
});

// ─── Result symbol validation ────────────────────────────────────────────────

test('DO: result symbol must equal signalSymbol if present', () => {
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'skip', symbol: 'ETHUSDT', reason: 'x' },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

// ─── Factory does not mutate/freeze inputs ───────────────────────────────────

test('DO: factory does not freeze result input', () => {
  const result = { exchange: REF_EXCHANGE, decision: 'trade' as const, direction: 'long' as const, symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: makeRefTradeIntent(), reason: REF_REASON };
  const frozenBefore = Object.isFrozen(result);
  createShadowDecisionOutcome(result, REF_EXCHANGE, REF_SYMBOL);
  assert.equal(Object.isFrozen(result), frozenBefore);
});

test('DO: factory does not freeze signal inputs', () => {
  const sigEx = REF_EXCHANGE;
  const sigSym = REF_SYMBOL;
  createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'skip', reason: 'x' },
    sigEx, sigSym,
  );
  // Strings are immutable, just checking we don't wrap them
  assert.equal(sigEx, REF_EXCHANGE);
  assert.equal(sigSym, REF_SYMBOL);
});

test('DO: factory does not freeze TradeIntent', () => {
  const intent = makeRefTradeIntent();
  const frozenBefore = Object.isFrozen(intent);
  createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  assert.equal(Object.isFrozen(intent), frozenBefore);
});

// ─── isShadowDecisionOutcome type guard ──────────────────────────────────────

test('DO: type guard rejects plain objects', () => {
  assert.equal(isShadowDecisionOutcome({}), false);
  assert.equal(isShadowDecisionOutcome(null), false);
  assert.equal(isShadowDecisionOutcome(undefined), false);
  assert.equal(isShadowDecisionOutcome('trade'), false);
});

test('DO: type guard rejects unbranded objects with same shape', () => {
  const fake = {
    schemaVersion: 'cloddsbot.shadow.outcome.v1',
    exchange: REF_EXCHANGE,
    symbol: REF_SYMBOL,
    decision: 'trade',
    direction: 'long',
    reason: REF_REASON,
    blockedReason: null,
    intentId: 'ti-x',
    riskAdmission: { status: 'admitted' },
  };
  assert.equal(isShadowDecisionOutcome(fake), false);
});

test('DO: empty reason rejected', () => {
  assert.throws(() => createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'skip', reason: '' },
    REF_EXCHANGE, REF_SYMBOL,
  ));
});

// =============================================================================
// SHADOW INTENT OBSERVATION TESTS
// =============================================================================

function makeTradeEventAndOutcome() {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  return { event, outcome };
}

test('OI: creates observation from event and outcome', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);

  assert.equal(obs.schemaVersion, 'cloddsbot.shadow.observation.v1');
  assert.equal(obs.sourceEventId, event.eventId);
  assert.equal(obs.exchange, REF_EXCHANGE);
  assert.equal(obs.symbol, REF_SYMBOL);
  assert.equal(obs.source, REF_SOURCE);
  assert.equal(obs.sourceSequence, REF_SOURCE_SEQUENCE);
  assert.equal(obs.eventTimeMs, REF_EVENT_TIME_MS);
  assert.equal(obs.decision, 'trade');
  assert.equal(obs.direction, 'long');
  assert.equal(obs.reason, REF_REASON);
  assert.equal(obs.blockedReason, null);
  assert.equal(obs.intentId, outcome.intentId);
  assert.deepEqual(obs.riskAdmission, outcome.riskAdmission);
  assert.match(obs.observationId, /^so-[a-f0-9]{64}$/);
});

test('OI: observation is deeply frozen', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  assert.ok(Object.isFrozen(obs));
  assert.ok(Object.isFrozen(obs.riskAdmission));
});

test('OI: deterministic observationId for same inputs', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const { event: event2, outcome: outcome2 } = (() => {
    const intent = makeRefTradeIntent();
    const o = createShadowDecisionOutcome(
      { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
      REF_EXCHANGE, REF_SYMBOL,
    );
    const e = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, o);
    return { event: e, outcome: o };
  })();
  const o1 = createShadowIntentObservation(event, outcome);
  const o2 = createShadowIntentObservation(event2, outcome2);
  assert.equal(o1.observationId, o2.observationId);
});

test('OI: different event → different observationId', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const intent2 = makeRefTradeIntent({ positionUsd: 2000 });
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 2000, tradeIntent: intent2, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS + 1, REF_SOURCE_SEQUENCE, outcome2);
  const o1 = createShadowIntentObservation(event, outcome);
  const o2 = createShadowIntentObservation(event2, outcome2);
  assert.notEqual(o1.observationId, o2.observationId);
});

test('OI: cross-event/outcome mismatch rejected (wrong event for outcome)', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const intent2 = makeRefTradeIntent({ positionUsd: 2000 });
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 2000, tradeIntent: intent2, reason: 'Different reason' },
    REF_EXCHANGE, REF_SYMBOL,
  );
  // event is for outcome1, but we pass outcome2
  assert.throws(() => createShadowIntentObservation(event, outcome2));
});

test('OI: verifier accepts valid observation', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const result = verifyShadowIntentObservation(obs, event);
  assert.ok(result);
  assert.equal(result.observationId, obs.observationId);
});

test('OI: verifier rejects tampered reason', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const tampered = { ...obs, reason: 'HACKED' };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

test('OI: verifier rejects tampered blockedReason', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const tampered = { ...obs, blockedReason: 'HACKED' };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

test('OI: verifier rejects tampered source', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const tampered = { ...obs, source: 'HACKED' };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

test('OI: verifier rejects tampered eventTimeMs', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const tampered = { ...obs, eventTimeMs: 999 };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

test('OI: verifier rejects tampered sourceSequence', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const tampered = { ...obs, sourceSequence: 999 };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

test('OI: verifier rejects tampered riskAdmission', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const tampered = { ...obs, riskAdmission: { status: 'not_applicable' } };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

test('OI: verifier rejects tampered observationId', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const tampered = { ...obs, observationId: 'so-' + '0'.repeat(64) };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

test('OI: verifier rejects null/undefined/non-object', () => {
  assert.equal(verifyShadowIntentObservation(null, {} as any), null);
  assert.equal(verifyShadowIntentObservation(undefined, {} as any), null);
  assert.equal(verifyShadowIntentObservation('nope', {} as any), null);
});

test('OI: verifier accessor never invoked', () => {
  const { event } = makeTradeEventAndOutcome();
  const malicious = {
    schemaVersion: 'cloddsbot.shadow.observation.v1',
    get sourceEventId() { throw new Error('ACCESSOR'); },
    exchange: REF_EXCHANGE,
    symbol: REF_SYMBOL,
    source: REF_SOURCE,
    sourceSequence: REF_SOURCE_SEQUENCE,
    eventTimeMs: REF_EVENT_TIME_MS,
    decision: 'trade',
    direction: 'long',
    reason: REF_REASON,
    blockedReason: null,
    intentId: 'ti-x',
    riskAdmission: { status: 'admitted' },
    observationId: 'so-' + 'a'.repeat(64),
  };
  // Should inspect without invoking getters — so no throw
  assert.equal(verifyShadowIntentObservation(malicious, event), null);
});

// ─── isShadowDecisionOutcome brand bypass tests ──────────────────────────────

test('DO: type guard rejects Object.freeze(Object.create(genuineOutcome))', () => {
  const intent = makeRefTradeIntent();
  const genuine = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  // Create an object with genuine as prototype — should be rejected
  const protoChild = Object.freeze(Object.create(genuine));
  assert.equal(isShadowDecisionOutcome(protoChild), false);
});

// ─── Self-consistent forged observations (recomputed observationId) ──────────

import * as crypto from 'crypto';
import { canonicalSerialize } from '../../src/shadow/CanonicalJson';

/** Build a self-consistent forged observation with recomputed observationId. */
function forgeObservation(overrides: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 'cloddsbot.shadow.observation.v1',
    sourceEventId: 'se-' + 'f'.repeat(64),
    exchange: REF_EXCHANGE,
    symbol: REF_SYMBOL,
    source: REF_SOURCE,
    sourceSequence: REF_SOURCE_SEQUENCE,
    eventTimeMs: REF_EVENT_TIME_MS,
    decision: 'trade',
    direction: 'long',
    reason: REF_REASON,
    blockedReason: null,
    intentId: 'ti-ref',
    riskAdmission: { status: 'admitted' },
    ...overrides,
  };

  const obsId = 'so-' + crypto.createHash('sha256')
    .update('CLODDSBOT_SHADOW_OBSERVATION\x00v1\x00' + canonicalSerialize(base), 'utf8')
    .digest('hex');

  return { ...base, observationId: obsId };
}

test('OI: verifier rejects forged observation where reason differs from source event', () => {
  const { event } = makeTradeEventAndOutcome();
  const forged = forgeObservation({
    sourceEventId: event.eventId,
    exchange: event.exchange,
    symbol: event.symbol,
    source: event.source,
    sourceSequence: event.sourceSequence,
    eventTimeMs: event.eventTimeMs,
    reason: 'Different reason',
  });
  assert.equal(verifyShadowIntentObservation(forged, event), null);
});

test('OI: verifier rejects forged observation where sourceSequence differs from source event', () => {
  const { event } = makeTradeEventAndOutcome();
  const forged = forgeObservation({
    sourceEventId: event.eventId,
    exchange: event.exchange,
    symbol: event.symbol,
    source: event.source,
    sourceSequence: 999,
    eventTimeMs: event.eventTimeMs,
  });
  assert.equal(verifyShadowIntentObservation(forged, event), null);
});

test('OI: verifier rejects forged observation where riskAdmission differs from source event', () => {
  const { event } = makeTradeEventAndOutcome();
  const forged = forgeObservation({
    sourceEventId: event.eventId,
    exchange: event.exchange,
    symbol: event.symbol,
    source: event.source,
    sourceSequence: event.sourceSequence,
    eventTimeMs: event.eventTimeMs,
    riskAdmission: { status: 'blocked', reason: 'HACKED' },
  });
  assert.equal(verifyShadowIntentObservation(forged, event), null);
});

test('OI: nested riskAdmission getter never invoked', () => {
  const { event } = makeTradeEventAndOutcome();
  const malicious = {
    schemaVersion: 'cloddsbot.shadow.observation.v1',
    sourceEventId: event.eventId,
    exchange: event.exchange,
    symbol: event.symbol,
    source: event.source,
    sourceSequence: event.sourceSequence,
    eventTimeMs: event.eventTimeMs,
    decision: 'trade',
    direction: 'long',
    reason: REF_REASON,
    blockedReason: null,
    intentId: 'ti-ref',
    get riskAdmission() { throw new Error('NESTED GETTER INVOKED'); },
    observationId: 'so-' + 'a'.repeat(64),
  };
  // Should inspect without invoking getters — so no throw
  assert.equal(verifyShadowIntentObservation(malicious, event), null);
});

// =============================================================================
// EXACT OBJECT SCHEMA TESTS (STAGE 4B4.1) — Observation verifier
// =============================================================================

// ─── Extra symbol key rejection ──────────────────────────────────────────────

test('OI: verifier rejects extra symbol key at observation top level', () => {
  const { event } = makeTradeEventAndOutcome();
  const forged = forgeObservation({});
  Object.defineProperty(forged, Symbol('extra'), { value: 1, enumerable: true });
  assert.equal(verifyShadowIntentObservation(forged, event), null);
});

test('OI: verifier rejects extra symbol key at observation riskAdmission level', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);

  // Shallow-copy riskAdmission, attach symbol key (no forgeObservation — must not serialize)
  const tamperedRA = { status: 'admitted' as const };
  Object.defineProperty(tamperedRA, Symbol('extra'), { value: 1, enumerable: true });

  // Shallow-copy observation, replace riskAdmission, retain existing observationId
  const tampered = { ...obs, riskAdmission: tamperedRA };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

// ─── Non-enumerable required field rejection ─────────────────────────────────

test('OI: verifier rejects non-enumerable required field at observation top level', () => {
  const { event } = makeTradeEventAndOutcome();
  const forged = forgeObservation({});
  Object.defineProperty(forged, 'exchange', { value: forged.exchange, enumerable: false });
  assert.equal(verifyShadowIntentObservation(forged, event), null);
});

test('OI: verifier rejects non-enumerable required field at observation riskAdmission level', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);

  // Shallow-copy riskAdmission, make status non-enumerable (no forgeObservation — must not serialize)
  const tamperedRA = { status: 'admitted' as const };
  Object.defineProperty(tamperedRA, 'status', { value: 'admitted', enumerable: false });

  // Shallow-copy observation, replace riskAdmission, retain existing observationId
  const tampered = { ...obs, riskAdmission: tamperedRA };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
});

// ─── Getter counters remain zero ─────────────────────────────────────────────

test('OI: accessor getter on riskAdmission — counter remains zero', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  let getterCalls = 0;
  const obs = createShadowIntentObservation(event, outcome);

  // Build tampered riskAdmission with getter on 'status'
  const tamperedRA: Record<string, unknown> = {};
  Object.defineProperties(tamperedRA, {
    status: {
      get() { getterCalls++; return 'admitted'; },
      enumerable: true,
      configurable: true,
    },
  });
  const tampered = { ...obs, riskAdmission: tamperedRA };
  assert.equal(verifyShadowIntentObservation(tampered, event), null);
  assert.equal(getterCalls, 0);
});

// ─── Verified snapshot: non-identical frozen copy ────────────────────────────

test('OI: verify returns non-identical frozen snapshot', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const result = verifyShadowIntentObservation(obs, event);
  assert.ok(result);
  assert.notStrictEqual(result, obs); // non-identical
  assert.deepEqual(result, obs);       // but equal
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.riskAdmission));
});

test('OI: mutating original after verification cannot change verified snapshot', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  const result = verifyShadowIntentObservation(obs, event);
  assert.ok(result);
  const reasonBefore = result.reason;

  // Mutate a mutable copy of the original
  const mutableObs = { ...obs };
  (mutableObs as any).reason = 'HACKED';

  assert.equal(result.reason, reasonBefore);
  assert.notEqual(result.reason, 'HACKED');
});

test('OI: original artifact remains unfrozen after verification', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);
  // Make a mutable copy (spread, not frozen)
  const mutableCopy = { ...obs, riskAdmission: { ...obs.riskAdmission } };
  assert.ok(!Object.isFrozen(mutableCopy));
  const result = verifyShadowIntentObservation(mutableCopy, event);
  assert.ok(result);
  assert.ok(!Object.isFrozen(mutableCopy));
});

// ─── Proxy safety ────────────────────────────────────────────────────────────

test('OI: verifier survives Proxy with throwing get trap, returns snapshot', () => {
  const { event, outcome } = makeTradeEventAndOutcome();
  const obs = createShadowIntentObservation(event, outcome);

  const proxyObs = new Proxy(obs, {
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    get(_target, _prop, _receiver) {
      throw new Error('PROXY GET TRAP INVOKED');
    },
  });

  const result = verifyShadowIntentObservation(proxyObs, event);
  assert.ok(result);
  assert.equal(result.observationId, obs.observationId);
  assert.notStrictEqual(result, obs);
  assert.notStrictEqual(result, proxyObs as any);
  assert.equal(result.source, REF_SOURCE);
});
