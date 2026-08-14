// Phase 6A: Runtime Accounting — focused integration + unit tests.
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeRuntimeAccounting } from '../../src/accounting/runtime-accounting';
import type { RuntimeAccountingSnapshot } from '../../src/accounting/runtime-accounting-types';
import { PaperAccountLedger } from '../../src/paper/PaperAccountLedger';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { simulateFill } from '../../src/paper/FillSimulator';
import { validatePaperFill } from '../../src/types/paper-fill';
import type { PaperFill } from '../../src/types/paper-fill';
import type { PaperAccountConfig, PaperAccountSnapshot } from '../../src/types/paper-account';
import type { MarketSnapshot } from '../../src/data/MarketSnapshot';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import { GOLDEN_VECTORS } from './golden-vectors';

const EXCHANGE: ExchangeId = 'bitget';

function makeConfig(accountId: string, initialCashUsd = 100000): PaperAccountConfig {
  return { accountId, exchange: EXCHANGE, initialCashUsd };
}

function makeFill(id: string, side: 'buy' | 'sell', quantity: number, priceUsd: number, opts: { feeUsd?: number; ref?: number; executedAt?: number; symbol?: string; sourceOrderId?: string; sourceIntentId?: string } = {}): PaperFill {
  return {
    fillId: id, exchange: EXCHANGE, symbol: opts.symbol ?? 'BTC/USDT', side, quantity, priceUsd,
    feeUsd: opts.feeUsd ?? 0, executedAt: opts.executedAt ?? 1,
    executionReferencePriceUsd: opts.ref,
    sourceOrderId: opts.sourceOrderId, sourceIntentId: opts.sourceIntentId,
  };
}

function buildAccount(config: PaperAccountConfig, fills: readonly PaperFill[]): { snapshot: PaperAccountSnapshot; fills: readonly PaperFill[] } {
  const ledger = new PaperAccountLedger(config);
  for (const f of fills) ledger.applyFill(f);
  return {
    snapshot: ledger.snapshot(),
    fills: ledger.entries().filter((e) => e.type === 'fill').map((e) => (e as { fill: PaperFill }).fill),
  };
}

function marketSnapshot(symbol: string, last: number, opts: { isStale?: boolean; version?: number; lastUpdatedAt?: number } = {}): MarketSnapshot {
  const ts = opts.lastUpdatedAt ?? 1;
  return {
    exchange: EXCHANGE,
    symbol,
    ticker: { ticker: { exchange: EXCHANGE, instId: symbol, symbol, channel: 'ticker' as const, last, bestBid: last, bestAsk: last, volume24h: 0, high24h: last, low24h: last, ts }, receivedAt: ts },
    klines: {},
    snapshotVersion: opts.version ?? 1,
    generatedAt: ts,
    lastUpdatedAt: ts,
    ageMs: 0,
    isStale: opts.isStale ?? false,
  };
}

function accounting(config: PaperAccountConfig, fills: readonly PaperFill[], markets: readonly MarketSnapshot[], source = 'test'): RuntimeAccountingSnapshot {
  const { snapshot, fills: canonicalFills } = buildAccount(config, fills);
  return computeRuntimeAccounting({ account: snapshot, fills: canonicalFills, markets, capturedAt: 1000, source });
}

function assertApprox(actual: number | null, expected: number, msg: string, eps = 1e-6): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= eps, `${msg}: actual=${actual} expected=${expected}`);
}

describe('Phase 6A — Canonical account facts', () => {
  it('flat fresh account: cash/equity/realized/fees correct', () => {
    const s = accounting(makeConfig('flat'), [], []);
    assert.strictEqual(s.cashUsd, 100000);
    assert.strictEqual(s.realizedPnlUsd, 0);
    assert.strictEqual(s.totalFeesUsd, 0);
    assert.strictEqual(s.valuationStatus, 'COMPLETE');
    assert.strictEqual(s.unrealizedPnlUsd, 0);
    assert.strictEqual(s.equityUsd, 100000);
    assert.strictEqual(s.grossExposureUsd, 0);
    assert.strictEqual(s.netExposureUsd, 0);
  });

  it('durable fields exactly mirror Paper snapshot', () => {
    const config = makeConfig('mirror');
    const { snapshot } = buildAccount(config, [makeFill('f1', 'buy', 2, 100, { feeUsd: 0.5 })]);
    const s = computeRuntimeAccounting({ account: snapshot, fills: [makeFill('f1', 'buy', 2, 100, { feeUsd: 0.5 })], markets: [], capturedAt: 1, source: 't' });
    assert.strictEqual(s.initialCashUsd, snapshot.initialCashUsd);
    assert.strictEqual(s.cashUsd, snapshot.cashUsd);
    assert.strictEqual(s.realizedPnlUsd, snapshot.realizedPnlUsd);
    assert.strictEqual(s.totalFeesUsd, snapshot.totalFeesUsd);
    assert.strictEqual(s.processedFills, snapshot.processedFills);
    assert.strictEqual(s.sourceLedgerSequence, snapshot.sequence);
    assert.strictEqual(s.sourceLedgerUpdatedAt, snapshot.updatedAt);
  });

  it('identity comes from canonical Paper execution identity', () => {
    const s = accounting(makeConfig('acct-9'), [], []);
    assert.strictEqual(s.accountId, 'acct-9');
    assert.strictEqual(s.exchange, 'bitget');
  });

  it('positions deterministically ordered', () => {
    const config = makeConfig('order');
    const fills = [
      makeFill('f1', 'buy', 1, 100, { symbol: 'ETH/USDT' }),
      makeFill('f2', 'buy', 1, 100, { symbol: 'BTC/USDT' }),
    ];
    const s = accounting(config, fills, [marketSnapshot('BTC/USDT', 100), marketSnapshot('ETH/USDT', 100)]);
    assert.deepStrictEqual(s.positions.map((p) => p.symbol), ['BTC/USDT', 'ETH/USDT'], 'sorted by exchange:symbol');
  });

  it('returned snapshot cannot mutate source state', () => {
    const config = makeConfig('immut');
    const fills = [makeFill('f1', 'buy', 1, 100)];
    const { snapshot } = buildAccount(config, fills);
    const before = JSON.stringify(snapshot);
    const s = computeRuntimeAccounting({ account: snapshot, fills, markets: [marketSnapshot('BTC/USDT', 100)], capturedAt: 1, source: 't' });
    assert.ok(Object.isFrozen(s), 'accounting snapshot frozen');
    assert.ok(Object.isFrozen(s.positions), 'positions array frozen');
    assert.ok(Object.isFrozen(s.positions[0]), 'position object frozen');
    assert.strictEqual(JSON.stringify(snapshot), before, 'source snapshot unchanged');
    assert.strictEqual(s.cashUsd, snapshot.cashUsd, 'accounting reflects source (no drift)');
  });
});

describe('Phase 6A — Long valuation', () => {
  const config = makeConfig('long');
  const openLong = [makeFill('f1', 'buy', 2, 100)];

  it('long mark above average entry → positive unrealized', () => {
    const s = accounting(config, openLong, [marketSnapshot('BTC/USDT', 120)]);
    assert.strictEqual(s.valuationStatus, 'COMPLETE');
    assertApprox(s.unrealizedPnlUsd, 40, 'unrealized');
    assertApprox(s.positions[0].unrealizedPnlUsd, 40, 'per-position unrealized');
  });

  it('long mark below average entry → negative unrealized', () => {
    const s = accounting(config, openLong, [marketSnapshot('BTC/USDT', 90)]);
    assertApprox(s.unrealizedPnlUsd, -20, 'unrealized');
  });

  it('market value / net exposure / equity reconcile', () => {
    const s = accounting(config, openLong, [marketSnapshot('BTC/USDT', 120)]);
    assertApprox(s.positions[0].marketValueUsd, 240, 'market value 2*120');
    assertApprox(s.netExposureUsd, 240, 'net exposure');
    assertApprox(s.equityUsd, s.cashUsd! + 240, 'equity = cash + net');
  });
});

describe('Phase 6A — Short valuation', () => {
  const config = makeConfig('short');
  const openShort = [makeFill('f1', 'sell', 2, 100)];

  it('short mark below average entry → positive unrealized', () => {
    const s = accounting(config, openShort, [marketSnapshot('BTC/USDT', 80)]);
    assert.strictEqual(s.valuationStatus, 'COMPLETE');
    assertApprox(s.unrealizedPnlUsd, 40, 'unrealized (short profit when price drops)');
  });

  it('short mark above average entry → negative unrealized', () => {
    const s = accounting(config, openShort, [marketSnapshot('BTC/USDT', 120)]);
    assertApprox(s.unrealizedPnlUsd, -40, 'unrealized (short loss when price rises)');
  });

  it('signed net exposure correct (negative for short)', () => {
    const s = accounting(config, openShort, [marketSnapshot('BTC/USDT', 80)]);
    assertApprox(s.positions[0].marketValueUsd, -160, 'market value 2*(-80) signed');
    assertApprox(s.netExposureUsd, -160, 'net exposure signed');
  });
});

describe('Phase 6A — Multi position', () => {
  const config = makeConfig('multi');
  const fills = [
    makeFill('f1', 'buy', 2, 100, { symbol: 'BTC/USDT' }),
    makeFill('f2', 'sell', 1, 50, { symbol: 'ETH/USDT' }),
  ];
  const markets = [marketSnapshot('BTC/USDT', 110), marketSnapshot('ETH/USDT', 40)];

  it('aggregate unrealized = sum(position unrealized)', () => {
    const s = accounting(config, fills, markets);
    // BTC long: (110-100)*2 = 20. ETH short: (50-40)*1 = 10.
    const sum = s.positions.reduce((acc, p) => acc + (p.unrealizedPnlUsd ?? 0), 0);
    assertApprox(s.unrealizedPnlUsd, sum, 'aggregate = sum');
    assertApprox(s.unrealizedPnlUsd, 30, 'total unrealized 20 + 10');
  });

  it('gross exposure = sum(abs(position market value))', () => {
    const s = accounting(config, fills, markets);
    // BTC: 2*110=220. ETH short: 1*(-40)=-40, abs 40.
    assertApprox(s.grossExposureUsd, 260, 'gross 220 + 40');
  });

  it('net exposure = sum(signed position market value)', () => {
    const s = accounting(config, fills, markets);
    assertApprox(s.netExposureUsd, 180, 'net 220 - 40');
  });

  it('equity = cash + net exposure', () => {
    const s = accounting(config, fills, markets);
    assertApprox(s.equityUsd, s.cashUsd! + (s.netExposureUsd ?? 0), 'equity = cash + net');
  });

  it('equity reconciles with Paper accounting invariant', () => {
    const s = accounting(config, fills, markets);
    // equity = initialCash + realized + unrealized
    assertApprox(s.equityUsd, s.initialCashUsd + s.realizedPnlUsd + (s.unrealizedPnlUsd ?? 0), 'equity invariant');
  });
});

describe('Phase 6A — Market completeness', () => {
  const config = makeConfig('mk');
  const openLong = [makeFill('f1', 'buy', 2, 100)];

  it('open position + missing market → INCOMPLETE, no false numeric aggregate', () => {
    const s = accounting(config, openLong, []);
    assert.strictEqual(s.valuationStatus, 'INCOMPLETE');
    assert.strictEqual(s.unrealizedPnlUsd, null);
    assert.strictEqual(s.equityUsd, null);
    assert.strictEqual(s.grossExposureUsd, null);
    assert.strictEqual(s.netExposureUsd, null);
    assert.strictEqual(s.positions[0].markPriceUsd, null);
    assert.strictEqual(s.positions[0].unrealizedPnlUsd, null);
  });

  it('open position + stale market → INCOMPLETE', () => {
    const s = accounting(config, openLong, [marketSnapshot('BTC/USDT', 120, { isStale: true })]);
    assert.strictEqual(s.valuationStatus, 'INCOMPLETE');
    assert.strictEqual(s.unrealizedPnlUsd, null);
  });

  it('invalid/nonpositive mark cannot become valid valuation', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const s = accounting(config, openLong, [marketSnapshot('BTC/USDT', bad)]);
      assert.strictEqual(s.valuationStatus, 'INCOMPLETE', `mark=${bad}`);
      assert.strictEqual(s.unrealizedPnlUsd, null);
    }
  });

  it('flat account requires no ticker and remains COMPLETE', () => {
    const s = accounting(makeConfig('flat2'), [], []);
    assert.strictEqual(s.valuationStatus, 'COMPLETE');
    assert.strictEqual(s.unrealizedPnlUsd, 0);
    assert.strictEqual(s.equityUsd, 100000);
  });
});

describe('Phase 6A — Execution reference persistence', () => {
  it('new simulated fill persists execution reference price', () => {
    const intent = { intentId: 'i1', exchange: 'bitget' as ExchangeId, symbol: 'BTC/USDT', direction: 'long' as const, orderType: 'market' as const, positionUsd: 10000, source: 'test', createdAt: 0, reason: 'r', biasUpdatedAt: 0 };
    const result = simulateFill(intent as any, { markPriceUsd: 100, feeBps: 10, slippageBps: 5, executedAtMs: 1000 }, 1);
    assert.strictEqual(result.fill.executionReferencePriceUsd, 100, 'reference = markPriceUsd');
    assert.ok(result.fill.priceUsd > 100, 'buy executed above reference (adverse slippage)');
  });

  it('Paper persistence reload preserves reference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p6a-ref-'));
    const config = makeConfig('ref');
    const store = new PaperLedgerStore(config, { baseDir: dir });
    const ledger = new PaperAccountLedger(config);
    ledger.applyFill(makeFill('f1', 'buy', 2, 100.05, { ref: 100, feeUsd: 0.1 }));
    await store.save(ledger);

    const reloaded = await store.load();
    assert.ok(reloaded, 'reloaded');
    const f = reloaded!.entries().find((e) => e.type === 'fill') as { fill: PaperFill };
    assert.strictEqual(f.fill.executionReferencePriceUsd, 100, 'reference survives reload');
    rmSync(dir, { recursive: true, force: true });
  });

  it('legacy/generic fill without reference remains loadable', () => {
    const legacy = makeFill('f-legacy', 'buy', 1, 100, {}); // no ref
    assert.doesNotThrow(() => validatePaperFill(legacy));
    const config = makeConfig('legacy');
    const { snapshot } = buildAccount(config, [legacy]);
    assert.strictEqual(snapshot.processedFills, 1, 'legacy fill applied');
  });
});

describe('Phase 6A — Slippage', () => {
  const config = makeConfig('slip');

  it('buy observed slippage from reference vs actual fill', () => {
    const s = accounting(config, [makeFill('f1', 'buy', 2, 100.10, { ref: 100 })], []);
    assert.strictEqual(s.slippage.status, 'COMPLETE');
    assertApprox(s.slippage.totalObservedSlippageUsd, 0.20, 'buy slippage (100.10-100)*2');
    assertApprox(s.slippage.attributedFills[0].observedSlippageUsd, 0.20, 'per-fill slippage');
  });

  it('sell observed slippage from reference vs actual fill', () => {
    const s = accounting(config, [makeFill('f1', 'sell', 2, 99.90, { ref: 100 })], []);
    assertApprox(s.slippage.totalObservedSlippageUsd, 0.20, 'sell slippage (100-99.90)*2');
  });

  it('aggregate observed slippage correct when all fills attributed', () => {
    const fills = [
      makeFill('f1', 'buy', 2, 100.10, { ref: 100, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 119.80, { ref: 120, executedAt: 2 }),
    ];
    const s = accounting(config, fills, []);
    assert.strictEqual(s.slippage.status, 'COMPLETE');
    assertApprox(s.slippage.totalObservedSlippageUsd, 0.60, '0.20 + 0.40');
  });

  it('one legacy/unattributed fill → INCOMPLETE, missing cost never zero', () => {
    const fills = [
      makeFill('f1', 'buy', 2, 100.10, { ref: 100, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 119.80, { executedAt: 2 }), // no ref
    ];
    const s = accounting(config, fills, []);
    assert.strictEqual(s.slippage.status, 'INCOMPLETE');
    assert.strictEqual(s.slippage.totalObservedSlippageUsd, null, 'total not fabricated');
    assert.strictEqual(s.slippage.unattributedFillCount, 1);
    assertApprox(s.slippage.partialObservedSlippageUsd, 0.20, 'partial subtotal only');
  });
});

describe('Phase 6A — Fees', () => {
  it('aggregated factual fill fees equal Paper snapshot totalFeesUsd', () => {
    const config = makeConfig('fees');
    const fills = [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.2, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.22, executedAt: 2 }),
    ];
    const s = accounting(config, fills, []);
    assert.strictEqual(s.fees.reconciled, true);
    assertApprox(s.fees.summedFillFeesUsd, s.fees.totalFeesUsd, 'summed == total');
    assertApprox(s.fees.totalFeesUsd, 0.42, 'total fees 0.2 + 0.22');
  });

  it('entry + exit fee sequence does not double count', () => {
    const config = makeConfig('fees2');
    const fills = [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.2, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.22, executedAt: 2 }),
    ];
    const { snapshot } = buildAccount(config, fills);
    // totalFeesUsd is the sum of both fills exactly once (no double count)
    assertApprox(snapshot.totalFeesUsd, 0.42, 'totalFeesUsd = entry fee + exit fee, once');
    const s = computeRuntimeAccounting({ account: snapshot, fills, markets: [], capturedAt: 1, source: 't' });
    assert.strictEqual(s.fees.reconciled, true);
    assertApprox(s.fees.summedFillFeesUsd, snapshot.totalFeesUsd, 'summed matches snapshot exactly');
  });
});

describe('Phase 6A — Python golden oracle', () => {
  for (const vector of GOLDEN_VECTORS) {
    it(`golden: ${vector.name}`, () => {
      const config = makeConfig('golden', vector.initialCashUsd);
      const { snapshot, fills } = buildAccount(config, vector.fills);
      const s = computeRuntimeAccounting({ account: snapshot, fills, markets: [], capturedAt: 1, source: 'golden' });
      assertApprox(s.realizedPnlUsd, vector.expected.realizedPnlUsd, 'realized PnL');
      assertApprox(s.cashUsd, vector.expected.cashUsd, 'cash');
      assertApprox(s.totalFeesUsd, vector.expected.totalFeesUsd, 'fees');
      assert.strictEqual(s.slippage.status, 'COMPLETE');
      assertApprox(s.slippage.totalObservedSlippageUsd, vector.expected.totalObservedSlippageUsd, 'observed slippage');
      // Round trip → flat at end.
      assert.strictEqual(s.valuationStatus, 'COMPLETE');
      assertApprox(s.unrealizedPnlUsd, 0, 'flat → unrealized 0');
      assertApprox(s.equityUsd, vector.expected.cashUsd, 'equity = cash (flat)');
    });
  }
});

describe('Phase 6A — Restart + side effects (ProductionSpine)', () => {
  it('RUN1 persisted execution → RUN2 reload → durable facts identical; valuation incomplete then complete; zero writes', async () => {
    const { createProductionSpine, executeThroughGateway, trustBaseline, recoverAndStart, reconcileRecoveredState, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    const { createMarketDataRuntime } = require('../../src/runtime/market/MarketDataRuntime');

    const dir = mkdtempSync(join(tmpdir(), 'p6a-restart-'));
    const journalPath = join(dir, 'journal.jsonl');
    const cfg = { accountId: 'restart', exchange: 'bitget' as ExchangeId, initialCashUsd: 100000 };
    const paperStore = new PaperLedgerStore(cfg, { baseDir: join(dir, 'paper') });
    let saves = 0;
    const counting = {
      load: () => paperStore.load(),
      save: async (ledger: any) => { saves++; return paperStore.save(ledger); },
    };

    const hardRisk = () => ({ exchange: 'bitget', locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity });
    function collector() { let h: any = null; return { start: async () => {}, stop: () => {}, onTicker: (x: any) => { h = x; }, onKline: () => {}, emit: (t: any) => h?.(t) }; }
    function ticker(symbol: string, last: number) { return { exchange: 'bitget', instId: symbol, symbol, channel: 'ticker', last, bestBid: last, bestAsk: last, volume24h: 1, high24h: last, low24h: last, ts: Date.now() }; }
    function intent(id: string) { return { intentId: id, exchange: 'bitget' as ExchangeId, symbol: 'BTC/USDT', direction: 'long' as const, orderType: 'market' as const, positionUsd: 5000, limitPrice: undefined, createdAt: Date.now() }; }

    async function makeSpine(accountId: string) {
      const c = collector();
      const marketRuntime = createMarketDataRuntime({ collectorFactory: () => c });
      const spine = await createProductionSpine({ exchange: 'bitget', accountId, hardRisk, journalPath, paperAccount: cfg, persistence: counting, policyMaxLifetimeMs: 3600_000, marketRuntime });
      await marketRuntime.start();
      return { spine, emit: (t: any) => c.emit(t) };
    }

    // ── RUN 1: execute a fill, persist ──
    const r1 = await makeSpine('restart');
    r1.spine.protection.start();
    r1.spine.planStore.subscribeToKernel(r1.spine.kernel as any);
    await recoverAndStart(r1.spine, journalPath);
    await reconcileRecoveredState(r1.spine);
    r1.emit(ticker('BTC/USDT', 100));
    await activateLiveReadiness(r1.spine);
    trustBaseline(r1.spine, 'bitget', 'BTC/USDT');
    const now = Date.now();
    r1.spine.kernel.publish('policy.snapshot.published', { policy: { exchange: 'bitget', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: '1', compiledAt: now, effectiveAt: now, expiresAt: now + 3600_000, allowNewEntries: true, allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [], maxPositionMultiplier: 1, riskLevel: 'low', directionBias: 'neutral', symbolRules: {}, reasonCodes: [] } });
    await executeThroughGateway(r1.spine, intent('i-restart') as any, 'open', 5000);
    await new Promise((r) => setTimeout(r, 200));

    const run1Accounting = r1.spine.accounting.snapshot();
    assert.strictEqual(run1Accounting.processedFills, 1, 'one fill in RUN1');

    // ── RUN 2: reload same persistence ──
    saves = 0;
    const r2 = await makeSpine('restart');
    // Before any market mark: open position → INCOMPLETE.
    const beforeMarket = r2.spine.accounting.snapshot();
    assert.strictEqual(beforeMarket.processedFills, run1Accounting.processedFills, 'fill count identical');
    assert.strictEqual(beforeMarket.cashUsd, run1Accounting.cashUsd, 'cash identical');
    assert.strictEqual(beforeMarket.realizedPnlUsd, run1Accounting.realizedPnlUsd, 'realized identical');
    assert.strictEqual(beforeMarket.totalFeesUsd, run1Accounting.totalFeesUsd, 'fees identical');
    assert.strictEqual(beforeMarket.openPositions, run1Accounting.openPositions, 'open positions identical');
    assert.strictEqual(beforeMarket.valuationStatus, 'INCOMPLETE', 'open + no market → INCOMPLETE');
    assert.strictEqual(beforeMarket.unrealizedPnlUsd, null);

    // After valid current market mark: COMPLETE.
    r2.emit(ticker('BTC/USDT', 110));
    await new Promise((r) => setTimeout(r, 50));
    const afterMarket = r2.spine.accounting.snapshot();
    assert.strictEqual(afterMarket.valuationStatus, 'COMPLETE');
    assert.ok(afterMarket.unrealizedPnlUsd !== null && afterMarket.unrealizedPnlUsd > 0, 'positive unrealized after mark up');

    // zero persistence saves / OMS execution during accounting reads.
    assert.strictEqual(saves, 0, 'zero Paper persistence writes during accounting reads');
    assert.strictEqual(r2.spine.service.entries().filter((e: any) => e.type === 'fill').length, 1, 'zero new fills');

    rmSync(dir, { recursive: true, force: true });
  });
});
