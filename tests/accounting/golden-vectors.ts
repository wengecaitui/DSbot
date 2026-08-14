// Phase 6A: Runtime Accounting golden vectors — static, checked-in expected values.
//
// Encodes Stage5R1-compatible economic semantics (LINEAR USDT, adverse slippage,
// fee = notional * bps, LONG/SHORT PnL direction), with the TypeScript Paper
// ledger's own USD/quantity rounding. Python is reference/proof only — never runtime.

import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { PaperFill } from '../../src/types/paper-fill';

export interface GoldenVector {
  name: string;
  initialCashUsd: number;
  fills: readonly PaperFill[];
  expected: {
    realizedPnlUsd: number;
    cashUsd: number;
    totalFeesUsd: number;
    totalObservedSlippageUsd: number;
  };
}

const EXCHANGE: ExchangeId = 'bitget';

function fill(id: string, side: 'buy' | 'sell', quantity: number, priceUsd: number, feeUsd: number, ref: number, executedAt: number): PaperFill {
  return { fillId: id, exchange: EXCHANGE, symbol: 'BTC/USDT', side, quantity, priceUsd, feeUsd, executedAt, executionReferencePriceUsd: ref };
}

export const GOLDEN_VECTORS: readonly GoldenVector[] = [
  {
    name: 'profitable long round trip',
    initialCashUsd: 100000,
    fills: [
      fill('g1-buy', 'buy', 2, 100.00, 0, 100.00, 1),
      fill('g1-sell', 'sell', 2, 120.00, 0, 120.00, 2),
    ],
    expected: { realizedPnlUsd: 40, cashUsd: 100040, totalFeesUsd: 0, totalObservedSlippageUsd: 0 },
  },
  {
    name: 'losing long round trip',
    initialCashUsd: 100000,
    fills: [
      fill('g2-buy', 'buy', 2, 100.00, 0, 100.00, 1),
      fill('g2-sell', 'sell', 2, 90.00, 0, 90.00, 2),
    ],
    expected: { realizedPnlUsd: -20, cashUsd: 99980, totalFeesUsd: 0, totalObservedSlippageUsd: 0 },
  },
  {
    name: 'profitable short round trip',
    initialCashUsd: 100000,
    fills: [
      fill('g3-sell', 'sell', 2, 100.00, 0, 100.00, 1),
      fill('g3-buy', 'buy', 2, 80.00, 0, 80.00, 2),
    ],
    expected: { realizedPnlUsd: 40, cashUsd: 100040, totalFeesUsd: 0, totalObservedSlippageUsd: 0 },
  },
  {
    name: 'losing short round trip',
    initialCashUsd: 100000,
    fills: [
      fill('g4-sell', 'sell', 2, 100.00, 0, 100.00, 1),
      fill('g4-buy', 'buy', 2, 120.00, 0, 120.00, 2),
    ],
    expected: { realizedPnlUsd: -40, cashUsd: 99960, totalFeesUsd: 0, totalObservedSlippageUsd: 0 },
  },
  {
    name: 'fee + slippage long round trip',
    initialCashUsd: 100000,
    fills: [
      // entry buy: paid 100.10 (adverse 0.10 over reference 100.00), fee 0.20
      fill('g5-buy', 'buy', 2, 100.10, 0.20, 100.00, 1),
      // exit sell: received 119.80 (adverse 0.20 under reference 120.00), fee 0.24
      fill('g5-sell', 'sell', 2, 119.80, 0.24, 120.00, 2),
    ],
    expected: { realizedPnlUsd: 38.96, cashUsd: 100038.96, totalFeesUsd: 0.44, totalObservedSlippageUsd: 0.60 },
  },
];
