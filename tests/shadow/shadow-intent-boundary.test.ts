/**
 * TDD adversarial coverage for ShadowIntentBoundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShadowIntentBoundary } from '../../src/shadow/ShadowIntentBoundary';
import { ShadowRuntimeStateMachine } from '../../src/shadow/ShadowRuntimeStateMachine';
import { createShadowDecisionOutcome } from '../../src/shadow/ShadowDecisionOutcome';
import { createCanonicalShadowEvent } from '../../src/shadow/CanonicalShadowEvent';
import type { CanonicalShadowEvent, ShadowDecisionOutcome } from '../../src/shadow';
import { REF_EXCHANGE, REF_SYMBOL, REF_SOURCE, REF_REASON, REF_EVENT_TIME_MS, makeRefTradeIntent } from '../helpers/shadow-reference-fixtures';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function activateSM(): ShadowRuntimeStateMachine {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('ACTIVATE');
  return sm;
}

function makeTradeEventAndOutcome(
  source = REF_SOURCE,
  eventTimeMs = REF_EVENT_TIME_MS,
  sourceSequence = 0,
  exchange: string = REF_EXCHANGE,
  symbol: string = REF_SYMBOL,
  positionUsd = 1500,
): { event: CanonicalShadowEvent; outcome: ShadowDecisionOutcome } {
  const intent = makeRefTradeIntent({ exchange: exchange as any, symbol, positionUsd });
  const outcome = createShadowDecisionOutcome(
    { exchange: exchange as any, decision: 'trade', direction: 'long', symbol, positionUsd, tradeIntent: intent, reason: REF_REASON },
    exchange as any, symbol,
  );
  const event = createCanonicalShadowEvent(source, eventTimeMs, sourceSequence, outcome);
  return { event, outcome };
}

// ─── Constructor rejects non-instance ────────────────────────────────────────

test('IB: constructor rejects non-ShadowRuntimeStateMachine instance', () => {
  // Fake structurally-compatible object
  const fakeSM = {
    state: 'SHADOW_ACTIVE',
  };
  assert.throws(() => createShadowIntentBoundary(fakeSM as any));
});

test('IB: constructor accepts real ShadowRuntimeStateMachine', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  assert.ok(boundary);
});

// ─── Observation allowed only in SHADOW_ACTIVE ──────────────────────────────

test('IB: observe accepted in SHADOW_ACTIVE', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'accepted');
  assert.ok(result.observation);
  assert.equal(boundary.size, 1);
});

test('IB: observe rejected in STOPPED', () => {
  const sm = new ShadowRuntimeStateMachine();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_STATE');
    assert.ok(result.reason.includes('SHADOW_ACTIVE'));
  }
});

test('IB: observe rejected in PRECHECKED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_STATE');
  }
});

test('IB: observe rejected in SHADOW_READY', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_STATE');
  }
});

test('IB: observe rejected in PAUSED', () => {
  const sm = activateSM();
  sm.transition('PAUSE');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_STATE');
  }
});

test('IB: observe rejected in RECOVERY_REQUIRED', () => {
  const sm = activateSM();
  sm.transition('RECOVERY_REQUIRED');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_STATE');
  }
});

test('IB: observe rejected in FAILED', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('FAIL');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_STATE');
  }
});

// ─── First zero sequence ─────────────────────────────────────────────────────

test('IB: first observation with sequence 0 accepted', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, REF_EVENT_TIME_MS, 0);
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'accepted');
  assert.equal(boundary.size, 1);
});

test('IB: first sequence greater than zero causes gap → RECOVERY_REQUIRED', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, REF_EVENT_TIME_MS, 5); // first is 5, not 0
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'gap');
  assert.equal(sm.state, 'RECOVERY_REQUIRED');
  assert.equal(boundary.size, 0); // stores unchanged
});

// ─── Exact next sequence ─────────────────────────────────────────────────────

test('IB: exact next sequence (0, 1, 2) accepted', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);

  const r1 = boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 1000, 0)));
  assert.equal(r1.status, 'accepted');
  assert.equal(boundary.size, 1);

  const r2 = boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 2000, 1)));
  assert.equal(r2.status, 'accepted');
  assert.equal(boundary.size, 2);

  const r3 = boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 3000, 2)));
  assert.equal(r3.status, 'accepted');
  assert.equal(boundary.size, 3);
});

// ─── Exact duplicate ────────────────────────────────────────────────────────

test('IB: exact duplicate eventId returns original observation, no side effects', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const r1 = boundary.observe(event, outcome);
  assert.equal(r1.status, 'accepted');
  const obs1 = r1.observation!;
  assert.equal(boundary.size, 1);

  // Same event again
  const r2 = boundary.observe(event, outcome);
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.observation, obs1); // exact same reference
  assert.equal(boundary.size, 1); // unchanged

  // State unchanged
  assert.equal(sm.state, 'SHADOW_ACTIVE');
});

// ─── Same eventId but different outcome → rejected, not duplicate ────────────

test('IB: existing event + different genuine outcome with same exchange/symbol/decision but different reason → rejected, not duplicate', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);

  // Accept first trade event
  const { event: e1, outcome: o1 } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  const r1 = boundary.observe(e1, o1);
  assert.equal(r1.status, 'accepted');
  assert.equal(boundary.size, 1);

  // Create different outcome with same exchange/symbol/decision but different reason
  const intent2 = makeRefTradeIntent({ positionUsd: 2000 });
  const o2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 2000, tradeIntent: intent2, reason: 'Different reason' },
    REF_EXCHANGE, REF_SYMBOL,
  );

  // Same eventId but different outcome — should be rejected, not duplicate
  const r2 = boundary.observe(e1, o2);
  assert.equal(r2.status, 'rejected');
  if (r2.status === 'rejected') {
    assert.equal(r2.code, 'CROSS_BINDING');
  }
  assert.equal(boundary.size, 1); // stores unchanged
});

// ─── Conflict: same key + sequence, different eventId ───────────────────────

test('IB: conflict → RECOVERY_REQUIRED, stores unchanged', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);

  // Accept first
  const { event: e1, outcome: o1 } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);
  boundary.observe(e1, o1);
  assert.equal(boundary.size, 1);

  // Different eventId but same key+sequence
  const { event: e2, outcome: o2 } = makeTradeEventAndOutcome(REF_SOURCE, 2000, 0); // same sequence!
  const result = boundary.observe(e2, o2);
  assert.equal(result.status, 'conflict');
  assert.equal(sm.state, 'RECOVERY_REQUIRED');
  assert.equal(boundary.size, 1); // stores unchanged — only e1 still there
});

// ─── Late: lower sequence than last ─────────────────────────────────────────

test('IB: late → RECOVERY_REQUIRED, stores unchanged', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);

  // Accept seq 0 and 1
  boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 1000, 0)));
  boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 2000, 1)));
  assert.equal(boundary.size, 2);

  // Now try seq 0 again (different eventId to avoid duplicate)
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 500, 0); // seq 0, earlier eventTime
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'late');
  assert.equal(sm.state, 'RECOVERY_REQUIRED');
  assert.equal(boundary.size, 2); // stores unchanged
});

// ─── Gap: sequence > last+1 ──────────────────────────────────────────────────

test('IB: gap (sequence > last+1) → RECOVERY_REQUIRED, stores unchanged', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);

  boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 1000, 0)));
  assert.equal(boundary.size, 1);

  // Try seq 3, skipping 1 and 2
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 4000, 3);
  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'gap');
  assert.equal(sm.state, 'RECOVERY_REQUIRED');
  assert.equal(boundary.size, 1); // stores unchanged
});

// ─── getObservation / getObservations ───────────────────────────────────────

test('IB: getObservation returns observation by eventId', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const result = boundary.observe(event, outcome);
  const obs = result.observation!;

  const retrieved = boundary.getObservation(event.eventId);
  assert.ok(retrieved);
  assert.equal(retrieved.observationId, obs.observationId);
});

test('IB: getObservation returns undefined for unknown eventId', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  assert.equal(boundary.getObservation('se-unknown'), undefined);
});

test('IB: getObservations returns frozen copy — caller cannot mutate store', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  boundary.observe(event, outcome);

  const observations = boundary.getObservations();
  assert.ok(Array.isArray(observations));
  assert.equal(observations.length, 1);
  assert.ok(Object.isFrozen(observations[0]));

  // Frozen array — pop() throws TypeError
  assert.throws(() => { observations.pop(); });
  assert.equal(boundary.size, 1); // internal store unchanged
});

test('IB: getObservations returns deeply frozen copy', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  boundary.observe(event, outcome);

  const observations = boundary.getObservations();
  const obs = observations[0];
  // Frozen — mutation silently fails in strict mode or throws
  assert.ok(Object.isFrozen(obs));
  const originalReason = obs.reason;
  try {
    (obs as any).reason = 'HACKED';
  } catch {
    // Expected
  }
  assert.equal(obs.reason, originalReason);
});

// ─── Invalid/tampered/cross-mismatched inputs ───────────────────────────────

test('IB: invalid event (tampered) → rejected, no state/store change', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const tamperedEvent = { ...event, eventId: 'se-' + '0'.repeat(64) };

  const result = boundary.observe(tamperedEvent, outcome);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_EVENT');
  }
  assert.equal(sm.state, 'SHADOW_ACTIVE');
  assert.equal(boundary.size, 0);
});

test('IB: cross-event/outcome mismatch → rejected', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  // Create a different outcome but try to pass it with the first event
  const intent2 = makeRefTradeIntent({ positionUsd: 9999 });
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 9999, tradeIntent: intent2, reason: 'Different' },
    REF_EXCHANGE, REF_SYMBOL,
  );

  const result = boundary.observe(event, outcome2);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'CROSS_BINDING');
  }
  assert.equal(boundary.size, 0);
});

test('IB: unbranded outcome → rejected', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event } = makeTradeEventAndOutcome();
  const fakeOutcome = {
    schemaVersion: 'cloddsbot.shadow.outcome.v1',
    exchange: REF_EXCHANGE, symbol: REF_SYMBOL,
    decision: 'trade', direction: 'long', reason: REF_REASON,
    blockedReason: null, intentId: 'ti-x',
    riskAdmission: { status: 'admitted' },
  };

  const result = boundary.observe(event, fakeOutcome as any);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_OUTCOME');
  }
  assert.equal(boundary.size, 0);
});

// ─── Sequence key isolation: different exchange/symbol/source are independent ──

test('IB: different sources have independent sequences', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);

  // Source A: seq 0
  boundary.observe(...Object.values(makeTradeEventAndOutcome('source-a', 1000, 0)));
  assert.equal(boundary.size, 1);

  // Source B: seq 0 — should be accepted (independent)
  boundary.observe(...Object.values(makeTradeEventAndOutcome('source-b', 1000, 0)));
  assert.equal(boundary.size, 2);

  // Source A: seq 1 — should be accepted
  boundary.observe(...Object.values(makeTradeEventAndOutcome('source-a', 2000, 1)));
  assert.equal(boundary.size, 3);
});

test('IB: different symbols have independent sequences', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);

  boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 1000, 0, REF_EXCHANGE, 'BTCUSDT')));
  boundary.observe(...Object.values(makeTradeEventAndOutcome(REF_SOURCE, 1000, 0, REF_EXCHANGE, 'ETHUSDT')));
  assert.equal(boundary.size, 2);
});

// ─── No caller input is frozen or mutated ────────────────────────────────────

test('IB: caller outcome not frozen after observe', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const frozenBefore = Object.isFrozen(outcome);
  boundary.observe(event, outcome);
  assert.equal(Object.isFrozen(outcome), frozenBefore);
});

test('IB: caller event not frozen after observe', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const frozenBefore = Object.isFrozen(event);
  boundary.observe(event, outcome);
  assert.equal(Object.isFrozen(event), frozenBefore);
});

// =============================================================================
// PROXY SAFETY TESTS (STAGE 4B4.1) — Boundary must use verified snapshot
// =============================================================================

test('IB: boundary survives Proxy event whose get trap throws', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event: realEvent, outcome } = makeTradeEventAndOutcome();

  // Wrap the event in a Proxy that has valid ownKeys + getOwnPropertyDescriptor
  // but throws on any get access. Since verifyCanonicalShadowEvent uses
  // descriptor-only inspection and returns a snapshot, the boundary must
  // work entirely from the snapshot without ever reading the Proxy.
  const proxyEvent = new Proxy(realEvent, {
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

  // This must succeed — the verifier builds a snapshot, boundary uses it
  const result = boundary.observe(proxyEvent, outcome);
  assert.equal(result.status, 'accepted');
  assert.ok(result.observation);
  assert.equal(result.observation.sourceEventId, realEvent.eventId);
  assert.equal(boundary.size, 1);
});

test('IB: boundary uses verified snapshot for sequence key (Proxy survival)', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event: realEvent, outcome } = makeTradeEventAndOutcome();

  const proxyEvent = new Proxy(realEvent, {
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
    get(_target, _prop, _receiver) { throw new Error('PROXY GET TRAP INVOKED'); },
  });

  // First observation — boundary must use verified snapshot for exchange/symbol/source/eventId
  const r1 = boundary.observe(proxyEvent, outcome);
  assert.equal(r1.status, 'accepted');

  // Duplicate check must also work with verified snapshot eventId
  const r2 = boundary.observe(proxyEvent, outcome);
  assert.equal(r2.status, 'duplicate');
});
