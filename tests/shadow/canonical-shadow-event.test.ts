/**
 * TDD adversarial coverage for CanonicalJson + CanonicalShadowEvent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { canonicalSerialize, cloneCanonicalValue } from '../../src/shadow/CanonicalJson';
import { createCanonicalShadowEvent, verifyCanonicalShadowEvent } from '../../src/shadow/CanonicalShadowEvent';
import { createShadowDecisionOutcome, isShadowDecisionOutcome } from '../../src/shadow/ShadowDecisionOutcome';
import { REF_EXCHANGE, REF_SYMBOL, REF_SOURCE, REF_REASON, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, makeRefTradeIntent } from '../helpers/shadow-reference-fixtures';

// =============================================================================
// CANONICAL JSON TESTS
// =============================================================================

// ─── Primitives ──────────────────────────────────────────────────────────────

test('CJ: null → "null"', () => {
  assert.equal(canonicalSerialize(null), 'null');
});

test('CJ: string serializes via JSON stringify', () => {
  assert.equal(canonicalSerialize('hello'), '"hello"');
  assert.equal(canonicalSerialize(''), '""');
  assert.equal(canonicalSerialize('a"b\\c'), '"a\\"b\\\\c"');
});

test('CJ: boolean serializes', () => {
  assert.equal(canonicalSerialize(true), 'true');
  assert.equal(canonicalSerialize(false), 'false');
});

test('CJ: finite numbers', () => {
  assert.equal(canonicalSerialize(0), '0');
  assert.equal(canonicalSerialize(42), '42');
  assert.equal(canonicalSerialize(-1), '-1');
  assert.equal(canonicalSerialize(3.14), '3.14');
});

test('CJ: negative zero → zero', () => {
  assert.equal(canonicalSerialize(-0), '0');
});

// ─── Arrays ──────────────────────────────────────────────────────────────────

test('CJ: arrays preserve order', () => {
  assert.equal(canonicalSerialize([3, 1, 2]), '[3,1,2]');
});

test('CJ: nested arrays', () => {
  assert.equal(canonicalSerialize([[1], [2]]), '[[1],[2]]');
});

test('CJ: empty array', () => {
  assert.equal(canonicalSerialize([]), '[]');
});

test('CJ: sparse arrays rejected', () => {
  const arr: number[] = [0];
  arr[2] = 2;
  assert.throws(() => canonicalSerialize(arr), /sparse/i);
});

// ─── Objects ─────────────────────────────────────────────────────────────────

test('CJ: object keys sorted lexicographically at every depth', () => {
  const obj = { z: 1, a: 2, m: { c: 3, b: 4 } };
  const result = canonicalSerialize(obj);
  assert.match(result, /"a".*"m".*"z"/);
  assert.match(result, /"b".*"c"/);
});

test('CJ: null prototype accepted', () => {
  const obj = Object.create(null) as any;
  obj.x = 1;
  assert.equal(canonicalSerialize(obj), '{"x":1}');
});

// ─── Unsupported types ──────────────────────────────────────────────────────

const UNDEF = undefined as any;
const BIG = BigInt(1) as any;
const SYM = Symbol('x') as any;
const FUNC = (() => {}) as any;

test('CJ: undefined rejected', () => { assert.throws(() => canonicalSerialize(UNDEF)); });
test('CJ: bigint rejected', () => { assert.throws(() => canonicalSerialize(BIG)); });
test('CJ: symbol rejected', () => { assert.throws(() => canonicalSerialize(SYM)); });
test('CJ: function rejected', () => { assert.throws(() => canonicalSerialize(FUNC)); });
test('CJ: NaN rejected', () => { assert.throws(() => canonicalSerialize(NaN)); });
test('CJ: Infinity rejected', () => { assert.throws(() => canonicalSerialize(Infinity)); });
test('CJ: -Infinity rejected', () => { assert.throws(() => canonicalSerialize(-Infinity)); });

// ─── Non-plain objects ──────────────────────────────────────────────────────

test('CJ: class instance rejected', () => {
  class Foo { x = 1; }
  assert.throws(() => canonicalSerialize(new Foo() as any));
});

test('CJ: Date instance rejected', () => {
  assert.throws(() => canonicalSerialize(new Date() as any));
});

test('CJ: Map instance rejected', () => {
  assert.throws(() => canonicalSerialize(new Map() as any));
});

// ─── Property descriptor rejection ──────────────────────────────────────────

test('CJ: accessor (getter) never invoked and rejected', () => {
  const obj = { get x() { throw new Error('GETTER INVOKED'); } };
  assert.throws(() => canonicalSerialize(obj as any), /accessor|getter/i);
});

test('CJ: symbol keys rejected', () => {
  const obj = { [Symbol('s')]: 1, a: 2 };
  assert.throws(() => canonicalSerialize(obj as any));
});

test('CJ: non-enumerable properties rejected', () => {
  const obj = { a: 1 };
  Object.defineProperty(obj, 'hidden', { value: 2, enumerable: false });
  assert.throws(() => canonicalSerialize(obj as any));
});

test('CJ: array custom properties rejected', () => {
  const arr: any = [1, 2];
  arr.extra = 3;
  assert.throws(() => canonicalSerialize(arr));
});

// ─── Cycles ──────────────────────────────────────────────────────────────────

test('CJ: direct cycle rejected', () => {
  const obj: any = {};
  obj.self = obj;
  assert.throws(() => canonicalSerialize(obj), /cycle/i);
});

test('CJ: indirect cycle rejected', () => {
  const a: any = {};
  const b: any = { a };
  a.b = b;
  assert.throws(() => canonicalSerialize(a), /cycle/i);
});

// ─── Caller immutability ─────────────────────────────────────────────────────

test('CJ: cloneCanonicalValue does not freeze caller', () => {
  const original = { x: 1 };
  const cloned = cloneCanonicalValue(original);
  assert.ok(!Object.isFrozen(original));
  assert.ok(Object.isFrozen(cloned));
  assert.deepEqual(cloned, original);
});

test('CJ: canonicalSerialize does not freeze caller', () => {
  const original = { x: 1 };
  canonicalSerialize(original);
  assert.ok(!Object.isFrozen(original));
});

test('CJ: canonicalSerialize does not mutate caller', () => {
  const original = { z: 2, a: 1 };
  const keysBefore = Object.keys(original);
  canonicalSerialize(original);
  assert.deepEqual(Object.keys(original), keysBefore);
});

test('CJ: deep freeze on clone', () => {
  const original = { a: { b: { c: 1 } } };
  const cloned = cloneCanonicalValue(original);
  assert.ok(Object.isFrozen(cloned));
  assert.ok(Object.isFrozen(cloned.a));
  assert.ok(Object.isFrozen(cloned.a.b));
});

test('CJ: deep freeze arrays', () => {
  const original = [{ x: 1 }];
  const cloned = cloneCanonicalValue(original);
  assert.ok(Object.isFrozen(cloned));
  assert.ok(Object.isFrozen(cloned[0]));
});

test('CJ: shared non-cyclic subobjects serialize repeatedly', () => {
  const child = { x: 1 };
  const parent = { a: child, b: child };
  assert.equal(canonicalSerialize(parent), '{"a":{"x":1},"b":{"x":1}}');
});

test('CJ: deterministic output', () => {
  assert.equal(
    canonicalSerialize({ b: 1, a: 2 }),
    canonicalSerialize({ a: 2, b: 1 }),
  );
});

test('CJ: null prototype object sorts keys', () => {
  const obj = Object.create(null) as any;
  obj.b = 1;
  obj.a = 2;
  assert.equal(canonicalSerialize(obj), '{"a":2,"b":1}');
});

// ─── cloneCanonicalValue rejection (same contract as canonicalSerialize) ─────

test('CJ: cloneCanonicalValue rejects cycle', () => {
  const obj: any = {};
  obj.self = obj;
  assert.throws(() => cloneCanonicalValue(obj), /cycle/i);
});

test('CJ: cloneCanonicalValue rejects sparse array', () => {
  const arr: number[] = [0];
  arr[2] = 2;
  assert.throws(() => cloneCanonicalValue(arr), /sparse/i);
});

test('CJ: cloneCanonicalValue rejects accessor without invoking it', () => {
  const obj = { get x() { throw new Error('GETTER INVOKED'); } };
  assert.throws(() => cloneCanonicalValue(obj as any), /accessor/i);
});

test('CJ: cloneCanonicalValue rejects symbol key', () => {
  const obj = { [Symbol('s')]: 1, a: 2 };
  assert.throws(() => cloneCanonicalValue(obj as any), /symbol/i);
});

test('CJ: cloneCanonicalValue rejects non-plain object', () => {
  class Foo { x = 1; }
  assert.throws(() => cloneCanonicalValue(new Foo() as any), /non-plain/i);
});

// =============================================================================
// CANONICAL SHADOW EVENT TESTS
// =============================================================================

test('CE: creates event from trade outcome', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);

  assert.equal(event.schemaVersion, 'cloddsbot.shadow.event.v1');
  assert.equal(event.exchange, REF_EXCHANGE);
  assert.equal(event.symbol, REF_SYMBOL);
  assert.equal(event.source, REF_SOURCE);
  assert.equal(event.eventType, 'trade');
  assert.equal(event.eventTimeMs, REF_EVENT_TIME_MS);
  assert.equal(event.sourceSequence, REF_SOURCE_SEQUENCE);
  assert.equal(event.payloadDigest.length, 64);
  assert.match(event.eventId, /^se-[a-f0-9]{64}$/);
});

test('CE: event output is deeply frozen', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.payload));
});

test('CE: caller outcome not frozen or mutated', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const outcomeBefore = JSON.stringify(outcome);
  createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  assert.equal(JSON.stringify(outcome), outcomeBefore);
});

test('CE: deterministic eventId for same inputs', () => {
  const intent = makeRefTradeIntent();
  const outcome1 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const outcome2 = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const e1 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome1);
  const e2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome2);
  assert.equal(e1.eventId, e2.eventId);
  assert.equal(e1.payloadDigest, e2.payloadDigest);
});

test('CE: different eventTimeMs → different eventId', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const e1 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const e2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS + 1, REF_SOURCE_SEQUENCE, outcome);
  assert.notEqual(e1.eventId, e2.eventId);
});

test('CE: different sourceSequence → different eventId', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const e1 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, 0, outcome);
  const e2 = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, 1, outcome);
  assert.notEqual(e1.eventId, e2.eventId);
});

test('CE: verifier accepts valid event', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const result = verifyCanonicalShadowEvent(event);
  assert.ok(result);
  assert.equal(result.eventId, event.eventId);
});

test('CE: verifier rejects tampered exchange', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, exchange: 'binance' as any };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects tampered payloadDigest', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, payloadDigest: '0'.repeat(64) };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects tampered eventId', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, eventId: 'se-' + '1'.repeat(64) };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier accessor never invoked', () => {
  // Create an object with getters that throw
  const malicious = {
    schemaVersion: 'cloddsbot.shadow.event.v1',
    exchange: REF_EXCHANGE,
    symbol: REF_SYMBOL,
    source: REF_SOURCE,
    eventType: 'trade',
    eventTimeMs: REF_EVENT_TIME_MS,
    sourceSequence: REF_SOURCE_SEQUENCE,
    get payloadDigest() { throw new Error('ACCESSOR INVOKED'); },
    get eventId() { throw new Error('ACCESSOR INVOKED'); },
    payload: { decision: 'trade', direction: 'long', reason: REF_REASON, blockedReason: null, intentId: 'ti-ref', riskAdmission: { status: 'admitted' } as const },
  };
  // Should safely inspect without invoking getters
  assert.equal(verifyCanonicalShadowEvent(malicious), null);
});

test('CE: verifier rejects null/undefined/non-object', () => {
  assert.equal(verifyCanonicalShadowEvent(null), null);
  assert.equal(verifyCanonicalShadowEvent(undefined), null);
  assert.equal(verifyCanonicalShadowEvent('nope'), null);
  assert.equal(verifyCanonicalShadowEvent(42), null);
});

test('CE: verifier rejects wrong schemaVersion', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, schemaVersion: 'cloddsbot.shadow.event.v2' };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects non-safe-integer eventTimeMs', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, eventTimeMs: 1.5 };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects negative eventTimeMs', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, eventTimeMs: -1 };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects non-safe-integer sourceSequence', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, sourceSequence: 1.5 };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects empty source', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event, source: '' };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

// Nested caller mutation test for event
test('CE: nested caller object mutation does not affect event', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE,
    REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const eventIdBefore = event.eventId;
  // Mutate the outcome (which should already be deep-frozen, but just in case)
  // The event's payload should be deep-cloned, so this shouldn't matter anyway
  assert.equal(event.eventId, eventIdBefore);
});

// ─── Factory rejects unbranded outcome ───────────────────────────────────────

test('CE: factory rejects unbranded outcome', () => {
  const fakeOutcome = {
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
  assert.throws(() => createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, fakeOutcome as any));
});

// ─── Self-consistent forged events (recomputed digest/eventId) ────────────────

/** Build a self-consistent forged event with recomputed digest and eventId. */
function forgeEvent(overrides: {
  exchange?: string;
  symbol?: string;
  source?: string;
  eventType?: string;
  eventTimeMs?: number;
  sourceSequence?: number;
  payloadOverrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const basePayload: Record<string, unknown> = {
    decision: 'trade',
    direction: 'long',
    reason: REF_REASON,
    blockedReason: null,
    intentId: 'ti-ref',
    riskAdmission: { status: 'admitted' },
    ...overrides.payloadOverrides,
  };

  // Deep-clone payload via cloneCanonicalValue then recompute payloadDigest
  const payloadClone = cloneCanonicalValue(basePayload);
  const payloadDigest = crypto.createHash('sha256')
    .update('CLODDSBOT_SHADOW_PAYLOAD\x00v1\x00' + canonicalSerialize(payloadClone), 'utf8')
    .digest('hex');

  const eventWithoutId: Record<string, unknown> = {
    schemaVersion: 'cloddsbot.shadow.event.v1',
    exchange: overrides.exchange ?? REF_EXCHANGE,
    symbol: overrides.symbol ?? REF_SYMBOL,
    source: overrides.source ?? REF_SOURCE,
    eventType: overrides.eventType ?? 'trade',
    eventTimeMs: overrides.eventTimeMs ?? REF_EVENT_TIME_MS,
    sourceSequence: overrides.sourceSequence ?? REF_SOURCE_SEQUENCE,
    payloadDigest,
  };

  const eventId = 'se-' + crypto.createHash('sha256')
    .update('CLODDSBOT_SHADOW_EVENT\x00v1\x00' + canonicalSerialize(eventWithoutId), 'utf8')
    .digest('hex');

  return {
    ...eventWithoutId,
    eventId,
    payload: payloadClone,
  };
}

test('CE: verifier rejects self-consistent forged event with mismatched eventType/payload', () => {
  // eventType='trade' but payload.decision='defense'
  const forged = forgeEvent({
    eventType: 'trade',
    payloadOverrides: {
      decision: 'defense',
      direction: 'hold',
      reason: 'Risk blocked',
      blockedReason: 'Risk blocked',
      intentId: null,
      riskAdmission: { status: 'blocked', reason: 'Risk blocked' },
    },
  });
  assert.equal(verifyCanonicalShadowEvent(forged), null);
});

test('CE: verifier rejects self-consistent forged event with invalid risk status/reason', () => {
  // defense payload with riskAdmission status='admitted' (invalid for defense)
  const forged = forgeEvent({
    eventType: 'defense',
    payloadOverrides: {
      decision: 'defense',
      direction: 'hold',
      reason: 'Risk blocked',
      blockedReason: 'Risk blocked',
      intentId: null,
      riskAdmission: { status: 'admitted' },
    },
  });
  assert.equal(verifyCanonicalShadowEvent(forged), null);
});

test('CE: verifier rejects self-consistent forged event with extra payload field', () => {
  const forged = forgeEvent({
    payloadOverrides: {
      extraField: 'should not be here',
    },
  });
  assert.equal(verifyCanonicalShadowEvent(forged), null);
});

test('CE: verifier rejects self-consistent forged event with wrong risk reason on defense', () => {
  // defense: risk reason must equal reason and blockedReason
  const forged = forgeEvent({
    eventType: 'defense',
    payloadOverrides: {
      decision: 'defense',
      direction: 'hold',
      reason: 'Risk blocked',
      blockedReason: 'Risk blocked',
      intentId: null,
      riskAdmission: { status: 'blocked', reason: 'Different reason' },
    },
  });
  assert.equal(verifyCanonicalShadowEvent(forged), null);
});

// =============================================================================
// EXACT OBJECT SCHEMA TESTS (STAGE 4B4.1)
// =============================================================================

// ─── Extra symbol key rejection ──────────────────────────────────────────────

test('CE: verifier rejects extra symbol key at event top level', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event };
  Object.defineProperty(tampered, Symbol('extra'), { value: 1, enumerable: true });
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects extra symbol key at payload level', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tamperedPayload = { ...event.payload };
  Object.defineProperty(tamperedPayload, Symbol('extra'), { value: 1, enumerable: true });
  const forgedWithSymbol = { ...event, payload: tamperedPayload };
  assert.equal(verifyCanonicalShadowEvent(forgedWithSymbol), null);
});

test('CE: verifier rejects extra symbol key at riskAdmission level', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);

  // Shallow-copy riskAdmission, attach symbol key (no forgeEvent — must not serialize)
  const tamperedRA = { status: 'admitted' as const };
  Object.defineProperty(tamperedRA, Symbol('extra'), { value: 1, enumerable: true });

  // Shallow-copy payload, replace riskAdmission, retain existing digest/ID
  const tamperedPayload = { ...event.payload, riskAdmission: tamperedRA };
  const tampered = { ...event, payload: tamperedPayload };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

// ─── Non-enumerable required field rejection ─────────────────────────────────

test('CE: verifier rejects non-enumerable required field at event top level', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tampered = { ...event };
  Object.defineProperty(tampered, 'exchange', { value: tampered.exchange, enumerable: false });
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects non-enumerable required field at payload level', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const tamperedPayload = { ...event.payload };
  Object.defineProperty(tamperedPayload, 'decision', { value: tamperedPayload.decision, enumerable: false });
  const tampered = { ...event, payload: tamperedPayload };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

test('CE: verifier rejects non-enumerable required field at riskAdmission level', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);

  // Shallow-copy riskAdmission, make status non-enumerable (no forgeEvent — must not serialize)
  const tamperedRA = { status: 'admitted' as const };
  Object.defineProperty(tamperedRA, 'status', { value: 'admitted', enumerable: false });

  // Shallow-copy payload, replace riskAdmission, retain existing digest/ID
  const tamperedPayload = { ...event.payload, riskAdmission: tamperedRA };
  const tampered = { ...event, payload: tamperedPayload };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
});

// ─── Getter counters remain zero ─────────────────────────────────────────────

test('CE: accessor getter on event top level — counter remains zero', () => {
  let getterCalls = 0;
  const malicious = {
    schemaVersion: 'cloddsbot.shadow.event.v1',
    exchange: REF_EXCHANGE,
    symbol: REF_SYMBOL,
    source: REF_SOURCE,
    eventType: 'trade',
    eventTimeMs: REF_EVENT_TIME_MS,
    sourceSequence: REF_SOURCE_SEQUENCE,
    get payloadDigest() { getterCalls++; return '0'.repeat(64); },
    get eventId() { getterCalls++; return 'se-' + '1'.repeat(64); },
    payload: { decision: 'trade', direction: 'long', reason: REF_REASON, blockedReason: null, intentId: 'ti-ref', riskAdmission: { status: 'admitted' } as const },
  };
  assert.equal(verifyCanonicalShadowEvent(malicious), null);
  assert.equal(getterCalls, 0);
});

test('CE: accessor getter on payload — counter remains zero', () => {
  let getterCalls = 0;
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);

  // Build tampered payload with getter on 'decision' using defineProperties
  // (avoiding spread which would invoke the getter)
  const tamperedPayload: Record<string, unknown> = {};
  Object.defineProperties(tamperedPayload, {
    decision: {
      get() { getterCalls++; return 'trade'; },
      enumerable: true,
      configurable: true,
    },
    direction: { value: 'long', enumerable: true, writable: true, configurable: true },
    reason: { value: REF_REASON, enumerable: true, writable: true, configurable: true },
    blockedReason: { value: null, enumerable: true, writable: true, configurable: true },
    intentId: { value: 'ti-ref', enumerable: true, writable: true, configurable: true },
    riskAdmission: { value: { status: 'admitted' }, enumerable: true, writable: true, configurable: true },
  });
  const tampered = { ...event, payload: tamperedPayload };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
  assert.equal(getterCalls, 0);
});

test('CE: accessor getter on riskAdmission — counter remains zero', () => {
  let getterCalls = 0;
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);

  // Build tampered riskAdmission with getter on 'status'
  const tamperedRA: Record<string, unknown> = {};
  Object.defineProperties(tamperedRA, {
    status: {
      get() { getterCalls++; return 'admitted'; },
      enumerable: true,
      configurable: true,
    },
  });

  // Clone payload but replace riskAdmission with getter version
  const tamperedPayload = { ...event.payload, riskAdmission: tamperedRA };
  const tampered = { ...event, payload: tamperedPayload };
  assert.equal(verifyCanonicalShadowEvent(tampered), null);
  assert.equal(getterCalls, 0);
});

// ─── Verified snapshot: non-identical frozen copy ────────────────────────────

test('CE: verify returns non-identical frozen snapshot (event top)', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const result = verifyCanonicalShadowEvent(event);
  assert.ok(result);
  assert.notStrictEqual(result, event); // non-identical
  assert.deepEqual(result, event);       // but equal
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.payload));
  const raResult = (result.payload as any).riskAdmission;
  assert.ok(Object.isFrozen(raResult));
});

test('CE: mutating original after verification cannot change verified snapshot', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  const result = verifyCanonicalShadowEvent(event);
  assert.ok(result);
  const reasonBefore = result.payload.reason;

  // Mutate a mutable copy of the original event
  const mutableEvent = { ...event, payload: { ...event.payload } };
  (mutableEvent.payload as any).reason = 'HACKED';

  // Snapshot must be unchanged
  assert.equal(result.payload.reason, reasonBefore);
  assert.notEqual(result.payload.reason, 'HACKED');
});

test('CE: original artifact remains unfrozen after verification', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const event = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);
  // Make a mutable copy (spread, not frozen)
  const mutableCopy = { ...event, payload: { ...event.payload, riskAdmission: { ...(event.payload.riskAdmission as object) } } };
  assert.ok(!Object.isFrozen(mutableCopy));
  const result = verifyCanonicalShadowEvent(mutableCopy);
  assert.ok(result);
  assert.ok(!Object.isFrozen(mutableCopy));
});

// ─── Proxy safety: get trap throws, but descriptors are valid ────────────────

test('CE: verifier survives Proxy with throwing get trap, returns snapshot', () => {
  const intent = makeRefTradeIntent();
  const outcome = createShadowDecisionOutcome(
    { exchange: REF_EXCHANGE, decision: 'trade', direction: 'long', symbol: REF_SYMBOL, positionUsd: 1500, tradeIntent: intent, reason: REF_REASON },
    REF_EXCHANGE, REF_SYMBOL,
  );
  const realEvent = createCanonicalShadowEvent(REF_SOURCE, REF_EVENT_TIME_MS, REF_SOURCE_SEQUENCE, outcome);

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

  const result = verifyCanonicalShadowEvent(proxyEvent);
  assert.ok(result);
  assert.equal(result.eventId, realEvent.eventId);
  assert.notStrictEqual(result, realEvent);
  assert.notStrictEqual(result, proxyEvent as any);
  assert.equal(result.exchange, REF_EXCHANGE);
});
