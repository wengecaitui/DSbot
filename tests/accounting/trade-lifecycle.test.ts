// Phase 6B: Trade Lifecycle — factual lifecycle projection over durable Paper fills.
//
// Pure, deterministic projection: input is the durable Paper ledger snapshot plus
// the durable fill entries (ordered by ledger sequence). Output is a read-only
// decomposition of completed round-trip trades + deterministic open residuals.
//
// Reconciliation contract:
//   realizedPnlUsd  === account.realizedPnlUsd
//   totalFeesUsd    === account.totalFeesUsd
//   realizedPnlUsd  === grossPnlUsd - totalFeesUsd        (always)
//   sum(trade.feeUsd) + sum(open.deferredFeeUsd) === totalFeesUsd
//
// Excluded by design (NOT part of this projection): MFE/MAE/R, drawdown,
// and plan/strategy attribution.

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeTradeLifecycle } from '../../src/accounting/trade-lifecycle';
import type { TradeLifecycle, ClosedTrade, OpenPosition } from '../../src/accounting/trade-lifecycle-types';
import { PaperAccountLedger } from '../../src/paper/PaperAccountLedger';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import type { PaperAccountConfig, PaperAccountSnapshot, PaperFillLedgerEntry } from '../../src/types/paper-account';
import type { PaperFill } from '../../src/types/paper-fill';
import type { ExchangeId } from '../../src/data/MarketIdentity';

const EXCHANGE: ExchangeId = 'bitget';

function makeConfig(accountId: string, initialCashUsd = 100000): PaperAccountConfig {
  return { accountId, exchange: EXCHANGE, initialCashUsd };
}

function makeFill(id: string, side: 'buy' | 'sell', quantity: number, priceUsd: number, opts: { feeUsd?: number; executedAt?: number; symbol?: string } = {}): PaperFill {
  return {
    fillId: id, exchange: EXCHANGE, symbol: opts.symbol ?? 'BTC/USDT', side, quantity, priceUsd,
    feeUsd: opts.feeUsd ?? 0, executedAt: opts.executedAt ?? 1,
  };
}

function buildLedger(config: PaperAccountConfig, fills: readonly PaperFill[]): { account: PaperAccountSnapshot; fills: readonly PaperFillLedgerEntry[] } {
  const ledger = new PaperAccountLedger(config);
  for (const f of fills) ledger.applyFill(f);
  return {
    account: ledger.snapshot(),
    fills: ledger.entries().filter((e) => e.type === 'fill') as PaperFillLedgerEntry[],
  };
}

function lifecycle(config: PaperAccountConfig, fills: readonly PaperFill[]): TradeLifecycle {
  const { account, fills: entries } = buildLedger(config, fills);
  return computeTradeLifecycle({ account, fills: entries });
}

function assertApprox(actual: number, expected: number, msg: string, eps = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: actual=${actual} expected=${expected}`);
}

describe('Phase 6B — flat-open', () => {
  it('open from flat produces zero trades and one deterministic residual position', () => {
    const s = lifecycle(makeConfig('flat-open'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.40, executedAt: 100 }),
    ]);

    assert.strictEqual(s.trades.length, 0, 'no completed trade');
    assert.strictEqual(s.openPositions.length, 1, 'one open residual');
    const p = s.openPositions[0];
    assert.strictEqual(p.side, 'long');
    assert.strictEqual(p.signedQuantity, 2);
    assert.strictEqual(p.averageEntryPriceUsd, 100);
    assert.strictEqual(p.deferredFeeUsd, 0.40, 'entry fee deferred to open residual');
    assert.strictEqual(p.openedAt, 100);

    assert.strictEqual(s.grossPnlUsd, 0);
    assert.strictEqual(s.totalFeesUsd, 0.40);
    assert.strictEqual(s.realizedPnlUsd, -0.40, 'realized = gross - totalFees (entry fee already charged)');
    assert.strictEqual(s.netPnlUsd, 0);
    assert.strictEqual(s.profitFactor, null, 'no closed trades → null');
  });
});

describe('Phase 6B — scale-in then exact close', () => {
  it('averages entry across scale-in and realizes net after fees', () => {
    const s = lifecycle(makeConfig('scale-in'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'buy', 1, 130, { feeUsd: 0.10, executedAt: 2 }),
      makeFill('f3', 'sell', 3, 120, { feeUsd: 0.30, executedAt: 3 }),
    ]);

    assert.strictEqual(s.trades.length, 1);
    assert.strictEqual(s.openPositions.length, 0, 'flat after exact close');

    const t = s.trades[0];
    assert.strictEqual(t.side, 'long');
    assert.strictEqual(t.closedQuantity, 3);
    assert.strictEqual(t.averageEntryPriceUsd, 110, '(2*100 + 1*130)/3');
    assert.strictEqual(t.averageExitPriceUsd, 120);
    assert.strictEqual(t.grossPnlUsd, 30, '(120 - 110) * 3');
    assert.strictEqual(t.feeUsd, 0.60, 'entry 0.20 + entry 0.10 + exit 0.30');
    assert.strictEqual(t.netPnlUsd, 29.40);
    assert.strictEqual(t.openedAt, 1);
    assert.strictEqual(t.closedAt, 3);
    assert.strictEqual(t.holdingDurationMs, 2);

    assert.strictEqual(s.grossPnlUsd, 30);
    assert.strictEqual(s.totalFeesUsd, 0.60);
    assert.strictEqual(s.realizedPnlUsd, 29.40);
    assert.strictEqual(s.netPnlUsd, 29.40);
  });
});

describe('Phase 6B — partial close then exact close', () => {
  it('splits entry fees proportionally across multiple exits and reconciles', () => {
    const s = lifecycle(makeConfig('partial'), [
      makeFill('f1', 'buy', 4, 100, { feeUsd: 0.40, executedAt: 1 }),
      makeFill('f2', 'sell', 1, 110, { feeUsd: 0.10, executedAt: 2 }),
      makeFill('f3', 'sell', 3, 120, { feeUsd: 0.30, executedAt: 3 }),
    ]);

    assert.strictEqual(s.trades.length, 2, 'two completed round trips');
    assert.strictEqual(s.openPositions.length, 0);

    const t1 = s.trades[0];
    assert.strictEqual(t1.closedQuantity, 1);
    assert.strictEqual(t1.grossPnlUsd, 10, '(110 - 100) * 1');
    assert.strictEqual(t1.feeUsd, 0.20, 'entry 0.40*1/4 + exit 0.10');
    assert.strictEqual(t1.netPnlUsd, 9.80);
    assert.strictEqual(t1.holdingDurationMs, 1);

    const t2 = s.trades[1];
    assert.strictEqual(t2.closedQuantity, 3);
    assert.strictEqual(t2.grossPnlUsd, 60, '(120 - 100) * 3');
    assert.strictEqual(t2.feeUsd, 0.60, 'entry 0.40*3/4 + exit 0.30');
    assert.strictEqual(t2.netPnlUsd, 59.40);
    assert.strictEqual(t2.holdingDurationMs, 2);

    // Reconciliation: sum of net PnL === account.realizedPnlUsd, fees === totalFeesUsd.
    assert.strictEqual(s.grossPnlUsd, 70);
    assert.strictEqual(s.totalFeesUsd, 0.80);
    assert.strictEqual(s.realizedPnlUsd, 69.20);
    assert.strictEqual(s.netPnlUsd, 69.20);
  });
});

describe('Phase 6B — reversal split', () => {
  it('flips long→short: proportional exit-fee split, deterministic residual, reconciliation holds', () => {
    const s = lifecycle(makeConfig('reversal'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 3, 120, { feeUsd: 0.60, executedAt: 2 }),
    ]);

    // The single close leg completes the long; the excess opens a short residual.
    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.side, 'long');
    assert.strictEqual(t.closedQuantity, 2, 'only the long portion closes');
    assert.strictEqual(t.grossPnlUsd, 40, '(120 - 100) * 2');
    assert.strictEqual(t.feeUsd, 0.60, 'entry 0.20 + exit proportional 0.60*2/3');
    assert.strictEqual(t.netPnlUsd, 39.40);
    assert.strictEqual(t.holdingDurationMs, 1);

    // Deterministic residual: short 1 @ 120, carrying the proportional deferred fee.
    assert.strictEqual(s.openPositions.length, 1);
    const r = s.openPositions[0];
    assert.strictEqual(r.side, 'short');
    assert.strictEqual(r.signedQuantity, -1);
    assert.strictEqual(r.averageEntryPriceUsd, 120);
    assert.strictEqual(r.deferredFeeUsd, 0.20, 'exit fee 0.60*1/3 deferred to residual');
    assert.strictEqual(r.openedAt, 2);

    // Reconciliation: gross - totalFees = realized; deferred fee is the bridge to net.
    assert.strictEqual(s.grossPnlUsd, 40);
    assert.strictEqual(s.totalFeesUsd, 0.80);
    assert.strictEqual(s.realizedPnlUsd, 39.20, 'account.realizedPnlUsd = 40 - 0.80');
    assert.strictEqual(s.netPnlUsd, 39.40, 'net = realized + deferred residual fee');
    const feeSum = s.trades.reduce((a, tr) => a + tr.feeUsd, 0) + s.openPositions.reduce((a, p) => a + p.deferredFeeUsd, 0);
    assertApprox(feeSum, s.totalFeesUsd, 'sum(trade fee) + sum(deferred) === totalFeesUsd');
  });
});

describe('Phase 6B — gross / fees / net / holding duration reconciliation', () => {
  it('reconciles lifecycle aggregates to durable account realizedPnlUsd and totalFeesUsd', () => {
    const config = makeConfig('reconcile');
    const fills = [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 120, { feeUsd: 0.24, executedAt: 5 }),
    ];
    const { account, fills: entries } = buildLedger(config, fills);
    const s = computeTradeLifecycle({ account, fills: entries });

    assert.strictEqual(s.realizedPnlUsd, account.realizedPnlUsd, 'realized mirrors durable snapshot');
    assert.strictEqual(s.totalFeesUsd, account.totalFeesUsd, 'fees mirror durable snapshot');
    assert.strictEqual(s.realizedPnlUsd, account.realizedPnlUsd);
    assertApprox(s.grossPnlUsd - s.totalFeesUsd, s.realizedPnlUsd, 'gross - fees === realized');

    const t = s.trades[0];
    assert.strictEqual(t.grossPnlUsd, 40);
    assert.strictEqual(t.feeUsd, 0.44);
    assert.strictEqual(t.netPnlUsd, 39.56);
    assert.strictEqual(t.holdingDurationMs, 4);
  });
});

describe('Phase 6B — profit factor', () => {
  it('mixed win/loss → ratio of gross-winning-net to gross-losing-net', () => {
    const s = lifecycle(makeConfig('pf-mixed'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 120, { feeUsd: 0.24, executedAt: 2 }),
      makeFill('f3', 'buy', 2, 130, { feeUsd: 0.26, executedAt: 3 }),
      makeFill('f4', 'sell', 2, 125, { feeUsd: 0.25, executedAt: 4 }),
    ]);

    assert.strictEqual(s.winningTrades, 1);
    assert.strictEqual(s.losingTrades, 1);
    assert.strictEqual(s.breakEvenTrades, 0);
    // win net = 39.56, loss net = -10.51
    assertApprox(s.trades[0].netPnlUsd, 39.56, 'win net');
    assertApprox(s.trades[1].netPnlUsd, -10.51, 'loss net');
    assertApprox(s.profitFactor!, 39.56 / 10.51, 'profit factor');
  });

  it('win-only → 1_000_000 sentinel (not Infinity)', () => {
    const s = lifecycle(makeConfig('pf-winonly'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 120, { executedAt: 2 }),
    ]);
    assert.strictEqual(s.winningTrades, 1);
    assert.strictEqual(s.losingTrades, 0);
    assert.strictEqual(s.profitFactor, 1_000_000);
  });

  it('loss-only → 0', () => {
    const s = lifecycle(makeConfig('pf-lossonly'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 90, { executedAt: 2 }),
    ]);
    assert.strictEqual(s.winningTrades, 0);
    assert.strictEqual(s.losingTrades, 1);
    assert.strictEqual(s.profitFactor, 0);
  });
});

describe('Phase 6B — determinism + deep immutability', () => {
  const fills = [
    makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
    makeFill('f2', 'sell', 3, 120, { feeUsd: 0.60, executedAt: 2 }),
  ];

  it('identical inputs → identical deeply-equal result', () => {
    const config = makeConfig('det');
    const a = lifecycle(config, fills);
    const b = lifecycle(config, fills);
    assert.deepStrictEqual(a, b, 'deterministic projection');
  });

  it('result is deeply frozen and does not mutate source snapshot', () => {
    const config = makeConfig('frozen');
    const { account, fills: entries } = buildLedger(config, fills);
    const accountBefore = JSON.stringify(account);
    const fillsBefore = JSON.stringify(entries);

    const s = computeTradeLifecycle({ account, fills: entries });

    assert.ok(Object.isFrozen(s), 'result frozen');
    assert.ok(Object.isFrozen(s.trades), 'trades array frozen');
    assert.ok(Object.isFrozen(s.trades[0]), 'trade object frozen');
    assert.ok(Object.isFrozen(s.openPositions), 'open positions array frozen');
    assert.ok(Object.isFrozen(s.openPositions[0]), 'open position object frozen');

    assert.strictEqual(JSON.stringify(account), accountBefore, 'source snapshot unchanged');
    assert.strictEqual(JSON.stringify(entries), fillsBefore, 'source fill entries unchanged');
  });
});

describe('Phase 6B — zero-write ProductionSpine accounting read', () => {
  it('computing the lifecycle from a production spine performs zero persistence writes and zero new fills', async () => {
    const { createProductionSpine, executeThroughGateway, trustBaseline, recoverAndStart, reconcileRecoveredState, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    const { createMarketDataRuntime } = require('../../src/runtime/market/MarketDataRuntime');

    const dir = mkdtempSync(join(tmpdir(), 'p6b-lifecycle-'));
    const journalPath = join(dir, 'journal.jsonl');
    const cfg = { accountId: 'lifecycle', exchange: 'bitget' as ExchangeId, initialCashUsd: 100000 };
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

    const c = collector();
    const marketRuntime = createMarketDataRuntime({ collectorFactory: () => c });
    const spine = await createProductionSpine({ exchange: 'bitget', accountId: 'lifecycle', hardRisk, journalPath, paperAccount: cfg, persistence: counting, policyMaxLifetimeMs: 3600_000, marketRuntime });
    await marketRuntime.start();

    spine.protection.start();
    spine.planStore.subscribeToKernel(spine.kernel as any);
    await recoverAndStart(spine, journalPath);
    await reconcileRecoveredState(spine);
    c.emit(ticker('BTC/USDT', 100));
    await activateLiveReadiness(spine);
    trustBaseline(spine, 'bitget', 'BTC/USDT');
    const now = Date.now();
    spine.kernel.publish('policy.snapshot.published', { policy: { exchange: 'bitget', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: '1', compiledAt: now, effectiveAt: now, expiresAt: now + 3600_000, allowNewEntries: true, allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [], maxPositionMultiplier: 1, riskLevel: 'low', directionBias: 'neutral', symbolRules: {}, reasonCodes: [] } });

    await executeThroughGateway(spine, intent('i-open') as any, 'open', 5000);
    await new Promise((r) => setTimeout(r, 100));

    const account = spine.service.snapshot();
    const fills = spine.service.entries().filter((e: any) => e.type === 'fill') as PaperFillLedgerEntry[];
    const fillsBefore = fills.length;

    // Accounting read boundary: computing the lifecycle must not write.
    saves = 0;
    const s = computeTradeLifecycle({ account, fills });

    assert.strictEqual(s.totalFeesUsd, account.totalFeesUsd, 'read projection reconciles without write');
    assert.strictEqual(saves, 0, 'zero Paper persistence writes during lifecycle read');
    assert.strictEqual(spine.service.entries().filter((e: any) => e.type === 'fill').length, fillsBefore, 'fill count unchanged after read');

    rmSync(dir, { recursive: true, force: true });
  });
});
