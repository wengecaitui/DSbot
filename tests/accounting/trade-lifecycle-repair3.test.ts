// Phase 6B Repair 3 — timestamp provenance binding (three exact adversarial
// probes against a canonical one-fill open snapshot where fill.executedAt=100).
//   (1) account.updatedAt lowered to 0 must be rejected (fill executedAt=100 is
//       not bound by the ledger head).
//   (2) account.positions[0].openedAt lowered 100 -> 99 must be rejected (the
//       canonical position openedAt must equal the incarnation opening time).
//   (3) account.positions[0].updatedAt raised 100 -> 999 while
//       account.updatedAt=100 must be rejected (position updatedAt must be
//       >= last fill and <= account.updatedAt).

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeTradeLifecycle,
  TradeLifecycleTimestampProvenanceError,
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

function makeFill(id: string, side: 'buy' | 'sell', quantity: number, priceUsd: number, opts: { feeUsd?: number; executedAt?: number; symbol?: string } = {}): PaperFill {
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

/** Canonical one-fill open snapshot: buy 1 @ 100, fill.executedAt=100. */
function canonicalOpenSnapshot(accountId: string): { account: PaperAccountSnapshot; fills: readonly PaperFillLedgerEntry[] } {
  const ledger = new PaperAccountLedger(makeConfig(accountId));
  ledger.applyFill(makeFill('f1', 'buy', 1, 100, { executedAt: 100 }));
  return {
    account: ledger.snapshot(),
    fills: ledger.entries().filter((e) => e.type === 'fill') as PaperFillLedgerEntry[],
  };
}

describe('Phase 6B Repair 3 — timestamp provenance binding', () => {
  it('rejects account.updatedAt=0 beside a fill executed at 100 (ledger-head provenance)', () => {
    const { account, fills } = canonicalOpenSnapshot('prov-head');
    assert.strictEqual(account.updatedAt, 100);
    const tampered: PaperAccountSnapshot = { ...account, updatedAt: 0 };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleTimestampProvenanceError,
    );
  });

  it('rejects position openedAt=99 when the incarnation opened at 100 (openedAt binding)', () => {
    const { account, fills } = canonicalOpenSnapshot('prov-opened');
    assert.strictEqual(account.positions[0].openedAt, 100);
    const tampered: PaperAccountSnapshot = {
      ...account,
      positions: account.positions.map((p) => ({ ...p, openedAt: 99 })),
    };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecyclePositionReconciliationError,
    );
  });

  it('rejects position updatedAt=999 while account.updatedAt=100 (updatedAt upper bound)', () => {
    const { account, fills } = canonicalOpenSnapshot('prov-updated');
    assert.strictEqual(account.positions[0].updatedAt, 100);
    const tampered: PaperAccountSnapshot = {
      ...account,
      positions: account.positions.map((p) => ({ ...p, updatedAt: 999 })),
    };
    assert.throws(
      () => computeTradeLifecycle({ account: tampered, fills }),
      (e: any) => e instanceof TradeLifecycleTimestampProvenanceError,
    );
  });
});
