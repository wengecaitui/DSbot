// Phase 6B Repair 2 — focused adversarial tests for items 1-5.
//   (1) snapshot/history binding: exact fill-history accounting, sequence
//       envelope, position reconciliation, duplicate fill IDs.
//   (2) fail-closed finite/canonical input validation with typed errors,
//       including canonical durability precision (USD 8dp / quantity 12dp).
//   (3) collision-safe deterministic trade IDs (length-prefixed components).
//   (4) whole-incarnation entry notional vs open-position cost basis, with
//       long and short partial-close then scale-in closed-trade identities.
//   (5) per-symbol executedAt regression rejection.

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeTradeLifecycle,
  TradeLifecycleReconciliationError,
  TradeLifecycleValidationError,
  TradeLifecycleDuplicateFillIdError,
  TradeLifecycleTimeRegressionError,
  TradeLifecyclePositionReconciliationError,
} from '../../src/accounting/trade-lifecycle';
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
  opts: { feeUsd?: number; executedAt?: number; symbol?: string } = {},
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

function fillEntry(fill: PaperFill, sequence: number): PaperFillLedgerEntry {
  return { type: 'fill', sequence, fill };
}

function assertApprox(actual: number, expected: number, msg: string, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: actual=${actual} expected=${expected}`);
}

function lifecycle(config: PaperAccountConfig, fills: readonly PaperFill[]) {
  const { account, fills: entries } = buildLedger(config, fills);
  return computeTradeLifecycle({ account, fills: entries });
}

describe('Repair 2 item 1 — snapshot/history binding', () => {
  it('fails closed when a snapshot with processed fills receives an empty history', () => {
    const { account } = buildLedger(makeConfig('bind-empty'), [makeFill('f1', 'buy', 1, 100)]);
    assert.strictEqual(account.processedFills, 1);
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [] }),
      (e: any) => e instanceof TradeLifecycleReconciliationError,
    );
  });

  it('fails closed when the history has fewer fills than processedFills', () => {
    const { account, fills } = buildLedger(makeConfig('bind-short'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { executedAt: 2 }),
    ]);
    assert.strictEqual(account.processedFills, 2);
    assert.throws(
      () => computeTradeLifecycle({ account, fills: fills.slice(0, 1) }),
      (e: any) => e instanceof TradeLifecycleReconciliationError,
    );
  });

  it('fails closed when a fill sequence exceeds account.sequence (envelope)', () => {
    const { account, fills } = buildLedger(makeConfig('bind-envelope'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { executedAt: 2 }),
    ]);
    const inflated = [{ ...fills[0] }, { ...fills[1], sequence: 99 }];
    assert.throws(
      () => computeTradeLifecycle({ account, fills: inflated }),
      (e: any) => e instanceof TradeLifecycleReconciliationError,
    );
  });

  it('rejects duplicate fill IDs across the supplied history', () => {
    const { account } = buildLedger(makeConfig('bind-dupid'), [
      makeFill('f1', 'buy', 1, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 1, 100, { executedAt: 2 }),
    ]);
    const dup = [
      fillEntry(makeFill('same', 'buy', 1, 100, { executedAt: 1 }), 1),
      fillEntry(makeFill('same', 'sell', 1, 100, { executedAt: 2 }), 2),
    ];
    assert.throws(
      () => computeTradeLifecycle({ account, fills: dup }),
      (e: any) => e instanceof TradeLifecycleDuplicateFillIdError,
    );
  });

  it('fails closed when a projected open position cost basis mismatches the account', () => {
    const { account } = buildLedger(makeConfig('bind-pos'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const tampered: PaperAccountSnapshot = {
      ...account,
      positions: account.positions.map((p) => ({ ...p, averageEntryPriceUsd: 200 })),
    };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills: [fillEntry(makeFill('f1', 'buy', 2, 100, { executedAt: 1 }), 1)] }),
      (e: any) => e instanceof TradeLifecyclePositionReconciliationError,
    );
  });

  it('fails closed when a projected open position quantity mismatches the account', () => {
    const { account } = buildLedger(makeConfig('bind-qty'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const tampered: PaperAccountSnapshot = {
      ...account,
      positions: account.positions.map((p) => ({ ...p, signedQuantity: 3 })),
    };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills: [fillEntry(makeFill('f1', 'buy', 2, 100, { executedAt: 1 }), 1)] }),
      (e: any) => e instanceof TradeLifecyclePositionReconciliationError,
    );
  });

  it('fails closed when a position symbol has no projected open trade', () => {
    const { account } = buildLedger(makeConfig('bind-identity'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const tampered: PaperAccountSnapshot = {
      ...account,
      positions: account.positions.map((p) => ({ ...p, symbol: 'ETH/USDT' })),
    };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills: [fillEntry(makeFill('f1', 'buy', 2, 100, { executedAt: 1 }), 1)] }),
      (e: any) => e instanceof TradeLifecyclePositionReconciliationError,
    );
  });
});

describe('Repair 2 item 2 — fail-closed finite/canonical input validation', () => {
  it('rejects a snapshot whose realizedPnlUsd is NaN', () => {
    const { account, fills } = buildLedger(makeConfig('nan'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { executedAt: 2 }),
    ]);
    const tampered: PaperAccountSnapshot = { ...account, realizedPnlUsd: NaN };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a snapshot with Infinity totalFeesUsd', () => {
    const { account, fills } = buildLedger(makeConfig('inf'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { executedAt: 2 }),
    ]);
    const tampered: PaperAccountSnapshot = { ...account, totalFeesUsd: Infinity };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a fill with NaN quantity', () => {
    const { account } = buildLedger(makeConfig('nanqty'), [makeFill('f1', 'buy', 1, 100, { executedAt: 1 })]);
    const bad = { ...makeFill('f1', 'buy', 1, 100, { executedAt: 1 }), quantity: NaN };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(bad, 1)] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a fill with negative fee', () => {
    const { account } = buildLedger(makeConfig('negfee'), [makeFill('f1', 'buy', 1, 100, { executedAt: 1 })]);
    const bad = { ...makeFill('f1', 'buy', 1, 100, { executedAt: 1 }), feeUsd: -1 };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(bad, 1)] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a fill with zero price', () => {
    const { account } = buildLedger(makeConfig('zeroprice'), [makeFill('f1', 'buy', 1, 100, { executedAt: 1 })]);
    const bad = { ...makeFill('f1', 'buy', 1, 100, { executedAt: 1 }), priceUsd: 0 };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(bad, 1)] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a fill entry whose shape is not a fill', () => {
    const { account } = buildLedger(makeConfig('shape'), [makeFill('f1', 'buy', 1, 100, { executedAt: 1 })]);
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [{ type: 'mark', sequence: 1 } as any] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a non-integer counter (processedFills as a float)', () => {
    const { account, fills } = buildLedger(makeConfig('counter'), [makeFill('f1', 'buy', 1, 100, { executedAt: 1 })]);
    const tampered: PaperAccountSnapshot = { ...account, processedFills: 1.5 };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a non-finite executedAt timestamp', () => {
    const { account } = buildLedger(makeConfig('badts'), [makeFill('f1', 'buy', 1, 100, { executedAt: 1 })]);
    const bad = { ...makeFill('f1', 'buy', 1, 100, { executedAt: 1 }), executedAt: NaN };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(bad, 1)] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });
});

describe('Repair 2 item 5 — per-symbol timestamp regression', () => {
  it('rejects a fill whose executedAt regresses for the same symbol', () => {
    const { account } = buildLedger(makeConfig('regress'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 10 }),
      makeFill('f2', 'sell', 2, 110, { executedAt: 20 }),
    ]);
    const regressed = [
      fillEntry(makeFill('f1', 'buy', 2, 100, { executedAt: 10 }), 1),
      fillEntry(makeFill('f2', 'sell', 2, 110, { executedAt: 5 }), 2),
    ];
    assert.throws(
      () => computeTradeLifecycle({ account, fills: regressed }),
      (e: any) => e instanceof TradeLifecycleTimeRegressionError,
    );
  });

  it('allows equal timestamps (no regression) and never yields a negative duration', () => {
    const { account, fills } = buildLedger(makeConfig('regress-eq'), [
      makeFill('f1', 'buy', 2, 100, { feeUsd: 0.20, executedAt: 100 }),
      makeFill('f2', 'sell', 2, 110, { feeUsd: 0.20, executedAt: 100 }),
    ]);
    const s = computeTradeLifecycle({ account, fills });
    assert.strictEqual(s.trades[0].holdingDurationMs, 0);
    assert.ok((s.trades[0].holdingDurationMs as number) >= 0);
    assert.strictEqual(s.trades[0].netPnlUsd, 19.60);
  });
});


describe('Repair 2 item 3 — collision-safe deterministic trade IDs', () => {
  it('produces distinct IDs for (symbol=X, seq=1, fillId=2|Y) vs (symbol=X|1, seq=2, fillId=Y)', () => {
    const sA = lifecycle(makeConfig('acct'), [
      makeFill('2|Y', 'buy', 1, 100, { symbol: 'X', executedAt: 1 }),
    ]);
    const tradeA = sA.trades[0];
    assert.strictEqual(tradeA.symbol, 'X');
    assert.strictEqual(tradeA.tradeId, '4:acct|6:bitget|1:X|1:1|3:2|Y');

    const ledgerB = new PaperAccountLedger(makeConfig('acct'));
    ledgerB.applyFill(makeFill('anchor', 'buy', 1, 50, { symbol: 'OTHER', executedAt: 1 }));
    ledgerB.applyFill(makeFill('Y', 'buy', 1, 100, { symbol: 'X|1', executedAt: 2 }));
    const sB = computeTradeLifecycle({
      account: ledgerB.snapshot(),
      fills: ledgerB.entries().filter((e) => e.type === 'fill') as PaperFillLedgerEntry[],
    });
    const tradeB = sB.trades.find((t) => t.symbol === 'X|1')!;
    assert.strictEqual(tradeB.tradeId, '4:acct|6:bitget|3:X|1|1:2|1:Y');

    assert.notStrictEqual(tradeA.tradeId, tradeB.tradeId);
  });

  it('recomputes an identical trade ID from identical facts (stable recomputation)', () => {
    const a = lifecycle(makeConfig('acct'), [makeFill('f1', 'buy', 2, 100, { symbol: 'X', executedAt: 1 })]);
    const b = lifecycle(makeConfig('acct'), [makeFill('f1', 'buy', 2, 100, { symbol: 'X', executedAt: 1 })]);
    assert.strictEqual(a.trades[0].tradeId, b.trades[0].tradeId);
  });
});


describe('Repair 2 item 4 — whole-incarnation entry notional vs open-position cost basis', () => {
  it('long partial-close then scale-in: (avgExit - avgEntry) * closedQty == gross', () => {
    const s = lifecycle(makeConfig('item4-long'), [
      makeFill('f1', 'buy', 4, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 1, 110, { executedAt: 2 }),
      makeFill('f3', 'buy', 1, 200, { executedAt: 3 }),
      makeFill('f4', 'sell', 4, 150, { executedAt: 4 }),
    ]);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.entryQuantity, 5);
    assert.strictEqual(t.exitQuantity, 5);
    assert.strictEqual(t.averageEntryPriceUsd, 120);
    assert.strictEqual(t.averageExitPriceUsd, 142);
    assert.strictEqual(t.grossRealizedPnlUsd, 110);
    const implied = (t.averageExitPriceUsd! - t.averageEntryPriceUsd) * t.exitQuantity;
    assertApprox(implied, t.grossRealizedPnlUsd, 'long closed-trade identity');
  });

  it('short partial-close then scale-in: (avgEntry - avgExit) * closedQty == gross', () => {
    const s = lifecycle(makeConfig('item4-short'), [
      makeFill('f1', 'sell', 4, 100, { executedAt: 1 }),
      makeFill('f2', 'buy', 1, 90, { executedAt: 2 }),
      makeFill('f3', 'sell', 1, 80, { executedAt: 3 }),
      makeFill('f4', 'buy', 4, 85, { executedAt: 4 }),
    ]);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.entryQuantity, 5);
    assert.strictEqual(t.exitQuantity, 5);
    assert.strictEqual(t.averageEntryPriceUsd, 96);
    assert.strictEqual(t.averageExitPriceUsd, 86);
    assert.strictEqual(t.grossRealizedPnlUsd, 50);
    const implied = (t.averageEntryPriceUsd - t.averageExitPriceUsd!) * t.exitQuantity;
    assertApprox(implied, t.grossRealizedPnlUsd, 'short closed-trade identity');
  });

  it('reconciles an open position against current cost basis while publishing whole-incarnation entry average', () => {
    const { account, fills } = buildLedger(makeConfig('item4-open'), [
      makeFill('f1', 'buy', 4, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 1, 110, { executedAt: 2 }),
      makeFill('f3', 'buy', 1, 200, { executedAt: 3 }),
    ]);
    const s = computeTradeLifecycle({ account, fills });
    const t = s.trades[0];
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.entryQuantity, 5);
    assert.strictEqual(t.exitQuantity, 1);
    assert.strictEqual(t.openQuantity, 4);
    assert.strictEqual(t.averageEntryPriceUsd, 120);
    assert.strictEqual(account.positions[0].averageEntryPriceUsd, 125);
  });
});


describe('Repair 2 item 2 (canonical durability) — reject non-canonical precision', () => {
  it('rejects a fill quantity with more than 12 decimal places', () => {
    const { account } = buildLedger(makeConfig('canon-qty'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const bad = { ...makeFill('f1', 'buy', 2, 100, { executedAt: 1 }), quantity: 2.0000000000001 };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(bad, 1)] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a fill priceUsd with more than 8 decimal places', () => {
    const { account } = buildLedger(makeConfig('canon-price'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const bad = { ...makeFill('f1', 'buy', 2, 100, { executedAt: 1 }), priceUsd: 100.000000001 };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(bad, 1)] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a fill feeUsd with more than 8 decimal places', () => {
    const { account } = buildLedger(makeConfig('canon-fee'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const bad = { ...makeFill('f1', 'buy', 2, 100, { executedAt: 1 }), feeUsd: 0.000000001 };
    assert.throws(
      () => computeTradeLifecycle({ account, fills: [fillEntry(bad, 1)] }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a snapshot currency value with more than 8 decimal places', () => {
    const { account, fills } = buildLedger(makeConfig('canon-cur'), [
      makeFill('f1', 'buy', 2, 100, { executedAt: 1 }),
      makeFill('f2', 'sell', 2, 110, { executedAt: 2 }),
    ]);
    const tampered: PaperAccountSnapshot = { ...account, realizedPnlUsd: account.realizedPnlUsd + 0.000000001 };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a snapshot position quantity with more than 12 decimal places', () => {
    const { account, fills } = buildLedger(makeConfig('canon-posqty'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const tampered: PaperAccountSnapshot = {
      ...account,
      positions: account.positions.map((p) => ({ ...p, signedQuantity: p.signedQuantity + 0.0000000000001 })),
    };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });

  it('rejects a snapshot position USD value with more than 8 decimal places', () => {
    const { account, fills } = buildLedger(makeConfig('canon-posusd'), [makeFill('f1', 'buy', 2, 100, { executedAt: 1 })]);
    const tampered: PaperAccountSnapshot = {
      ...account,
      positions: account.positions.map((p) => ({ ...p, markPriceUsd: 100.000000001 })),
    };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleValidationError,
    );
  });
});
