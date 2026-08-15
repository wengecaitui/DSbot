// Phase 6B: Trade Lifecycle — pure, deterministic projection.
//
// Inputs (all explicit, gathered at the nondeterministic read boundary):
//   - PaperAccountSnapshot (durable economic facts)
//   - PaperFillLedgerEntry[] (durable fill entries, ordered by ledger sequence)
//
// No network, no LLM, no execution, no storage writes, no Date.now, no randomness.
// Identical inputs produce an identical snapshot. Trade/position ordering is
// deterministic. The result is deeply frozen.

import type { PaperAccountSnapshot, PaperFillLedgerEntry } from '../types/paper-account';
import { roundUsd } from '../paper/PaperLedgerMath';
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeLifecycle, ClosedTrade, OpenPosition } from './trade-lifecycle-types';

export interface TradeLifecycleInput {
  account: PaperAccountSnapshot;
  fills: readonly PaperFillLedgerEntry[];
}

function positionKey(exchange: string, symbol: string): string {
  return `${exchange}\u0000${symbol}`;
}

// Running open-position state while replaying fills.
interface OpenState {
  exchange: ExchangeId;
  symbol: string;
  side: 'long' | 'short';
  /** Signed quantity: positive = long, negative = short. */
  signedQuantity: number;
  averageEntryPriceUsd: number;
  /** Entry fee (and reversal-leg share) not yet realized. */
  deferredFeeUsd: number;
  openedAt: number;
}

export function computeTradeLifecycle(input: TradeLifecycleInput): TradeLifecycle {
  const { account } = input;
  const fills = [...input.fills].sort((a, b) => a.sequence - b.sequence);

  const openByKey = new Map<string, OpenState>();
  const trades: ClosedTrade[] = [];

  for (const entry of fills) {
    const fill = entry.fill;
    const key = positionKey(fill.exchange, fill.symbol);
    const state = openByKey.get(key) ?? null;

    if (state === null) {
      // Opening a fresh position.
      const side = fill.side === 'buy' ? 'long' as const : 'short' as const;
      openByKey.set(key, {
        exchange: fill.exchange,
        symbol: fill.symbol,
        side,
        signedQuantity: side === 'long' ? fill.quantity : -fill.quantity,
        averageEntryPriceUsd: fill.priceUsd,
        deferredFeeUsd: fill.feeUsd,
        openedAt: fill.executedAt,
      });
      continue;
    }

    const sameDirection = (fill.side === 'buy') === (state.side === 'long');
    if (sameDirection) {
      // Scale-in: widen the position, re-average entry, accumulate deferred fee.
      const oldAbs = Math.abs(state.signedQuantity);
      const newAbs = oldAbs + fill.quantity;
      state.averageEntryPriceUsd = roundUsd(
        (oldAbs * state.averageEntryPriceUsd + fill.quantity * fill.priceUsd) / newAbs,
      );
      state.signedQuantity = state.side === 'long' ? newAbs : -newAbs;
      state.deferredFeeUsd = roundUsd(state.deferredFeeUsd + fill.feeUsd);
      continue;
    }

    // Opposite direction: close and/or reverse.
    const oldAbs = Math.abs(state.signedQuantity);
    const qty = fill.quantity;
    const closeQty = Math.min(qty, oldAbs);

    const grossPnl = roundUsd(
      state.side === 'long'
        ? (fill.priceUsd - state.averageEntryPriceUsd) * closeQty
        : (state.averageEntryPriceUsd - fill.priceUsd) * closeQty,
    );
    // Entry fee released proportionally to the closed quantity.
    const entryFeeShare = roundUsd(state.deferredFeeUsd * (closeQty / oldAbs));
    // Exit fee share: whole when the fill is fully consumed; proportional on reversal.
    const exitFeeShare = roundUsd(fill.feeUsd * (closeQty / qty));
    const feeUsd = roundUsd(entryFeeShare + exitFeeShare);

    trades.push(Object.freeze({
      exchange: fill.exchange,
      symbol: fill.symbol,
      side: state.side,
      closedQuantity: closeQty,
      averageEntryPriceUsd: state.averageEntryPriceUsd,
      averageExitPriceUsd: fill.priceUsd,
      grossPnlUsd: grossPnl,
      feeUsd,
      netPnlUsd: roundUsd(grossPnl - feeUsd),
      openedAt: state.openedAt,
      closedAt: fill.executedAt,
      holdingDurationMs: fill.executedAt - state.openedAt,
    } satisfies ClosedTrade));

    if (qty < oldAbs) {
      // Partial close: position remains; release the proportional entry fee share.
      state.signedQuantity = state.side === 'long' ? oldAbs - qty : -(oldAbs - qty);
      state.deferredFeeUsd = roundUsd(state.deferredFeeUsd - entryFeeShare);
    } else if (qty === oldAbs) {
      // Exact close: position flat.
      openByKey.delete(key);
    } else {
      // Reversal: excess opens a fresh position in the opposite direction, carrying
      // the proportional share of this fill's fee as its deferred entry fee.
      const newQty = qty - oldAbs;
      const newSide = state.side === 'long' ? 'short' as const : 'long' as const;
      openByKey.set(key, {
        exchange: fill.exchange,
        symbol: fill.symbol,
        side: newSide,
        signedQuantity: newSide === 'long' ? newQty : -newQty,
        averageEntryPriceUsd: fill.priceUsd,
        deferredFeeUsd: roundUsd(fill.feeUsd * (newQty / qty)),
        openedAt: fill.executedAt,
      });
    }
  }

  // Open residuals, deterministically ordered by exchange+symbol.
  const openPositions: OpenPosition[] = [...openByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, state]) => Object.freeze({
      exchange: state.exchange,
      symbol: state.symbol,
      side: state.side,
      signedQuantity: state.signedQuantity,
      averageEntryPriceUsd: state.averageEntryPriceUsd,
      deferredFeeUsd: state.deferredFeeUsd,
      openedAt: state.openedAt,
    } satisfies OpenPosition));

  // Aggregates. Canonical durable facts come straight from the account snapshot;
  // gross/net are the projection over the decomposed trades.
  const grossPnlUsd = roundUsd(trades.reduce((s, t) => s + t.grossPnlUsd, 0));
  const totalFeesUsd = account.totalFeesUsd;
  const realizedPnlUsd = account.realizedPnlUsd;
  const deferredFeeSum = roundUsd(openPositions.reduce((s, p) => s + p.deferredFeeUsd, 0));
  const netPnlUsd = roundUsd(realizedPnlUsd + deferredFeeSum);

  let winningTrades = 0;
  let losingTrades = 0;
  let breakEvenTrades = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.netPnlUsd > 0) { winningTrades += 1; grossWin += t.netPnlUsd; }
    else if (t.netPnlUsd < 0) { losingTrades += 1; grossLoss += Math.abs(t.netPnlUsd); }
    else breakEvenTrades += 1;
  }
  grossWin = roundUsd(grossWin);
  grossLoss = roundUsd(grossLoss);

  let profitFactor: number | null;
  if (trades.length === 0) profitFactor = null;
  else if (grossLoss === 0) profitFactor = 1_000_000;
  else if (grossWin === 0) profitFactor = 0;
  else profitFactor = grossWin / grossLoss;

  return Object.freeze({
    accountId: account.accountId,
    exchange: account.exchange,
    sourceLedgerSequence: account.sequence,
    sourceLedgerUpdatedAt: account.updatedAt,
    trades: Object.freeze(trades),
    openPositions: Object.freeze(openPositions),
    grossPnlUsd,
    totalFeesUsd,
    realizedPnlUsd,
    netPnlUsd,
    winningTrades,
    losingTrades,
    breakEvenTrades,
    profitFactor,
  } satisfies TradeLifecycle);
}
