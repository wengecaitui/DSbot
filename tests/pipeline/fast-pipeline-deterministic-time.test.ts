/**
 * Stage 4B4.1: FastPipeline deterministic time tests (TDD).
 *
 * Tests that FastPipeline uses injected Clock/ElapsedClock instead of Date.now,
 * validates domain time monotonicity, and produces deterministic createdAt + intentId
 * for identical inputs at the same domain time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IndicatorResult } from '../../src/types/indicators';
import type { DomainClock, ElapsedClock } from '../../src/runtime/Clock';
import { FastPipeline } from '../../src/pipeline/FastPipeline';

// ─── Helpers ────────────────────────────────────────────────────────────────

const BULLISH_LONG_INDICATORS: IndicatorResult[] = [
  { name: 'CompositeMomentum', status: 'done', composite_score: 88, regime_state: 'STRONG_BULLISH', in_cooldown: false, dimension_scores: { hull_big_trend: { score: 80 }, stc_momentum: { score: 85 }, volume_micro: { score: 90 } }, lag_bars: 0 } as any,
  { name: 'SmartOrderBlock', status: 'done', has_active_ob: true, ob_strength_weight: 0.7, lag_bars: 0 } as any,
];

class FakeIndicatorService {
  results: IndicatorResult[] = BULLISH_LONG_INDICATORS;
  calculateAllCalled = 0;
  async calculateAll(_: any): Promise<IndicatorResult[]> { this.calculateAllCalled += 1; return this.results; }
}

class FakeKillSwitch {
  private locked: boolean = false;
  private lockReason: string | null = null;
  private config = { totalCapitalUsd: 10000 };

  lock(reason: string) { this.locked = true; this.lockReason = reason; }
  getLockState(_exchange: string) {
    return this.locked ? { locked: true, reason: this.lockReason ?? 'locked' } : { locked: false };
  }
  getConfig() { return { ...this.config }; }
  check(_exchange: string, _symbol: string, _positionUsd: number) {
    if (this.locked) return { allowed: false, reason: this.lockReason ?? 'locked' };
    return { allowed: true };
  }
}

function makeBiasReport(symbol = 'BTCUSDT', updatedAt: number = Date.now()) {
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

// ─── Fake clocks ────────────────────────────────────────────────────────────

class TestDomainClock implements DomainClock {
  calls: number[] = [];
  private value: number;

  constructor(value: number) { this.value = value; }

  now(): number { this.calls.push(this.value); return this.value; }

  set(v: number) { this.value = v; }
  get callCount(): number { return this.calls.length; }
}

/**
 * TestElapsedClock that returns a configurable sequence of values.
 * Each call to now() consumes the next value. If the sequence is exhausted,
 * it returns the last value repeatedly.
 */
class TestElapsedClock implements ElapsedClock {
  calls: number[] = [];
  private values: number[];
  private index: number = 0;

  constructor(values: number[]) {
    this.values = values.length > 0 ? values : [0];
  }

  now(): number {
    const v = this.values[Math.min(this.index, this.values.length - 1)];
    this.calls.push(v);
    this.index += 1;
    return v;
  }

  get callCount(): number { return this.calls.length; }
}

// Default elapsed clock: returns 100 then 145 (start → end, 45ms elapsed)
function defaultElapsed(): TestElapsedClock {
  return new TestElapsedClock([100, 145]);
}

function buildHarness(opts: {
  domainTime?: number;
  elapsedClock?: TestElapsedClock;
  report?: any;
  indicators?: IndicatorResult[];
  lockKs?: boolean;
} = {}): { pipeline: FastPipeline; domainClock: TestDomainClock; elapsedClock: TestElapsedClock } {
  const domainTime = opts.domainTime ?? 1700000000000;
  const domainClock = new TestDomainClock(domainTime);
  const elapsedClock = opts.elapsedClock ?? defaultElapsed();
  const ind = new FakeIndicatorService();
  if (opts.indicators) ind.results = opts.indicators;
  // Generate report tied to domainTime so it's not in the future
  const defaultReport = makeBiasReport('BTCUSDT', domainTime);
  const report = 'report' in opts ? opts.report : defaultReport;
  const ks = new FakeKillSwitch();
  if (opts.lockKs) ks.lock('test lock');
  const router: any = {
    exchange: 'bitget',
    getBiasReport: () => report,
    getConfig: () => ({ maxBiasReportAgeHours: 2, fastPathTimeoutSec: 1.5, killSwitch: {}, writeActionTimeoutSec: 1.5 }),
    killSwitch: ks,
  };
  const pipeline = new FastPipeline({
    exchange: 'bitget',
    router,
    indicatorService: ind as any,
    clock: domainClock,
    elapsedClock,
  });
  return { pipeline, domainClock, elapsedClock };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('DT1: constructor consumes neither clock — no clock calls at construction', () => {
  const dc = new TestDomainClock(1700000000000);
  const ec = defaultElapsed();
  new FastPipeline({
    exchange: 'bitget',
    router: { exchange: 'bitget', getBiasReport: () => null, getConfig: () => ({ maxBiasReportAgeHours: 2 }) } as any,
    indicatorService: new FakeIndicatorService() as any,
    clock: dc,
    elapsedClock: ec,
  });
  assert.equal(dc.callCount, 0, 'domain clock must NOT be read at construction');
  assert.equal(ec.callCount, 0, 'elapsed clock must NOT be read at construction');
});

test('DT2: domain clock read exactly once per execute — early-skip path', async () => {
  const h = buildHarness({ report: null });
  await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(h.domainClock.callCount, 1, 'domain clock read exactly once on early-skip path');
});

test('DT3: domain clock read exactly once per execute — trade-producing path', async () => {
  const h = buildHarness();
  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(h.domainClock.callCount, 1, 'domain clock read exactly once on trade path');
  assert.equal(r.decision, 'trade');
});

test('DT4: non-finite domain time rejects before reading bias report', async () => {
  const h = buildHarness({ domainTime: NaN });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /domain time/,
  );
  assert.equal(h.domainClock.callCount, 1, 'domain clock read once then rejected');
});

test('DT5: negative domain time rejects before decision reads', async () => {
  const h = buildHarness({ domainTime: -1 });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /domain time/,
  );
});

test('DT6: non-safe-integer domain time rejects', async () => {
  const h = buildHarness({ domainTime: Number.MAX_SAFE_INTEGER + 1 });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /domain time/,
  );
});

test('DT7: decreasing domain time across calls rejects', async () => {
  const h = buildHarness({ report: null, domainTime: 1700000000000 });
  // First call at T0 — should succeed (null report → skip)
  await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  // Move clock backward
  h.domainClock.set(1699999999999);
  // Second call should reject
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /decreased|decreasing|monotonic|backward/i,
  );
});

test('DT8: equal domain timestamps are accepted', async () => {
  const h = buildHarness({ report: null, domainTime: 1700000000000 });
  await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  // Same timestamp again — should be accepted
  await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(h.domainClock.callCount, 2, 'two calls, one domain read each');
});

test('DT9: elapsed clock is separate — valid result is end minus start', async () => {
  // Elapsed clock returns [100, 145] → start=100, end=145, elapsed=45
  const ec = new TestElapsedClock([100, 145]);
  const h = buildHarness({ elapsedClock: ec });
  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'trade');
  assert.equal(r.elapsedMs, 45, 'elapsed = end - start = 145 - 100 = 45');
});

test('DT10: non-finite elapsed end rejects', async () => {
  // elapsed start=100, end=NaN
  const ec = new TestElapsedClock([100, NaN]);
  const h = buildHarness({ elapsedClock: ec });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed/,
  );
});

test('DT11: negative elapsed end rejects', async () => {
  const ec = new TestElapsedClock([100, -50]);
  const h = buildHarness({ elapsedClock: ec });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed/,
  );
});

test('DT12: backward elapsed (end < start) rejects', async () => {
  const ec = new TestElapsedClock([100, 99]);
  const h = buildHarness({ elapsedClock: ec });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed/,
  );
});

test('DT13: future bias report produces fail-closed defense and no TradeIntent', async () => {
  const domainTime = 1700000000000;
  const futureReport = makeBiasReport('BTCUSDT', domainTime + 3600_000); // 1h in future
  const h = buildHarness({ domainTime, report: futureReport });
  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense', 'future report should trigger defense');
  assert.equal(r.tradeIntent, undefined, 'no TradeIntent for future report');
  assert.ok(r.reason.includes('future'), 'reason should mention future timestamp');
});

test('DT14: deterministic identical valid trade inputs + same domain time yield identical createdAt and intentId', async () => {
  const domainTime = 1700000000000;
  const report = makeBiasReport('BTCUSDT', domainTime);

  // First execution — elapsed [100, 145]
  const h1 = buildHarness({ domainTime, report, elapsedClock: new TestElapsedClock([100, 145]) });
  const r1 = await h1.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });

  // Second execution — identical inputs, different elapsed [200, 245]
  const h2 = buildHarness({ domainTime, report, elapsedClock: new TestElapsedClock([200, 245]) });
  const r2 = await h2.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });

  assert.ok(r1.tradeIntent, 'first execution should produce TradeIntent');
  assert.ok(r2.tradeIntent, 'second execution should produce TradeIntent');
  assert.equal(r1.tradeIntent!.createdAt, domainTime, 'createdAt equals domain time');
  assert.equal(r2.tradeIntent!.createdAt, domainTime, 'createdAt equals domain time');
  assert.equal(r1.tradeIntent!.intentId, r2.tradeIntent!.intentId, 'intentId must be identical for identical inputs at same domain time');
  assert.equal(r1.tradeIntent!.createdAt, r2.tradeIntent!.createdAt, 'createdAt must be identical');
});

test('DT15: TradeIntent createdAt equals captured domain time', async () => {
  const domainTime = 1700000000000;
  const h = buildHarness({ domainTime });
  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.ok(r.tradeIntent, 'should produce TradeIntent');
  assert.equal(r.tradeIntent!.createdAt, domainTime, 'createdAt must equal the domain time passed to clock');
});

test('DT16: elapsed result is never negative (end == start → 0ms)', async () => {
  // Elapsed clock returns same value for start and end
  const ec = new TestElapsedClock([100, 100]);
  const h = buildHarness({ elapsedClock: ec });
  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.ok(r.elapsedMs >= 0, 'elapsedMs must be non-negative');
  assert.equal(r.elapsedMs, 0, 'end == start → elapsedMs = 0');
});

test('DT17: signal input is not mutated by execute', async () => {
  const h = buildHarness();
  const signal = { exchange: 'bitget' as const, source: 'spread', symbol: 'BTCUSDT', signalData: { foo: 'bar' } };
  const clone = JSON.parse(JSON.stringify(signal));
  await h.pipeline.execute(signal);
  assert.deepEqual(signal, clone, 'signal must not be mutated by execute');
});

test('DT18: early-skip path reads elapsed start + elapsed end → 2 reads total', async () => {
  // null report → early skip. Elapsed returns start=100, end=120
  const ec = new TestElapsedClock([100, 120]);
  const h = buildHarness({ report: null, elapsedClock: ec });
  await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  // 1 start read + 1 end read = 2
  assert.equal(ec.callCount, 2, 'elapsed clock read for start + end');
});

test('DT19: caller-replaced clock after construction uses the new clock', async () => {
  const domainTime = 1700000000000;
  const h = buildHarness({ domainTime });
  // Replace the clock after construction
  const newDc = new TestDomainClock(1700000001000);
  (h.pipeline as any).clock = newDc;

  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  // Should use the new clock's value
  assert.equal(newDc.callCount, 1, 'new clock should be read');
  assert.ok(r.tradeIntent, 'should produce TradeIntent');
  assert.equal(r.tradeIntent!.createdAt, 1700000001000, 'createdAt should use new clock value');
});

// ─── Elapsed START validation (DT20-DT22) ──────────────────────────────────

test('DT20: NaN elapsed START tick rejects before any decision work', async () => {
  // elapsed start=NaN → should throw before getBiasReport / any skip-check
  const ec = new TestElapsedClock([NaN, 200]);
  const h = buildHarness({ elapsedClock: ec });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed start tick invalid/,
  );
});

test('DT21: Infinity elapsed START tick rejects before any decision work', async () => {
  const ec = new TestElapsedClock([Infinity, 200]);
  const h = buildHarness({ elapsedClock: ec });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed start tick invalid/,
  );
});

test('DT22: negative elapsed START tick rejects before any decision work', async () => {
  const ec = new TestElapsedClock([-1, 200]);
  const h = buildHarness({ elapsedClock: ec });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed start tick invalid/,
  );
});

// ─── Elapsed START rejection does NOT advance accepted-domain state ─────────

test('DT23: NaN elapsed start rejection does not advance accepted-domain — lower domain time still accepted', async () => {
  const domainTime = 1700000000000;
  const report = makeBiasReport('BTCUSDT', domainTime);

  // First call: NaN elapsed start → rejected, domain state must NOT advance
  const ec1 = new TestElapsedClock([NaN]);
  const h = buildHarness({ domainTime, report, elapsedClock: ec1 });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed start tick invalid/,
  );

  // A lower timestamp proves the failed call did not advance accepted-domain state.
  h.domainClock.set(domainTime - 1);
  const ec2 = new TestElapsedClock([100, 145]);
  (h.pipeline as any).elapsedClock = ec2;
  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense', 'lower domain time remains admissible after rejected start');
  assert.match(r.reason, /future relative to domain time/);
});

test('DT24: negative elapsed start rejection does not advance accepted-domain — lower domain time still accepted', async () => {
  const domainTime = 1700000000000;
  const report = makeBiasReport('BTCUSDT', domainTime);

  // First call: negative elapsed start → rejected
  const ec1 = new TestElapsedClock([-50]);
  const h = buildHarness({ domainTime, report, elapsedClock: ec1 });
  await assert.rejects(
    () => h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' }),
    /elapsed start tick invalid/,
  );

  // A lower timestamp proves the failed call did not advance accepted-domain state.
  h.domainClock.set(domainTime - 1);
  const ec2 = new TestElapsedClock([100, 145]);
  (h.pipeline as any).elapsedClock = ec2;
  const r = await h.pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense', 'lower domain time remains admissible after rejected start');
  assert.match(r.reason, /future relative to domain time/);
});
