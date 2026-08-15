// Phase 6B: Trade Lifecycle — pure, deterministic, fail-closed projection.
//
// Inputs (all explicit, gathered at the nondeterministic read boundary):
//   - PaperAccountSnapshot (durable economic facts)
//   - PaperFillLedgerEntry[] (durable fill entries, ordered by ledger sequence)
//
// Invariants:
//   - Ledger `sequence`, NOT timestamp or fill ID, is the lifecycle ordering
//     authority. The function never sorts fills: it rejects duplicate,
//     non-increasing, or non-positive sequences. Gaps (marks between fills) are
//     allowed. Same-timestamp fills remain sequence-sensitive.
//   - One trade incarnation per flat -> open -> ... -> flat/reversal cycle.
//   - A reversal fill appears in two adjacent incarnations only through
//     non-overlapping attributed legs whose quantities and fees sum exactly to
//     the canonical fill values (deterministic residual rule).
//   - Reconciliation is fail-closed: allocated fees must equal canonical total
//     fees, and aggregate gross-realized minus allocated fees must equal
//     canonical realized PnL, within the existing accounting epsilon.
//
// No network, no LLM, no execution, no storage writes, no Date.now, no
// randomness. Identical inputs produce an identical deeply-frozen snapshot.
// Caller-owned inputs are never mutated or frozen.

import type { PaperAccountSnapshot, PaperFillLedgerEntry } from '../types/paper-account';
import type { PaperFill } from '../types/paper-fill';
import { roundUsd, roundQuantity, ACCOUNTING_EPSILON } from '../paper/PaperLedgerMath';
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeLifecycle, TradeIncarnation, AttributedLeg } from './trade-lifecycle-types';

// ─── Domain errors ──────────────────────────────────────────────────────────

export class TradeLifecycleError extends Error {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleError'; }
}
/** Duplicate, non-increasing, or non-positive ledger sequence. */
export class TradeLifecycleSequenceError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleSequenceError'; }
}
/** Fill exchange does not match the account snapshot's exchange. */
export class TradeLifecycleExchangeMismatchError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleExchangeMismatchError'; }
}
/** Projection does not reconcile with canonical account facts. */
export class TradeLifecycleReconciliationError extends TradeLifecycleError {
  constructor(message: string) { super(message); this.name = 'TradeLifecycleReconciliationError'; }
}

export interface TradeLifecycleInput {
  account: PaperAccountSnapshot;
  fills: readonly PaperFillLedgerEntry[];
}

const WIN_ONLY_PROFIT_FACTOR_SENTINEL = 1_000_000;

function positionKey(exchange: string, symbol: string): string {
  return `${exchange}\u0000${symbol}`;
}

function makeTradeId(accountId: string, exchange: ExchangeId, symbol: string, openingSequence: number, openingFillId: string): string {
  return [accountId, exchange, symbol, String(openingSequence), openingFillId].join('|');
}

function makeLeg(fill: PaperFill, sequence: number, attributedQuantity: number, allocatedFeeUsd: number): AttributedLeg {
  const leg: AttributedLeg = {
    fillId: fill.fillId,
    sequence,
    exchange: fill.exchange,
    symbol: fill.symbol,
    side: fill.side,
    attributedQuantity: roundQuantity(attributedQuantity),
    priceUsd: fill.priceUsd,
    executedAt: fill.executedAt,
    allocatedFeeUsd: roundUsd(allocatedFeeUsd),
  };
  // Preserve absence for legacy/generic fills — optional correlation is only
  // present when the source fill carried it.
  if (fill.sourceOrderId !== undefined) (leg as any).sourceOrderId = fill.sourceOrderId;
  if (fill.sourceIntentId !== undefined) (leg as any).sourceIntentId = fill.sourceIntentId;
  return Object.freeze(leg);
}

interface IncState {
  exchange: ExchangeId;
  symbol: string;
  side: 'long' | 'short';
  /** Current open signed quantity (positive = long, negative = short). */
  signedQuantity: number;
  entryQuantity: number;
  exitQuantity: number;
  averageEntryPriceUsd: number;
  grossRealizedPnlUsd: number;
  /** Sum of all leg fees attributed to this incarnation. */
  allocatedFeesUsd: number;
  openedAt: number;
  lastExitAt: number;
  exitPriceWeighted: number;
  openingSequence: number;
  openingFillId: string;
  closed: boolean;
  legs: AttributedLeg[];
}

function newIncarnation(fill: PaperFill, sequence: number, side: 'long' | 'short', signedQuantity: number, entryFeeUsd: number): IncState {
  return {
    exchange: fill.exchange,
    symbol: fill.symbol,
    side,
    signedQuantity: roundQuantity(signedQuantity),
    entryQuantity: roundQuantity(Math.abs(signedQuantity)),
    exitQuantity: 0,
    averageEntryPriceUsd: roundUsd(fill.priceUsd),
    grossRealizedPnlUsd: 0,
    allocatedFeesUsd: roundUsd(entryFeeUsd),
    openedAt: fill.executedAt,
    lastExitAt: 0,
    exitPriceWeighted: 0,
    openingSequence: sequence,
    openingFillId: fill.fillId,
    closed: false,
    legs: [makeLeg(fill, sequence, Math.abs(signedQuantity), entryFeeUsd)],
  };
}

/** Python `standard_profit_factor` semantics over closed-trade net PnL amounts. */
function standardProfitFactor(netPnls: readonly number[]): number {
  if (netPnls.length === 0) return 0.0;
  let wins = 0;
  let losses = 0;
  for (const n of netPnls) {
    if (n > 0) wins += n;
    else if (n < 0) losses += Math.abs(n);
  }
  if (wins === 0) return 0.0;              // loss-only or all break-even
  if (losses === 0) return WIN_ONLY_PROFIT_FACTOR_SENTINEL; // win-only
  return wins / losses;
}

export function computeTradeLifecycle(input: TradeLifecycleInput): TradeLifecycle {
  const { account } = input;
  const fills = input.fills;

  const openByKey = new Map<string, IncState>();
  const incarnations: IncState[] = [];

  let prevSequence = 0;
  for (const entry of fills) {
    const sequence = entry.sequence;
    if (!Number.isInteger(sequence) || sequence <= 0) {
      throw new TradeLifecycleSequenceError(`ledger sequence must be a positive integer, got ${sequence}`);
    }
    if (sequence <= prevSequence) {
      throw new TradeLifecycleSequenceError(`non-increasing ledger sequence: ${sequence} after ${prevSequence}`);
    }
    prevSequence = sequence;

    const fill = entry.fill;
    if (fill.exchange !== account.exchange) {
      throw new TradeLifecycleExchangeMismatchError(
        `fill exchange ${fill.exchange} does not match account exchange ${account.exchange}`,
      );
    }

    const key = positionKey(fill.exchange, fill.symbol);
    const state = openByKey.get(key) ?? null;

    if (state === null) {
      // Fresh open.
      const side: 'long' | 'short' = fill.side === 'buy' ? 'long' : 'short';
      const signed = side === 'long' ? fill.quantity : -fill.quantity;
      openByKey.set(key, newIncarnation(fill, sequence, side, signed, fill.feeUsd));
      continue;
    }

    const sameSide = (fill.side === 'buy') === (state.side === 'long');
    if (sameSide) {
      // Scale-in: widen position, re-average entry, accumulate entry fee.
      const oldAbs = Math.abs(state.signedQuantity);
      const newAbs = oldAbs + fill.quantity;
      state.averageEntryPriceUsd = roundUsd(
        (oldAbs * state.averageEntryPriceUsd + fill.quantity * fill.priceUsd) / newAbs,
      );
      state.signedQuantity = roundQuantity(state.side === 'long' ? newAbs : -newAbs);
      state.entryQuantity = roundQuantity(state.entryQuantity + fill.quantity);
      state.allocatedFeesUsd = roundUsd(state.allocatedFeesUsd + fill.feeUsd);
      state.legs.push(makeLeg(fill, sequence, fill.quantity, fill.feeUsd));
      continue;
    }

    // Opposite side: close and/or reverse.
    const oldAbs = Math.abs(state.signedQuantity);
    const qty = fill.quantity;
    const closeQty = Math.min(qty, oldAbs);

    const gross = state.side === 'long'
      ? (fill.priceUsd - state.averageEntryPriceUsd) * closeQty
      : (state.averageEntryPriceUsd - fill.priceUsd) * closeQty;
    state.grossRealizedPnlUsd = roundUsd(state.grossRealizedPnlUsd + gross);
    state.exitQuantity = roundQuantity(state.exitQuantity + closeQty);
    state.exitPriceWeighted = roundUsd(state.exitPriceWeighted + fill.priceUsd * closeQty);
    state.lastExitAt = fill.executedAt;

    // Deterministic residual rule for the fill-fee split across legs.
    const closeLegFee = qty <= oldAbs ? fill.feeUsd : roundUsd(fill.feeUsd * (oldAbs / qty));
    state.allocatedFeesUsd = roundUsd(state.allocatedFeesUsd + closeLegFee);
    state.legs.push(makeLeg(fill, sequence, closeQty, closeLegFee));

    if (qty < oldAbs) {
      // Partial close: position remains.
      const rem = roundQuantity(oldAbs - qty);
      state.signedQuantity = roundQuantity(state.side === 'long' ? rem : -rem);
    } else if (qty === oldAbs) {
      // Exact flatten.
      state.closed = true;
      openByKey.delete(key);
      incarnations.push(state);
    } else {
      // Reversal: close current, open the residual as a new opposite-side trade.
      state.closed = true;
      openByKey.delete(key);
      incarnations.push(state);

      const newQty = roundQuantity(qty - oldAbs);
      const newSide: 'long' | 'short' = state.side === 'long' ? 'short' : 'long';
      const residualEntryFee = roundUsd(fill.feeUsd - closeLegFee); // residual rule
      const fresh = newIncarnation(fill, sequence, newSide, newSide === 'long' ? newQty : -newQty, residualEntryFee);
      openByKey.set(key, fresh);
    }
  }

  // Remaining open residuals, in deterministic ledger-order of opening.
  for (const [, state] of openByKey) incarnations.push(state);

  const trades: TradeIncarnation[] = incarnations
    .sort((a, b) => a.openingSequence - b.openingSequence)
    .map((st) => {
      const closed = st.closed;
      const averageExitPriceUsd = st.exitQuantity > 0
        ? roundUsd(st.exitPriceWeighted / st.exitQuantity)
        : null;
      return Object.freeze({
        tradeId: makeTradeId(account.accountId, st.exchange, st.symbol, st.openingSequence, st.openingFillId),
        exchange: st.exchange,
        symbol: st.symbol,
        side: st.side,
        status: closed ? 'closed' : 'open',
        entryQuantity: st.entryQuantity,
        exitQuantity: st.exitQuantity,
        openQuantity: roundQuantity(st.entryQuantity - st.exitQuantity),
        averageEntryPriceUsd: st.averageEntryPriceUsd,
        averageExitPriceUsd,
        grossRealizedPnlUsd: st.grossRealizedPnlUsd,
        allocatedFeesUsd: st.allocatedFeesUsd,
        netPnlUsd: roundUsd(st.grossRealizedPnlUsd - st.allocatedFeesUsd),
        openedAt: st.openedAt,
        closedAt: closed ? st.lastExitAt : null,
        holdingDurationMs: closed ? st.lastExitAt - st.openedAt : null,
        legs: Object.freeze(st.legs),
      } satisfies TradeIncarnation);
    });

  // Aggregates (computed from the projection — never copied blindly).
  const grossRealizedPnlUsd = roundUsd(trades.reduce((s, t) => s + t.grossRealizedPnlUsd, 0));
  const allocatedFeesUsd = roundUsd(trades.reduce((s, t) => s + t.allocatedFeesUsd, 0));
  const netPnlUsd = roundUsd(grossRealizedPnlUsd - allocatedFeesUsd);

  // Fail-closed reconciliation against canonical account facts.
  if (Math.abs(allocatedFeesUsd - account.totalFeesUsd) > ACCOUNTING_EPSILON) {
    throw new TradeLifecycleReconciliationError(
      `allocated fees ${allocatedFeesUsd} != canonical totalFeesUsd ${account.totalFeesUsd}`,
    );
  }
  if (Math.abs(netPnlUsd - account.realizedPnlUsd) > ACCOUNTING_EPSILON) {
    throw new TradeLifecycleReconciliationError(
      `projected realized ${netPnlUsd} != canonical realizedPnlUsd ${account.realizedPnlUsd}`,
    );
  }

  // Closed-trade summary (completed incarnations only).
  const closedTrades = trades.filter((t) => t.status === 'closed');
  let winningTrades = 0;
  let losingTrades = 0;
  let breakEvenTrades = 0;
  for (const t of closedTrades) {
    if (t.netPnlUsd > 0) winningTrades += 1;
    else if (t.netPnlUsd < 0) losingTrades += 1;
    else breakEvenTrades += 1;
  }
  const profitFactor = standardProfitFactor(closedTrades.map((t) => t.netPnlUsd));

  return Object.freeze({
    accountId: account.accountId,
    exchange: account.exchange,
    sourceLedgerSequence: account.sequence,
    sourceLedgerUpdatedAt: account.updatedAt,
    trades: Object.freeze(trades),
    grossRealizedPnlUsd,
    totalFeesUsd: account.totalFeesUsd,
    realizedPnlUsd: account.realizedPnlUsd,
    netPnlUsd,
    closedTrades: closedTrades.length,
    winningTrades,
    losingTrades,
    breakEvenTrades,
    profitFactor,
  } satisfies TradeLifecycle);
}
