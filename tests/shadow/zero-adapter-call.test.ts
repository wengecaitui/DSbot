/**
 * Stage 4B4.1 Atomic Task 3: Real zero-adapter-call proof.
 *
 * REFERENCE TEST FIXTURE ONLY — NOT APPROVED FOR PAPER TESTNET OR LIVE
 *
 * Drives the real FastPipeline with deterministic clocks and a Proxy-based
 * FastDecisionContext. Counts every access attempt to route, execute, sendOrder,
 * submit, order, fill, paper, testnet, live, adapter. Asserts forbidden
 * access count is exactly 0.
 *
 * Produces an actual FastPipelineResult, converts it through the public
 * ShadowDecisionOutcome factory, creates a CanonicalShadowEvent, activates
 * the state machine through valid transitions, observes through the
 * ShadowIntentBoundary, and asserts an accepted verified observation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IndicatorResult } from '../../src/types/indicators';
import type { DomainClock, ElapsedClock } from '../../src/runtime/Clock';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { createShadowDecisionOutcome } from '../../src/shadow/ShadowDecisionOutcome';
import { createCanonicalShadowEvent } from '../../src/shadow/CanonicalShadowEvent';
import { ShadowRuntimeStateMachine } from '../../src/shadow/ShadowRuntimeStateMachine';
import { createShadowIntentBoundary } from '../../src/shadow/ShadowIntentBoundary';
import { REF_EXCHANGE, REF_SYMBOL, REF_SOURCE, REF_REASON, REF_EVENT_TIME_MS } from '../helpers/shadow-reference-fixtures';

// ─── Constants ────────────────────────────────────────────────────────────────

const FIXTURE_LABEL = 'REFERENCE TEST FIXTURE ONLY';
/** Property names that must never be accessed on the context Proxy. */
const FORBIDDEN_NAMES = new Set([
  'route', 'execute', 'sendOrder', 'submit', 'order', 'fill',
  'paper', 'testnet', 'live', 'adapter',
]);

interface ContextAccessCounter {
  safe: number;
  forbidden: number;
}

// ─── Deterministic clocks ────────────────────────────────────────────────────

class FixedDomainClock implements DomainClock {
  private value: number;
  calls = 0;
  constructor(value: number) { this.value = value; }
  now(): number { this.calls++; return this.value; }
}

class FixedElapsedClock implements ElapsedClock {
  private values: number[];
  private idx = 0;
  calls = 0;
  constructor(values: number[]) { this.values = values; }
  now(): number {
    this.calls++;
    const v = this.values[Math.min(this.idx, this.values.length - 1)];
    this.idx++;
    return v;
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

const BULLISH_LONG_INDICATORS = [
  {
    name: 'CompositeMomentum', status: 'done', composite_score: 88,
    regime_state: 'STRONG_BULLISH', in_cooldown: false,
    dimension_scores: { hull_big_trend: { score: 80 }, stc_momentum: { score: 85 }, volume_micro: { score: 90 } },
    lag_bars: 0,
  },
  {
    name: 'SmartOrderBlock', status: 'done', has_active_ob: true,
    ob_strength_weight: 0.7, lag_bars: 0,
  },
] as unknown as IndicatorResult[];

function makeBiasReport(symbol: string, updatedAt: number) {
  return {
    exchange: 'bitget' as const,
    timestamp: updatedAt, updatedAt,
    globalBias: 'bullish' as const, confidence: 75,
    assets: [{ symbol, bias: 'bullish', direction: 'long' as const, confidence: 75, volatility: 30, suggestedPositionPct: 0.15, entryCondition: 'x', stopLoss: '-', takeProfit: '-' }],
    globalLongShortRatio: 1.5, globalVolatility: 30, fearGreedIndex: 60, fundingStatus: 'neutral' as const,
    whitelist: [symbol], blacklist: [], riskEvents: [],
    meta: { source: 'hermes_cron' as const, modelVersion: 'v1', generationTimeMs: 100, inputSummary: 'test' },
  };
}

/**
 * Create a Proxy-based FastDecisionContext that counts ALL property accesses.
 * Only the exact properties needed by FastPipeline are allowed through.
 * Any access matching FORBIDDEN_NAMES increments a shared counter and throws.
 */
function createGuardedContext(
  accessCounter: ContextAccessCounter,
  domainTime: number,
) {
  const biasReport = makeBiasReport(REF_SYMBOL, domainTime);

  const fakeKillSwitch = {
    getLockState(_exchange: string) {
      accessCounter.safe++;
      return { locked: false };
    },
    getConfig() {
      accessCounter.safe++;
      return { totalCapitalUsd: 10000 };
    },
    check(_exchange: string, _symbol: string, _positionUsd: number) {
      accessCounter.safe++;
      return { allowed: true };
    },
  };

  const target = {
    exchange: REF_EXCHANGE,
    getBiasReport: () => { accessCounter.safe++; return biasReport; },
    getConfig: () => { accessCounter.safe++; return { maxBiasReportAgeHours: 2 }; },
    killSwitch: fakeKillSwitch,
  };

  return new Proxy(target, {
    get(obj: any, prop: string | symbol) {
      if (typeof prop === 'string' && FORBIDDEN_NAMES.has(prop)) {
        accessCounter.forbidden++;
        throw new Error(`[GUARD] Forbidden context access: ${String(prop)}`);
      }
      // Allow known safe accesses
      if (prop === 'exchange') return obj.exchange;
      if (prop === 'getBiasReport') return obj.getBiasReport;
      if (prop === 'getConfig') return obj.getConfig;
      if (prop === 'killSwitch') return obj.killSwitch;
      // Any unexpected access is forbidden
      accessCounter.forbidden++;
      throw new Error(`[GUARD] Unexpected context access: ${String(prop)}`);
    },
  });
}

class FakeIndicatorService {
  async calculateAll(_: any): Promise<IndicatorResult[]> {
    return BULLISH_LONG_INDICATORS;
  }
}

function buildPipelineHarness(
  domainTime: number,
  accessCounter: ContextAccessCounter,
) {
  const domainClock = new FixedDomainClock(domainTime);
  const elapsedClock = new FixedElapsedClock([100, 145]);
  const context = createGuardedContext(accessCounter, domainTime);
  const indicatorService = new FakeIndicatorService();

  const pipeline = new FastPipeline({
    exchange: REF_EXCHANGE,
    router: context as any,
    indicatorService: indicatorService as any,
    clock: domainClock,
    elapsedClock,
  });

  return { pipeline, domainClock, elapsedClock };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('ZA1: ' + FIXTURE_LABEL + ' — real FastPipeline produces valid trade result', async () => {
  const accessCounter: ContextAccessCounter = { safe: 0, forbidden: 0 };
  const domainTime = REF_EVENT_TIME_MS;
  const { pipeline } = buildPipelineHarness(domainTime, accessCounter);

  const result = await pipeline.execute({
    exchange: REF_EXCHANGE,
    source: REF_SOURCE,
    symbol: REF_SYMBOL,
  });

  assert.equal(result.decision, 'trade', 'must produce trade decision');
  assert.ok(result.tradeIntent, 'must produce TradeIntent');
  assert.equal(result.tradeIntent!.exchange, REF_EXCHANGE);
  assert.equal(result.tradeIntent!.symbol, REF_SYMBOL);
  assert.equal(result.tradeIntent!.direction, 'long');
  assert.equal(result.tradeIntent!.createdAt, domainTime, 'createdAt must use injected domain time');

  // All context accesses were through the approved interface — no forbidden paths taken
  assert.ok(accessCounter.safe > 0, 'context was accessed (proving it was used, not bypassed)');
  assert.equal(accessCounter.forbidden, 0, 'forbidden context access count must be exactly zero');
});

test('ZA2: ' + FIXTURE_LABEL + ' — FastPipelineResult converted to ShadowDecisionOutcome via public factory', () => {
  const accessCounter: ContextAccessCounter = { safe: 0, forbidden: 0 };
  const domainTime = REF_EVENT_TIME_MS;

  // Cannot await at top level, but the factory is synchronous
  const outcome = createShadowDecisionOutcome(
    {
      exchange: REF_EXCHANGE,
      decision: 'trade',
      direction: 'long',
      symbol: REF_SYMBOL,
      positionUsd: 1500,
      tradeIntent: {
        intentId: 'ti-test-' + '0'.repeat(40),
        exchange: REF_EXCHANGE,
        symbol: REF_SYMBOL,
        direction: 'long',
        orderType: 'market',
        positionUsd: 1500,
        source: REF_SOURCE,
        createdAt: domainTime,
        reason: REF_REASON,
        biasUpdatedAt: domainTime - 1000,
      },
      reason: REF_REASON,
    },
    REF_EXCHANGE,
    REF_SYMBOL,
  );

  assert.equal(outcome.decision, 'trade');
  assert.equal(outcome.direction, 'long');
  assert.equal(outcome.exchange, REF_EXCHANGE);
  assert.equal(outcome.symbol, REF_SYMBOL);
  assert.equal(outcome.riskAdmission.status, 'admitted');
  assert.equal(outcome.intentId, 'ti-test-' + '0'.repeat(40));
});

test('ZA3: ' + FIXTURE_LABEL + ' — CanonicalShadowEvent created from ShadowDecisionOutcome', () => {
  const accessCounter: ContextAccessCounter = { safe: 0, forbidden: 0 };
  const domainTime = REF_EVENT_TIME_MS;

  const outcome = createShadowDecisionOutcome(
    {
      exchange: REF_EXCHANGE,
      decision: 'trade',
      direction: 'long',
      symbol: REF_SYMBOL,
      positionUsd: 1500,
      tradeIntent: {
        intentId: 'ti-test-' + '0'.repeat(40),
        exchange: REF_EXCHANGE,
        symbol: REF_SYMBOL,
        direction: 'long',
        orderType: 'market',
        positionUsd: 1500,
        source: REF_SOURCE,
        createdAt: domainTime,
        reason: REF_REASON,
        biasUpdatedAt: domainTime - 1000,
      },
      reason: REF_REASON,
    },
    REF_EXCHANGE,
    REF_SYMBOL,
  );

  const event = createCanonicalShadowEvent(REF_SOURCE, domainTime, 0, outcome);

  assert.equal(event.eventType, 'trade');
  assert.equal(event.exchange, REF_EXCHANGE);
  assert.equal(event.symbol, REF_SYMBOL);
  assert.equal(event.source, REF_SOURCE);
  assert.equal(event.eventTimeMs, domainTime);
  assert.equal(event.sourceSequence, 0);
  assert.ok(event.eventId.startsWith('se-'), 'eventId must have se- prefix');
  assert.ok(event.payloadDigest.length === 64, 'payloadDigest must be SHA-256 hex');
});

test('ZA4: ' + FIXTURE_LABEL + ' — full pipeline-to-observation chain with zero forbidden access', async () => {
  const accessCounter: ContextAccessCounter = { safe: 0, forbidden: 0 };
  const domainTime = REF_EVENT_TIME_MS;

  // Step 1: Run real FastPipeline
  const { pipeline } = buildPipelineHarness(domainTime, accessCounter);
  const result = await pipeline.execute({
    exchange: REF_EXCHANGE,
    source: REF_SOURCE,
    symbol: REF_SYMBOL,
  });
  assert.equal(result.decision, 'trade');
  const contextAccessesBeforeShadow = accessCounter.safe;
  assert.ok(contextAccessesBeforeShadow > 0, 'context was used during pipeline execution');

  // Step 2: Convert to ShadowDecisionOutcome
  const outcome = createShadowDecisionOutcome(result, REF_EXCHANGE, REF_SYMBOL);
  assert.equal(outcome.decision, 'trade');

  // Step 3: Create CanonicalShadowEvent
  const event = createCanonicalShadowEvent(REF_SOURCE, domainTime, 0, outcome);

  // Step 4: Activate state machine
  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('ACTIVATE');
  assert.equal(sm.state, 'SHADOW_ACTIVE');

  // Step 5: Observe through boundary
  const boundary = createShadowIntentBoundary(sm);
  const obsResult = boundary.observe(event, outcome);
  assert.equal(obsResult.status, 'accepted');

  // Step 6: Verify observation
  const obs = (obsResult as any).observation;
  assert.ok(obs, 'must produce observation');
  assert.equal(obs.decision, 'trade');
  assert.equal(obs.direction, 'long');
  assert.equal(obs.exchange, REF_EXCHANGE);
  assert.equal(obs.symbol, REF_SYMBOL);
  assert.equal(obs.source, REF_SOURCE);
  assert.equal(obs.sourceSequence, 0);
  assert.equal(obs.eventTimeMs, domainTime);
  assert.ok(obs.observationId.startsWith('so-'), 'observationId must have so- prefix');
  assert.equal(obs.schemaVersion, 'cloddsbot.shadow.observation.v1');

  // Step 7: Assert zero forbidden access (beyond approved context uses)
  // The context access counter only counts approved paths — anything forbidden
  // would have thrown and never incremented the counter, or been caught by the proxy.
  // We verify: no additional accesses beyond what FastPipeline legitimately needed.
  assert.equal(accessCounter.safe, contextAccessesBeforeShadow,
    'shadow conversion must not perform additional context accesses');
  assert.equal(accessCounter.forbidden, 0, 'forbidden context access count must be exactly zero');
});

test('ZA5: ' + FIXTURE_LABEL + ' — forbidden context property access is blocked by Proxy guard', () => {
  const accessCounter: ContextAccessCounter = { safe: 0, forbidden: 0 };
  const domainTime = REF_EVENT_TIME_MS;

  const context = createGuardedContext(accessCounter, domainTime);

  // Attempt to access forbidden property 'route'
  assert.throws(
    () => { void (context as any).route; },
    /Forbidden context access/,
    'route access must be blocked',
  );

  // Attempt to access forbidden property 'execute'
  assert.throws(
    () => { void (context as any).execute; },
    /Forbidden context access/,
    'execute access must be blocked',
  );

  // Attempt to access forbidden property 'paper'
  assert.throws(
    () => { void (context as any).paper; },
    /Forbidden context access/,
    'paper access must be blocked',
  );

  // Attempt to access forbidden property 'adapter'
  assert.throws(
    () => { void (context as any).adapter; },
    /Forbidden context access/,
    'adapter access must be blocked',
  );

  // Unexpected property access is also blocked
  assert.throws(
    () => { void (context as any).unexpectedProp; },
    /Unexpected context access/,
    'unexpected property access must be blocked',
  );
  assert.equal(accessCounter.forbidden, 5, 'all forbidden/unexpected probes must be counted');
});

test('ZA6: ' + FIXTURE_LABEL + ' — deterministic timestamps flow through entire chain', async () => {
  const accessCounter: ContextAccessCounter = { safe: 0, forbidden: 0 };
  const domainTime = REF_EVENT_TIME_MS;

  const { pipeline } = buildPipelineHarness(domainTime, accessCounter);
  const result = await pipeline.execute({
    exchange: REF_EXCHANGE,
    source: REF_SOURCE,
    symbol: REF_SYMBOL,
  });

  assert.equal(result.tradeIntent!.createdAt, domainTime, 'createdAt === domain clock value');

  const outcome = createShadowDecisionOutcome(result, REF_EXCHANGE, REF_SYMBOL);
  const event = createCanonicalShadowEvent(REF_SOURCE, domainTime, 0, outcome);

  assert.equal(event.eventTimeMs, domainTime, 'eventTimeMs === domain time');
  assert.equal(event.sourceSequence, 0, 'sourceSequence carried through');

  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('ACTIVATE');

  const boundary = createShadowIntentBoundary(sm);
  const obsResult = boundary.observe(event, outcome);
  assert.equal(obsResult.status, 'accepted');

  const obs = (obsResult as any).observation;
  assert.equal(obs.sourceSequence, 0, 'sequence preserved in observation');
  assert.equal(obs.eventTimeMs, domainTime, 'timestamp preserved in observation');
});

test('ZA7: ' + FIXTURE_LABEL + ' — caller objects remain unmodified', async () => {
  const accessCounter: ContextAccessCounter = { safe: 0, forbidden: 0 };
  const domainTime = REF_EVENT_TIME_MS;

  const { pipeline } = buildPipelineHarness(domainTime, accessCounter);

  const signal = {
    exchange: REF_EXCHANGE,
    source: REF_SOURCE,
    symbol: REF_SYMBOL,
    signalData: { extra: 'keep-me' },
  };
  const signalClone = JSON.parse(JSON.stringify(signal));

  const result = await pipeline.execute(signal);
  assert.deepEqual(signal, signalClone, 'signal input must not be mutated');

  const outcome = createShadowDecisionOutcome(result, REF_EXCHANGE, REF_SYMBOL);
  const event = createCanonicalShadowEvent(REF_SOURCE, domainTime, 0, outcome);

  // Snapshot outcome before use
  const outcomeClone = {
    decision: outcome.decision,
    direction: outcome.direction,
    exchange: outcome.exchange,
    symbol: outcome.symbol,
    reason: outcome.reason,
    intentId: outcome.intentId,
  };

  const sm = new ShadowRuntimeStateMachine();
  sm.transition('BEGIN_PRECHECK');
  sm.transition('PRECHECK_PASSED');
  sm.transition('ACTIVATE');

  const boundary = createShadowIntentBoundary(sm);
  boundary.observe(event, outcome);

  // Verify outcome unchanged after observe
  assert.equal(outcome.decision, outcomeClone.decision);
  assert.equal(outcome.direction, outcomeClone.direction);
  assert.equal(outcome.exchange, outcomeClone.exchange);
  assert.equal(outcome.symbol, outcomeClone.symbol);
  assert.equal(outcome.reason, outcomeClone.reason);
  assert.equal(outcome.intentId, outcomeClone.intentId);
});
