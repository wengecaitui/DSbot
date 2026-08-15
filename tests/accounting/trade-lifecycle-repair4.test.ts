// Phase 6B Repair 4 — tiny-quantity weighted-average precision (RED probes).
//
// Root cause: `entryNotionalUsd` and `exitPriceWeighted` accumulated
// `quantity * price` through `roundUsd(...)` before the final division. For
// tiny but canonical quantities (>= 1e-12, the allowed 12-decimal minimum
// above QUANTITY_EPSILON), the weighted numerator rounds to zero, so a factual
// positive execution price was published as average price 0 while the
// canonical Paper position cost basis remained 1.
//
// Probes (all against the real PaperAccountLedger, canonical fill input):
//   (1) open 1e-12 @ 1:        lifecycle average entry === ledger average entry (1), never 0.
//   (2) closed tiny trade:     buy 1e-12 @ 1, sell 1e-12 @ 2 — average entry/exit retain 1/2.
//   (3) tiny same-side scale-in: buy 1e-12 @ 1, buy 1e-12 @ 2 — weighted average entry is a
//       factual, deterministic 1.5, never 0.

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { computeTradeLifecycle } from '../../src/accounting/trade-lifecycle';
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

function build(config: PaperAccountConfig, fills: readonly PaperFill[]): {
  account: PaperAccountSnapshot;
  fills: readonly PaperFillLedgerEntry[];
  ledger: PaperAccountLedger;
} {
  const ledger = new PaperAccountLedger(config);
  for (const f of fills) ledger.applyFill(f);
  return {
    account: ledger.snapshot(),
    fills: ledger.entries().filter((e) => e.type === 'fill') as PaperFillLedgerEntry[],
    ledger,
  };
}

describe('Phase 6B Repair 4 — tiny-quantity weighted-average precision', () => {
  it('open 1e-12 @ 1: lifecycle average entry equals ledger average entry (1), never 0', () => {
    const { account, fills } = build(makeConfig('r4-open'), [makeFill('f1', 'buy', 1e-12, 1, { executedAt: 1 })]);
    assert.strictEqual(account.positions.length, 1);
    assert.strictEqual(account.positions[0].averageEntryPriceUsd, 1);

    const s = computeTradeLifecycle({ account, fills });
    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.entryQuantity, 1e-12);
    // The bug published 0 here; the factual canonical cost basis is 1.
    assert.strictEqual(t.averageEntryPriceUsd, account.positions[0].averageEntryPriceUsd);
    assert.strictEqual(t.averageEntryPriceUsd, 1);
  });

  it('closed tiny trade: average entry/exit retain factual execution prices (1 and 2)', () => {
    const { account, fills } = build(makeConfig('r4-closed'), [
      makeFill('f1', 'buy', 1e-12, 1, { executedAt: 1 }),
      makeFill('f2', 'sell', 1e-12, 2, { executedAt: 2 }),
    ]);
    assert.strictEqual(account.positions.length, 0);

    const s = computeTradeLifecycle({ account, fills });
    assert.strictEqual(s.trades.length, 1);
    const t = s.trades[0];
    assert.strictEqual(t.status, 'closed');
    assert.strictEqual(t.entryQuantity, 1e-12);
    assert.strictEqual(t.exitQuantity, 1e-12);
    assert.strictEqual(t.averageEntryPriceUsd, 1);
    assert.strictEqual(t.averageExitPriceUsd, 2);
  });

  it('tiny same-side scale-in @ different prices: weighted average entry is factual and deterministic (1.5)', () => {
    const fills = [
      makeFill('f1', 'buy', 1e-12, 1, { executedAt: 1 }),
      makeFill('f2', 'buy', 1e-12, 2, { executedAt: 2 }),
    ];
    const { account, fills: entries } = build(makeConfig('r4-scalein'), fills);
    assert.strictEqual(account.positions.length, 1);
    // Canonical ledger weighted-average cost basis = (1e-12*1 + 1e-12*2) / 2e-12 = 1.5.
    assert.strictEqual(account.positions[0].averageEntryPriceUsd, 1.5);

    const s = computeTradeLifecycle({ account, fills: entries });
    const t = s.trades[0];
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.entryQuantity, 2e-12);
    assert.strictEqual(t.averageEntryPriceUsd, 1.5);

    // Determinism: recomputation from identical canonical facts is identical.
    const s2 = computeTradeLifecycle({ account, fills: entries });
    assert.strictEqual(s2.trades[0].averageEntryPriceUsd, 1.5);
    assert.strictEqual(s2.trades[0].tradeId, t.tradeId);
  });
});
