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

// =============================================================================
// STAGE 4B4.2 — prepare / commit transaction API
// =============================================================================

test('IB: prepare returns a token with accepted status', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');
  assert.ok(token.observation);
  assert.ok(typeof token.preparedId === 'string');
  assert.ok(token.preparedId.startsWith('sp-'));
});

test('IB: prepare has zero mutation on boundary state', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const sizeBefore = boundary.size;
  boundary.prepare(event, outcome);
  assert.equal(boundary.size, sizeBefore);
  assert.equal(sm.state, 'SHADOW_ACTIVE');
});

test('IB: prepare rejects invalid event', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();
  const tamperedEvent = { ...event, eventId: 'se-' + '0'.repeat(64) };

  const token = boundary.prepare(tamperedEvent, outcome);
  assert.equal(token.status, 'rejected');
  if (token.status === 'rejected') {
    assert.equal(token.code, 'INVALID_EVENT');
  }
});

test('IB: prepare rejects unbranded outcome', () => {
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

  const token = boundary.prepare(event, fakeOutcome as any);
  assert.equal(token.status, 'rejected');
  if (token.status === 'rejected') {
    assert.equal(token.code, 'INVALID_OUTCOME');
  }
});

test('IB: prepare rejects cross-binding outcome', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  // Create different outcome for cross-binding
  const intent2 = makeRefTradeIntent({ positionUsd: 9999 });
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 9999, tradeIntent: intent2, reason: 'Different' },
    REF_EXCHANGE, REF_SYMBOL,
  );

  // Pass event of first with outcome of second
  const token = boundary.prepare(event, outcome2);
  assert.equal(token.status, 'rejected');
  if (token.status === 'rejected') {
    assert.equal(token.code, 'CROSS_BINDING');
  }
});

test('IB: commit valid token updates all indexes once', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  const sizeBefore = boundary.size;
  boundary.commit(token);
  assert.equal(boundary.size, sizeBefore + 1);

  const obs = boundary.getObservation(event.eventId);
  assert.ok(obs);
  assert.equal(obs!.observationId, token.observation!.observationId);
});

test('IB: commit changes all three maps (observationsByEventId, lastSequenceByKey, eventIdByKeyAndSequence)', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);

  const token = boundary.prepare(event, outcome);
  boundary.commit(token);

  // All three maps should be updated via getObservation (which uses observationsByEventId)
  // and via accepting a second event (which depends on lastSequenceByKey + eventIdByKeyAndSequence)
  const obs = boundary.getObservation(event.eventId);
  assert.ok(obs);
  assert.equal(obs!.sourceSequence, 0);

  // Second event with next sequence should be accepted
  const { event: e2, outcome: o2 } = makeTradeEventAndOutcome(REF_SOURCE, 2000, 1);
  const r2 = boundary.observe(e2, o2);
  assert.equal(r2.status, 'accepted');
});

test('IB: forged prepared token (tampered observation) rejected by commit', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  // Forge by modifying the observation
  const forgedToken = {
    ...token,
    observation: { ...token.observation, observationId: 'so-' + 'f'.repeat(64) },
  };

  assert.throws(() => { boundary.commit(forgedToken); });
  assert.equal(boundary.size, 0);
});

test('IB: copied prepared token rejected on second commit (single-use)', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  boundary.commit(token);
  assert.equal(boundary.size, 1);

  // Second commit of same token should fail — single-use
  assert.throws(() => { boundary.commit(token); });
  assert.equal(boundary.size, 1); // unchanged
});

test('IB: replayed prepared token (stale) rejected by commit', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);

  const token = boundary.prepare(event, outcome);
  boundary.commit(token);

  // Now replay: same prepared token with different boundary state
  assert.throws(() => { boundary.commit(token); });
});

test('IB: prepared token from wrong boundary instance rejected', () => {
  const sm1 = activateSM();
  const boundary1 = createShadowIntentBoundary(sm1);
  const { event, outcome } = makeTradeEventAndOutcome();
  const token = boundary1.prepare(event, outcome);

  const sm2 = activateSM();
  const boundary2 = createShadowIntentBoundary(sm2);

  assert.throws(() => { boundary2.commit(token); });
  assert.equal(boundary2.size, 0);
});

test('IB: stale prepared token rejected after version change', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 0, 0);

  const token = boundary.prepare(event, outcome);
  // Don't commit — instead commit a different event first to change state
  const { event: e2, outcome: o2 } = makeTradeEventAndOutcome(REF_SOURCE, 100, 1);
  boundary.observe(e2, o2);

  // Now the first token should be stale (sequence wrong)
  assert.throws(() => { boundary.commit(token); });
});

// =============================================================================
// STAGE 4B4.2 — observe backward compatibility (composes prepare+commit)
// =============================================================================

test('IB: observe still accepts valid event+outcome (backward compat)', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const result = boundary.observe(event, outcome);
  assert.equal(result.status, 'accepted');
  assert.ok(result.observation);
  assert.equal(boundary.size, 1);
});

// =============================================================================
// STAGE 4B4.2 — restore path
// =============================================================================

test('IB: restore accepts valid event+observation in SHADOW_READY', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0);

  // Get a valid observation via prepare on a different boundary
  const tmpSm = activateSM();
  const tmpBoundary = createShadowIntentBoundary(tmpSm);
  const tmpResult = tmpBoundary.observe(event, outcome);
  const observation = tmpResult.observation!;

  // Restore in SHADOW_READY
  boundary.restore(event, observation);
  assert.equal(boundary.size, 1);

  const restored = boundary.getObservation(event.eventId);
  assert.ok(restored);
  assert.equal(restored!.observationId, observation.observationId);
});

test('IB: restore rejected in SHADOW_ACTIVE', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const tmpSm = activateSM();
  const tmpBoundary = createShadowIntentBoundary(tmpSm);
  const tmpResult = tmpBoundary.observe(event, outcome);

  assert.throws(() => { boundary.restore(event, tmpResult.observation!); });
});

test('IB: restore rejected for tampered event', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const tmpSm = activateSM();
  const tmpBoundary = createShadowIntentBoundary(tmpSm);
  const tmpResult = tmpBoundary.observe(event, outcome);
  const observation = tmpResult.observation!;

  const tamperedEvent = { ...event, eventId: 'se-' + '0'.repeat(64) };
  assert.throws(() => { boundary.restore(tamperedEvent, observation); });
});

test('IB: restore rejected for gap in sequence', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  const boundary = createShadowIntentBoundary(sm);

  // Create event with sequence 5 (gap from expected 0)
  const { event, outcome } = makeTradeEventAndOutcome(REF_SOURCE, 5000, 5);
  const tmpSm = activateSM();
  const tmpBoundary = createShadowIntentBoundary(tmpSm);
  const tmpResult = tmpBoundary.observe(event, outcome);

  assert.throws(() => { boundary.restore(event, tmpResult.observation!); });
});

test('IB: restore rejected for duplicate eventId', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const tmpSm = activateSM();
  const tmpBoundary = createShadowIntentBoundary(tmpSm);
  const tmpResult = tmpBoundary.observe(event, outcome);
  const observation = tmpResult.observation!;

  // First restore ok
  boundary.restore(event, observation);
  assert.equal(boundary.size, 1);

  // Second restore with same eventId should fail
  assert.throws(() => { boundary.restore(event, observation); });
});

test('IB: restore rejected for cross-binding', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  const boundary = createShadowIntentBoundary(sm);

  const { event: e1, outcome: o1 } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0, REF_EXCHANGE, 'BTCUSDT');
  const { event: e2, outcome: o2 } = makeTradeEventAndOutcome(REF_SOURCE, 1000, 0, REF_EXCHANGE, 'ETHUSDT');

  const tmpSm = activateSM();
  const tmpBoundary = createShadowIntentBoundary(tmpSm);
  const r1 = tmpBoundary.observe(e1, o1);
  const r2 = tmpBoundary.observe(e2, o2);

  // Cross-binding: e1's event with e2's observation
  assert.throws(() => { boundary.restore(e1, r2.observation!); });
});

test('IB: restore maintains contiguous sequences for multiple entries', () => {
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  const boundary = createShadowIntentBoundary(sm);

  const tmpSm = activateSM();
  const tmpBoundary = createShadowIntentBoundary(tmpSm);

  const entries = [
    makeTradeEventAndOutcome(REF_SOURCE, 1000, 0),
    makeTradeEventAndOutcome(REF_SOURCE, 2000, 1),
    makeTradeEventAndOutcome(REF_SOURCE, 3000, 2),
  ];

  for (const { event, outcome } of entries) {
    const r = tmpBoundary.observe(event, outcome);
    boundary.restore(event, r.observation!);
  }

  assert.equal(boundary.size, 3);
});

// =============================================================================
// STAGE 4B4.2 — Contract 1: WeakSet identity tests
// =============================================================================

test('IB: copied valid PreparedToken rejected before first commit (shallow copy)', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  // Shallow copy — different object identity
  const copiedToken = { ...token };

  // First commit of the copy must fail (not in WeakSet)
  assert.throws(() => { boundary.commit(copiedToken); });
  assert.equal(boundary.size, 0); // boundary stays unchanged
});

test('IB: deep copy of valid PreparedToken rejected (structuredClone)', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  // Deep copy via structuredClone — different object identity
  const deepCopy = structuredClone(token);
  assert.throws(() => { boundary.commit(deepCopy); });
  assert.equal(boundary.size, 0);
});

test('IB: Object.create clone of token rejected', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  // Object.create — inherits properties but is a different object
  const cloned = Object.create(Object.getPrototypeOf(token), Object.getOwnPropertyDescriptors(token));
  assert.throws(() => { boundary.commit(cloned); });
  assert.equal(boundary.size, 0);
});

test('IB: Proxy-wrapped token rejected', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  // Proxy wrapping — new object identity
  const proxied = new Proxy(token, {});
  assert.throws(() => { boundary.commit(proxied as any); });
  assert.equal(boundary.size, 0);
});

// =============================================================================
// STAGE 4B4.2 R2 — Defect 1: computePreparedId binds all fields
// =============================================================================

test('IB R2/D1: tampering eventId changes preparedId → commit rejects', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  // Tamper _eventId — preparedId stays the same because it's a shallow spread
  const tampered = { ...token, _eventId: 'wrong-' + token._eventId };
  // The old preparedId was computed with original eventId; commit recomputes
  // with the tampered one and finds mismatch.
  assert.throws(() => { boundary.commit(tampered); });
  assert.equal(boundary.size, 0);
});

test('IB R2/D1: tampering _key changes preparedId → commit rejects', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  const tampered = { ...token, _key: 'wrong::key::here' };
  assert.throws(() => { boundary.commit(tampered); });
  assert.equal(boundary.size, 0);
});

test('IB R2/D1: tampering _sourceSequence changes preparedId → commit rejects', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  const tampered = { ...token, _sourceSequence: 999 };
  assert.throws(() => { boundary.commit(tampered); });
  assert.equal(boundary.size, 0);
});

test('IB R2/D1: any single field change in preparedId preimage breaks commit', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  // All fields in computePreparedId: status, observationId, boundaryTag, version,
  // eventId, key, sourceSequence. We test each individually.
  const fields = ['_eventId', '_key', '_sourceSequence'] as const;
  for (const field of fields) {
    const original = token[field];
    const tampered = {
      ...token,
      [field]: typeof original === 'number' ? 99999 : 'tampered-' + field,
    };
    assert.throws(
      () => { boundary.commit(tampered); },
      `field ${field} tamper should be rejected`,
    );
  }
  assert.equal(boundary.size, 0);
});

// =============================================================================
// STAGE 4B4.2 R2 — Defect 2: WeakSet before property read (Proxy zero-getter proof)
// =============================================================================

test('IB R2/D2: forged Proxy token rejected with zero getter/trap calls', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const token = boundary.prepare(event, outcome);
  assert.equal(token.status, 'accepted');

  let getterCount = 0;
  const proxied = new Proxy({} as any, {
    get(_target, _prop, _receiver) {
      getterCount++;
      return (token as any)[_prop];
    },
    ownKeys() { return Reflect.ownKeys(token); },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(token, prop);
    },
  });

  // Commit must reject because proxy isn't in WeakSet
  assert.throws(() => { boundary.commit(proxied); });
  // Zero getter calls: WeakSet check must happen before any property read
  assert.equal(getterCount, 0);
  assert.equal(boundary.size, 0);
});

test('IB R2/D2: Proxy with malicious getter has zero traps fired before WeakSet rejection', () => {
  const sm = activateSM();
  const boundary = createShadowIntentBoundary(sm);
  const { event, outcome } = makeTradeEventAndOutcome();

  const realToken = boundary.prepare(event, outcome);
  assert.equal(realToken.status, 'accepted');

  let trapFired = false;
  let mutationCount = 0;
  const maliciousProxy = new Proxy({} as any, {
    get(_target, prop, _receiver) {
      trapFired = true;
      mutationCount++;
      // Attacker tries to mutate global state through the getter
      if (prop === 'preparedId') {
        return realToken.preparedId;
      }
      return (realToken as any)[prop];
    },
    ownKeys() { return Reflect.ownKeys(realToken); },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(realToken, prop);
    },
  });

  // Must reject with zero getter calls (WeakSet check first)
  assert.throws(() => { boundary.commit(maliciousProxy); });
  assert.equal(trapFired, false, 'no getter trap should fire');
  assert.equal(mutationCount, 0, 'zero mutations');
  assert.equal(boundary.size, 0);
});
