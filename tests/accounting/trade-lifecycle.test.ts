// Phase 6B: Trade Lifecycle — adversarial acceptance tests.
//
// One trade incarnation per flat -> open -> ... -> flat/reversal cycle.
// Deterministic trade IDs, attributed fill-leg lineage, sequence-ordered
// (never sorted) input, fail-closed reconciliation, Python profit-factor
// semantics, and a read-only ProductionSpine lifecycle surface.

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeTradeLifecycle,
  TradeLifecycleSequenceError,
  TradeLifecycleExchangeMismatchError,
  TradeLifecycleReconciliationError,
} from '../../src/accounting/trade-lifecycle';
import type { TradeLifecycle, TradeIncarnation, AttributedLeg } from '../../src/accounting/trade-lifecycle-types';
import { PaperAccountLedger } from '../../src/paper/PaperAccountLedger';
import type { PaperAccountConfig, PaperAccountSnapshot, PaperFillLedgerEntry } from '../../src/types/paper-account';
import type { PaperFill } from '../../src/types/paper-fill';
import type { ExchangeId } from '../../src/data/MarketIdentity';

const EXCHANGE: ExchangeId = 'bitget';

function makeConfig(accountId: string, initialCashUsd = 100000): PaperAccountConfig {
  return { accountId, exchange: EXCHANGE, initialCashUsd };
}

function makeFill(
  id: string,
  side: 'buy' | 'sell',
  quantity: number,
  priceUsd: number,
  opts: { feeUsd?: number; executedAt?: number; symbol?: string; sourceOrderId?: string; sourceIntentId?: string } = {},
): PaperFill {
  return {
    fillId: id,
    exchange: EXCHANGE,
    symbol: opts.symbol ?? 'BTC/USDT',
    side,
    quantity,
    priceUsd,
    feeUsd: opts.feeUsd ?? 0,
    executedAt: opts.executedAt ?? 1,
    sourceOrderId: opts.sourceOrderId,
    sourceIntentId: opts.sourceIntentId,
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

function fillEntry(fill: PaperFill, sequence: number): PaperFillLedgerEntry {
  return { type: 'fill', sequence, fill };
}

function assertApprox(actual: number, expected: number, msg: string, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: actual=${actual} expected=${expected}`);
}

describe('Phase 6B — long full lifecycle (open → scale-in → close)', () => {
  it('produces one closed incarnation with reconciled metrics', () => {
    const s = lifecycle(makeConfig('long-full'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'buy', 1, 130, { feeUsd: 0.10, executedAt: 2 }),
      makeFill('f3', 'sell', 3, 120, { feeUsd: 0.30, executedAt: 3 }),
    ]);

    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.side, 'long');
    assert.strictEqual(t.entryQuantity, 3);
    assert.strictEqual(t.exitQuantity, 3);
    assert.strictEqual(t.openQuantity, 0);
    assert.strictEqual(t.averageEntryPriceUsd, 110);
    assert.strictEqual(t.averageExitPriceUsd, 120);
    assert.strictEqual(t.grossRealizedPnlUsd, 30);
    assert.strictEqual(t.allocatedFeesUsd, 0.60);
    assert.strictEqual(t.netPnlUsd, 29.40);
    assert.strictEqual(t.openedAt, 1);
    assert.strictEqual(t.closedAt, 3);
    assert.strictEqual(t.holdingDurationMs, 2);
    assert.strictEqual(t.legs.length, 3);

    assert.strictEqual(s.grossRealizedPnlUsd, 30);
    assert.strictEqual(s.totalFeesUsd, 0.60);
    assert.strictEqual(s.realizedPnlUsd, 29.40);
    assert.strictEqual(s.netPnlUsd, 29.40);
    assert.strictEqual(s.closedTrades, 1);
    assert.strictEqual(s.winningTrades, 1);
    assert.strictEqual(s.losingTrades, 0);
  });
});

describe('Phase 6B — short full lifecycle', () => {
  it('short open → buy close yields positive net on falling price', () => {
    const s = lifecycle(makeConfig('short-full'), [
      makeFill('f1', 'sell', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'buy', 2, 90, { feeUsd: 0.20, executedAt: 2 }),
    ]);
    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.side, 'short');
    assert.strictEqual(t.averageEntryPriceUsd, 100);
    assert.strictEqual(t.grossRealizedPnlUsd, 20);
    assert.strictEqual(t.netPnlUsd, 19.60);
    assert.strictEqual(s.realizedPnlUsd, 19.60);
  });
});

describe('Phase 6B — scale-in then partial close then full close', () => {
  it('stays a SINGLE incarnation (not one per partial close)', () => {
    const s = lifecycle(makeConfig('partial'), [
      makeFill('f1', 'buy', 4, 100, { feeUsd: 0.40, executedAt: 1 }),
      makeFill('f2', 'sell', 1, 110, { feeUsd: 0.10, executedAt: 2 }),
      makeFill('f3', 'sell', 3, 120, { feeUsd: 0.30, executedAt: 3 }),
    ]);

    assert.strictEqual(s.trades.length, 1, 'one incarnation, not one per partial close');
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.entryQuantity, 4);
    assert.strictEqual(t.exitQuantity, 4);
    assert.strictEqual(t.openQuantity, 0);
    assert.strictEqual(t.grossRealizedPnlUsd, 70);
    assert.strictEqual(t.allocatedFeesUsd, 0.80);
    assert.strictEqual(t.netPnlUsd, 69.20);
    assert.strictEqual(t.averageExitPriceUsd, 117.5);
    assert.strictEqual(t.legs.length, 3);

    assert.strictEqual(s.grossRealizedPnlUsd, 70);
    assert.strictEqual(s.totalFeesUsd, 0.80);
    assert.strictEqual(s.realizedPnlUsd, 69.20);
    assert.strictEqual(s.netPnlUsd, 69.20);
  });
});

describe('Phase 6B — partial close then same-side scale-in', () => {
  it('keeps the same incarnation across partial close and scale-in', () => {
    const s = lifecycle(makeConfig('partial-scalein'), [
      makeFill('f1', 'buy', 4, 100, { feeUsd: 0.40, executedAt: 1 }),
      makeFill('f2', 'sell', 1, 110, { feeUsd: 0.10, executedAt: 2 }),
      makeFill('f3', 'buy', 2, 105, { feeUsd: 0.20, executedAt: 3 }),
      makeFill('f4', 'sell', 5, 115, { feeUsd: 0.50, executedAt: 4 }),
    ]);

    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.entryQuantity, 6);
    assert.strictEqual(t.exitQuantity, 6);
    assert.strictEqual(t.averageEntryPriceUsd, 102);
    assert.strictEqual(t.grossRealizedPnlUsd, 75);
    assert.strictEqual(t.netPnlUsd, 73.80);
    assert.strictEqual(t.holdingDurationMs, 3);
    assert.strictEqual(t.legs.length, 4);
    assert.strictEqual(s.realizedPnlUsd, 73.80);
  });
});

describe('Phase 6B — exact flatten', () => {
  it('closes the incarnation with zero open quantity', () => {
    const s = lifecycle(makeConfig('flatten'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 2 }),
    ]);
    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.openQuantity, 0);
    assert.strictEqual(t.entryQuantity, 2);
    assert.strictEqual(t.exitQuantity, 2);
    assert.strictEqual(t.netPnlUsd, 19.60);
  });
});

describe('Phase 6B — long→short reversal (non-divisible fee residual)', () => {
  it('splits the reversal fill into two non-overlapping legs that sum exactly', () => {
    const s = lifecycle(makeConfig('rev-long-short'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 1.00, executedAt: 1 }),
      makeFill('f2', 'sell', 3, 120, { feeUsd: 1.00, executedAt: 2 }),
    ]);

    assert.strictEqual(s.trades.length, 2);
    const oldLong = s.trades[0];
    const newShort = s.trades[1];

    assert.strictEqual(oldLong.side, 'long');
    assert.strictEqual(oldLong.status, 'closed');
    assert.strictEqual(oldLong.entryQuantity, 2);
    assert.strictEqual(oldLong.exitQuantity, 2);
    assert.strictEqual(oldLong.grossRealizedPnlUsd, 40);
    assert.strictEqual(oldLong.allocatedFeesUsd, 1.66666667);
    assert.strictEqual(oldLong.netPnlUsd, 38.33333333);
    assert.strictEqual(oldLong.holdingDurationMs, 1);

    assert.strictEqual(newShort.side, 'short');
    assert.strictEqual(newShort.status, 'open');
    assert.strictEqual(newShort.entryQuantity, 1);
    assert.strictEqual(newShort.openQuantity, 1);
    assert.strictEqual(newShort.allocatedFeesUsd, 0.33333333);
    assert.strictEqual(newShort.netPnlUsd, -0.33333333);

    // Non-overlapping quantity attribution of the reversal fill.
    const closeLeg = oldLong.legs[1];
    const openLeg = newShort.legs[0];
    assert.strictEqual(closeLeg.fillId, 'f2');
    assert.strictEqual(openLeg.fillId, 'f2');
    assert.strictEqual(closeLeg.attributedQuantity + openLeg.attributedQuantity, 3);
    assertApprox(closeLeg.allocatedFeeUsd + openLeg.allocatedFeeUsd, 1.00, 'f2 fee splits sum exactly to canonical 1.00');

    // Aggregates reconcile.
    assert.strictEqual(s.grossRealizedPnlUsd, 40);
    assert.strictEqual(s.totalFeesUsd, 2.00);
    assert.strictEqual(s.realizedPnlUsd, 38.00);
    assert.strictEqual(s.netPnlUsd, 38.00);
  });
});

describe('Phase 6B — short→long reversal (non-divisible fee residual)', () => {
  it('closes the short and opens a long residual with exact fee split', () => {
    const s = lifecycle(makeConfig('rev-short-long'), [
      makeFill('f1', 'sell', 3, 100, { feeUsd: 0.10, executedAt: 1 }),
      makeFill('f2', 'buy', 4, 90, { feeUsd: 0.10, executedAt: 2 }),
    ]);

    assert.strictEqual(s.trades.length, 2);
    const oldShort = s.trades[0];
    const newLong = s.trades[1];

    assert.strictEqual(oldShort.side, 'short');
    assert.strictEqual(oldShort.status, 'closed');
    assert.strictEqual(oldShort.grossRealizedPnlUsd, 30);
    assert.strictEqual(oldShort.allocatedFeesUsd, 0.175);
    assert.strictEqual(oldShort.netPnlUsd, 29.825);

    assert.strictEqual(newLong.side, 'long');
    assert.strictEqual(newLong.status, 'open');
    assert.strictEqual(newLong.openQuantity, 1);
    assert.strictEqual(newLong.allocatedFeesUsd, 0.025);
    assert.strictEqual(newLong.netPnlUsd, -0.025);

    const closeLeg = oldShort.legs[1];
    const openLeg = newLong.legs[0];
    assertApprox(closeLeg.allocatedFeeUsd + openLeg.allocatedFeeUsd, 0.10, 'f2 fee splits sum exactly to canonical 0.10');

    assert.strictEqual(s.grossRealizedPnlUsd, 30);
    assert.strictEqual(s.totalFeesUsd, 0.20);
    assert.strictEqual(s.realizedPnlUsd, 29.80);
    assert.strictEqual(s.netPnlUsd, 29.80);
  });
});

describe('Phase 6B — interleaved symbols', () => {
  it('groups fills independently by symbol and orders by opening sequence', () => {
    const s = lifecycle(makeConfig('interleaved'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1, symbol: 'BTC/USDT' }),
      makeFill('f2', 'buy', 1, 50, { feeUsd: 0.10, executedAt: 2, symbol: 'ETH/USDT' }),
      makeFill('f3', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 3, symbol: 'BTC/USDT' }),
      makeFill('f4', 'sell', 1, 60, { feeUsd: 0.10, executedAt: 4, symbol: 'ETH/USDT' }),
    ]);

    assert.strictEqual(s.trades.length, 2);
    assert.deepStrictEqual(s.trades.map((t) => t.symbol), ['BTC/USDT', 'ETH/USDT']);
    const btc = s.trades[0];
    const eth = s.trades[1];
    assert.strictEqual(btc.status, 'closed');
    assert.strictEqual(btc.netPnlUsd, 19.60);
    assert.strictEqual(eth.status, 'closed');
    assert.strictEqual(eth.netPnlUsd, 9.80);
    assert.strictEqual(s.realizedPnlUsd, 29.40);
  });
});

describe('Phase 6B — same timestamp, different sequence', () => {
  it('uses sequence (not timestamp) as the ordering authority', () => {
    const s = lifecycle(makeConfig('same-ts'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 100 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 100 }),
    ]);
    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.openedAt, 100);
    assert.strictEqual(t.closedAt, 100);
    assert.strictEqual(t.holdingDurationMs, 0);
    assert.strictEqual(t.netPnlUsd, 19.60);
  });
});

describe('Phase 6B — same-price reopen produces a different trade ID', () => {
  it('derives distinct deterministic IDs from the opening fill identity', () => {
    const s = lifecycle(makeConfig('reopen'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 100, { feeUsd: 0.20, executedAt: 2 }),
      makeFill('f3', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 3 }),
    ]);

    assert.strictEqual(s.trades.length, 2);
    const first = s.trades[0];
    const second = s.trades[1];
    assert.strictEqual(first.status, 'closed');
    assert.strictEqual(second.status, 'open');
    assert.notStrictEqual(first.tradeId, second.tradeId, 'same-price reopen must differ');
    assert.ok(first.tradeId.includes('f1'), 'first ID carries opening fill identity');
    assert.ok(second.tradeId.includes('f3'), 'second ID carries opening fill identity');
  });
});

describe('Phase 6B — open vs closed incarnation metrics', () => {
  it('open trade keeps partial metrics with null closedAt/holdingDuration', () => {
    const s = lifecycle(makeConfig('open-metrics'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.40, executedAt: 1 }),
      makeFill('f2', 'sell', 1, 110, { feeUsd: 0.10, executedAt: 2 }),
    ]);

    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.entryQuantity, 2);
    assert.strictEqual(t.exitQuantity, 1);
    assert.strictEqual(t.openQuantity, 1);
    assert.strictEqual(t.averageEntryPriceUsd, 100);
    assert.strictEqual(t.averageExitPriceUsd, 110);
    assert.strictEqual(t.grossRealizedPnlUsd, 10);
    assert.strictEqual(t.netPnlUsd, 9.50);
    assert.strictEqual(t.openedAt, 1);
    assert.strictEqual(t.closedAt, null);
    assert.strictEqual(t.holdingDurationMs, null);

    assert.strictEqual(s.closedTrades, 0);
    assert.strictEqual(s.winningTrades, 0);
    assert.strictEqual(s.losingTrades, 0);
    assert.strictEqual(s.breakEvenTrades, 0);
    assert.strictEqual(s.profitFactor, 0.0);
    assert.strictEqual(s.realizedPnlUsd, 9.50);
    assert.strictEqual(s.netPnlUsd, 9.50);
  });
});

describe('Phase 6B — attributed fill-leg lineage', () => {
  it('preserves correlated OMS lineage and preserves absence for legacy fills', () => {
    const s = lifecycle(makeConfig('lineage'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 2, sourceOrderId: 'o-1', sourceIntentId: 'i-1' }),
    ]);

    const t = s.trades[0];
    const openLeg = t.legs[0];
    const closeLeg = t.legs[1];

    assert.strictEqual(openLeg.fillId, 'f1');
    assert.strictEqual(openLeg.sequence, 1);
    assert.strictEqual(openLeg.attributedQuantity, 2);
    assert.strictEqual(openLeg.priceUsd, 100);
    assert.strictEqual(openLeg.executedAt, 1);
    assert.strictEqual(openLeg.allocatedFeeUsd, 0.20);
    assert.strictEqual('sourceOrderId' in openLeg, false, 'legacy fill keeps absence of correlation');
    assert.strictEqual('sourceIntentId' in openLeg, false);

    assert.strictEqual(closeLeg.fillId, 'f2');
    assert.strictEqual(closeLeg.sequence, 2);
    assert.strictEqual(closeLeg.sourceOrderId, 'o-1');
    assert.strictEqual(closeLeg.sourceIntentId, 'i-1');
  });
});

describe('Phase 6B — determinism + deep freeze + caller immutability', () => {
  const fills = [
    makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
    makeFill('f2', 'sell', 3, 120, { feeUsd: 1.00, executedAt: 2 }),
  ];

  it('identical inputs yield identical deeply-equal results (stable ordering)', () => {
    const a = lifecycle(makeConfig('det'), fills);
    const b = lifecycle(makeConfig('det'), fills);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a.trades.map((t) => t.tradeId), b.trades.map((t) => t.tradeId));
  });

  it('result is deeply frozen and source inputs are not mutated or frozen', () => {
    const config = makeConfig('frozen');
    const { account, fills: entries } = buildLedger(config, fills);
    const accountBefore = JSON.stringify(account);
    const fillsBefore = JSON.stringify(entries);

    const s = computeTradeLifecycle({ account, fills: entries });

    assert.ok(Object.isFrozen(s), 'top snapshot frozen');
    assert.ok(Object.isFrozen(s.trades), 'trades array frozen');
    assert.ok(Object.isFrozen(s.trades[0]), 'trade object frozen');
    assert.ok(Object.isFrozen(s.trades[0].legs), 'legs array frozen');
    assert.ok(Object.isFrozen(s.trades[0].legs[0]), 'leg object frozen');

    assert.strictEqual(JSON.stringify(account), accountBefore, 'source snapshot unchanged');
    assert.strictEqual(JSON.stringify(entries), fillsBefore, 'source fill entries unchanged');
    assert.strictEqual(Object.isFrozen(account), false, 'caller account was not frozen');
    assert.strictEqual(Object.isFrozen(entries[0]), false, 'caller fill entry was not frozen');
  });
});

describe('Phase 6B — sequence validation (reject malformed, allow gaps)', () => {
  it('rejects duplicate sequences', () => {
    const { account } = buildLedger(makeConfig('dup'), []);
    const f = makeFill('f1', 'buy', 1, 100);
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(f, 1), fillEntry(f, 1)] }),
      (e: any) => e instanceof TradeLifecycleSequenceError,
    );
  });

  it('rejects non-increasing sequences', () => {
    const { account } = buildLedger(makeConfig('noninc'), []);
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(makeFill('f1', 'buy', 1, 100), 2), fillEntry(makeFill('f2', 'sell', 1, 100), 1)] }),
      (e: any) => e instanceof TradeLifecycleSequenceError,
    );
  });

  it('rejects non-positive sequences', () => {
    const { account } = buildLedger(makeConfig('nonpos'), []);
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(makeFill('f1', 'buy', 1, 100), 0)] }),
      (e: any) => e instanceof TradeLifecycleSequenceError,
    );
  });

  it('allows gaps (marks may exist between fills) and does NOT sort by timestamp/fillId', () => {
    // Account (realized 20, fees 0) from the same economic facts in ledger order.
    const { account } = buildLedger(makeConfig('gap'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { executedAt: 2 }),
    ]);
    // Lifecycle input: sequences 1 and 3 (gap at 2). The close fill carries an
    // EARLIER executedAt (50) than the open (200) to prove sequence — not
    // timestamp — governs ordering. A timestamp sort would wrongly open a short.
    const s = computeTradeLifecycle({
      account,
      fills: [
        fillEntry(makeFill('f1', 'buy', 2, 100, { executedAt: 200 }), 1),
        fillEntry(makeFill('f2', 'sell', 2, 110, { executedAt: 50 }), 3),
      ],
    });
    assert.strictEqual(s.trades.length, 1);
    assert.strictEqual(s.trades[0].side, 'long');
    assert.strictEqual(s.trades[0].status, 'closed');
    assert.strictEqual(s.trades[0].netPnlUsd, 20);
  });
});

describe('Phase 6B — exchange / reconciliation fail-closed', () => {
  it('rejects a fill whose exchange mismatches the account', () => {
    const { account } = buildLedger(makeConfig('xchg'), []);
    const foreign = { ...makeFill('f1', 'buy', 1, 100), exchange: 'binance' as ExchangeId };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(foreign, 1)] }),
      (e: any) => e instanceof TradeLifecycleExchangeMismatchError,
    );
  });

  it('throws a typed error when allocated fees do not reconcile with canonical total fees', () => {
    const { account, fills } = buildLedger(makeConfig('recon-fee'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 2 }),
    ]);
    const tampered: PaperAccountSnapshot = { ...account, totalFeesUsd: account.totalFeesUsd + 5 };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleReconciliationError,
    );
  });

  it('throws a typed error when projected realized PnL does not reconcile with canonical realized', () => {
    const { account, fills } = buildLedger(makeConfig('recon-pnl'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 2 }),
    ]);
    const tampered: PaperAccountSnapshot = { ...account, realizedPnlUsd: account.realizedPnlUsd + 5 };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleReconciliationError,
    );
  });
});

describe('Phase 6B — profit factor (Python standard_profit_factor semantics)', () => {
  it('no trades → 0.0 (never null)', () => {
    const s = lifecycle(makeConfig('pf-none'), []);
    assert.strictEqual(s.closedTrades, 0);
    assert.strictEqual(s.profitFactor, 0.0);
  });

  it('loss-only → 0.0', () => {
    const s = lifecycle(makeConfig('pf-loss'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 90, { executedAt: 2 }),
    ]);
    assert.strictEqual(s.winningTrades, 0);
    assert.strictEqual(s.losingTrades, 1);
    assert.strictEqual(s.profitFactor, 0.0);
  });

  it('win-only → 1_000_000 sentinel', () => {
    const s = lifecycle(makeConfig('pf-win'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 120, { executedAt: 2 }),
    ]);
    assert.strictEqual(s.winningTrades, 1);
    assert.strictEqual(s.losingTrades, 0);
    assert.strictEqual(s.profitFactor, 1_000_000);
  });

  it('mixed → grossWins / grossLosses over closed-trade net PnL', () => {
    const s = lifecycle(makeConfig('pf-mixed'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 120, { executedAt: 2 }),
      makeFill('f3', 'buy', 2, 130, { executedAt: 3 }),
      makeFill('f4', 'sell', 2, 125, { executedAt: 4 }),
    ]);
    assert.strictEqual(s.closedTrades, 2);
    assert.strictEqual(s.winningTrades, 1);
    assert.strictEqual(s.losingTrades, 1);
    assertApprox(s.profitFactor, 4.0, '40 / 10');
  });

  it('all break-even → 0.0 (wins==0 is checked before losses==0)', () => {
    const s = lifecycle(makeConfig('pf-even'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 100, { executedAt: 2 }),
      makeFill('f3', 'buy', 2, 100, { executedAt: 3 }),
      makeFill('f4', 'sell', 2, 100, { executedAt: 4 }),
    ]);
    assert.strictEqual(s.closedTrades, 2);
    assert.strictEqual(s.winningTrades, 0);
    assert.strictEqual(s.losingTrades, 0);
    assert.strictEqual(s.breakEvenTrades, 2);
    assert.strictEqual(s.profitFactor, 0.0);
  });
});

describe('Phase 6B — read-only ProductionSpine lifecycle surface', () => {
  it('spine.accounting.lifecycle() causes zero persistence/OMS/market writes and zero state mutation', async () => {
    const { createProductionSpine } = require('../../src/position/ProductionSpine');

    const dir = mkdtempSync(join(tmpdir(), 'p6b-lifecycle-'));
    const cfg: PaperAccountConfig = { accountId: 'lifecycle', exchange: 'bitget', initialCashUsd: 100000 };

    // Seed a durable ledger with a completed round trip — no gateway execution.
    const ledger = new PaperAccountLedger(cfg);
    ledger.applyFill(makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 1 }));
    ledger.applyFill(makeFill('f2', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 2 }));

    let saves = 0;
    const persistence = {
      load: async () => ledger,
      save: async () => { saves += 1; },
    };

    const hardRisk = () => ({ exchange: 'bitget', locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity });
    const spine = await createProductionSpine({
      exchange: 'bitget',
      accountId: 'lifecycle',
      paperAccount: cfg,
      persistence,
      hardRisk,
      journalPath: join(dir, 'journal.jsonl'),
      policyMaxLifetimeMs: 3600_000,
    });

    // NO recoverAndStart, NO activateLiveReadiness, NO market runtime, NO gateway.
    const snapshotBefore = JSON.stringify(spine.service.snapshot());
    const entriesBefore = spine.service.entries().length;
    const marketDigestBefore = JSON.stringify(spine.marketStore.digest());

    const result = spine.accounting.lifecycle();

    assert.strictEqual(result.accountId, 'lifecycle');
    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].status, 'closed');
    assert.strictEqual(result.trades[0].netPnlUsd, 19.60);
    assert.strictEqual(result.realizedPnlUsd, 19.60);

    assert.strictEqual(saves, 0, 'zero Paper persistence writes during lifecycle read');
    assert.strictEqual(spine.service.entries().length, entriesBefore, 'zero new fills (no OMS/execution)');
    assert.strictEqual(JSON.stringify(spine.service.snapshot()), snapshotBefore, 'zero ledger state mutation');
    assert.strictEqual(JSON.stringify(spine.marketStore.digest()), marketDigestBefore, 'zero market writes');

    // Existing Phase 6A accounting.snapshot() surface remains intact.
    const accounting = spine.accounting.snapshot();
    assert.strictEqual(accounting.realizedPnlUsd, 19.60);
    assert.strictEqual(accounting.processedFills, 2);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 6A — runtime accounting regression', () => {
  it('computeRuntimeAccounting still yields a frozen flat snapshot', () => {
    const { computeRuntimeAccounting } = require('../../src/accounting/runtime-accounting');
    const { account } = buildLedger(makeConfig('p6a-reg'), []);
    const s = computeRuntimeAccounting({ account, fills: [], markets: [], capturedAt: 1, source: 'test' });
    assert.strictEqual(s.realizedPnlUsd, 0);
    assert.strictEqual(s.totalFeesUsd, 0);
    assert.strictEqual(s.valuationStatus, 'COMPLETE');
    assert.ok(Object.isFrozen(s), 'runtime accounting snapshot frozen');
  });
});
