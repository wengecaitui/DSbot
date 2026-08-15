// Phase 6B: Trade Lifecycle — immutable read-model contract.
//
// Derived READ MODEL over the durable Paper ledger snapshot + durable fill
// entries (ordered by ledger sequence). Pure, deterministic projection of
// trade incarnations (flat -> open -> ... -> flat/reversal), their attributed
// fill-leg lineage, and reconciliation-verified aggregates.
//
// This module owns NO mutable cash/position/PnL state. It is a pure projection.

import type { ExchangeId } from '../data/MarketIdentity';

// ─── Attributed fill-leg lineage ────────────────────────────────────────────

/**
 * One attributed portion of a durable Paper fill on a trade incarnation.
 * A reversal fill appears in two adjacent incarnations only through two
 * non-overlapping legs whose attributedQuantity/allocatedFeeUsd sum exactly to
 * the canonical fill quantity/fee (deterministic residual rule).
 */
export interface AttributedLeg {
  readonly fillId: string;
  /** Durable ledger sequence of the source fill (the ordering authority). */
  readonly sequence: number;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  /** This leg's share of the source fill quantity. */
  readonly attributedQuantity: number;
  /** Execution price of the source fill. */
  readonly priceUsd: number;
  /** Execution time of the source fill. */
  readonly executedAt: number;
  /** This leg's share of the source fill fee. */
  readonly allocatedFeeUsd: number;
  /** Optional OMS execution correlation — ABSENT for legacy/generic fills. */
  readonly sourceOrderId?: string;
  readonly sourceIntentId?: string;
}

// ─── Trade incarnation ──────────────────────────────────────────────────────

/**
 * One trade incarnation: flat -> open -> ... -> flat/reversal.
 * Partial closes, scale-ins, and later closes remain in the SAME incarnation;
 * only an exact flatten or a reversal ends it (a reversal opens a new one).
 */
export interface TradeIncarnation {
  /** Deterministic ID from accountId + exchange + symbol + opening ledger
   *  sequence + opening fill identity. Same-price reopen yields a new ID. */
  readonly tradeId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly status: 'open' | 'closed';
  /** Total quantity opened (entry legs). */
  readonly entryQuantity: number;
  /** Total quantity closed (exit legs). */
  readonly exitQuantity: number;
  /** Remaining open quantity (entry - exit; 0 when closed). */
  readonly openQuantity: number;
  readonly averageEntryPriceUsd: number;
  /** Quantity-weighted average exit price; null when nothing closed yet. */
  readonly averageExitPriceUsd: number | null;
  /** Realized gross PnL from closed portions (slippage already observed). */
  readonly grossRealizedPnlUsd: number;
  /** Total fees attributed to this incarnation = sum(legs.allocatedFeeUsd). */
  readonly allocatedFeesUsd: number;
  /** Net economic PnL to date = grossRealizedPnlUsd - allocatedFeesUsd. */
  readonly netPnlUsd: number;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly holdingDurationMs: number | null;
  readonly legs: readonly AttributedLeg[];
}

// ─── Lifecycle snapshot ─────────────────────────────────────────────────────

export interface TradeLifecycle {
  // Identity / lineage.
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly sourceLedgerSequence: number;
  readonly sourceLedgerUpdatedAt: number;

  // Decomposition (all incarnations, deterministic order by opening sequence).
  readonly trades: readonly TradeIncarnation[];

  // Aggregates. Reconciliation contract (fail-closed, within accounting epsilon):
  //   sum(legs.allocatedFeeUsd)  === account.totalFeesUsd
  //   grossRealizedPnlUsd - totalFeesUsd === account.realizedPnlUsd === netPnlUsd
  readonly grossRealizedPnlUsd: number;
  readonly totalFeesUsd: number;
  readonly realizedPnlUsd: number;
  readonly netPnlUsd: number;

  // Closed-trade summary (completed incarnations only).
  readonly closedTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly breakEvenTrades: number;
  /** Python `standard_profit_factor` semantics: 0.0 for no trades, 0.0 for
   *  loss-only (no wins), 1_000_000 for win-only (no losses), otherwise
   *  grossWins / grossLosses on closed-trade net PnL. Never null. */
  readonly profitFactor: number;
}
