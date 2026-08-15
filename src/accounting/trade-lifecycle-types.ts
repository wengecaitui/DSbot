// Phase 6B: Trade Lifecycle — immutable read-model contract.
//
// Derived READ MODEL over the durable Paper ledger snapshot + durable fill
// entries (ordered by ledger sequence). Pure, deterministic projection of
// completed round-trip trades plus deterministic open residuals.
//
// This module owns NO mutable cash/position/PnL state. It is a pure projection.

import type { ExchangeId } from '../data/MarketIdentity';

// ─── Completed round-trip trade ─────────────────────────────────────────────

export interface ClosedTrade {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly closedQuantity: number;
  readonly averageEntryPriceUsd: number;
  readonly averageExitPriceUsd: number;
  readonly grossPnlUsd: number;
  readonly feeUsd: number;
  readonly netPnlUsd: number;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly holdingDurationMs: number;
}

// ─── Open residual position ─────────────────────────────────────────────────

export interface OpenPosition {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  /** Signed quantity: positive = long, negative = short. */
  readonly signedQuantity: number;
  readonly averageEntryPriceUsd: number;
  /** Entry fee (and, for a reversal residual, the proportional share of the
   *  reversal leg's fee) not yet realized — bridged back into netPnlUsd. */
  readonly deferredFeeUsd: number;
  readonly openedAt: number;
}

// ─── Lifecycle snapshot ─────────────────────────────────────────────────────

export interface TradeLifecycle {
  // Identity / lineage.
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly sourceLedgerSequence: number;
  readonly sourceLedgerUpdatedAt: number;

  // Decomposition.
  readonly trades: readonly ClosedTrade[];
  readonly openPositions: readonly OpenPosition[];

  // Aggregates. Reconciliation contract:
  //   realizedPnlUsd  === account.realizedPnlUsd
  //   totalFeesUsd    === account.totalFeesUsd
  //   realizedPnlUsd  === grossPnlUsd - totalFeesUsd        (always)
  //   sum(trade.feeUsd) + sum(open.deferredFeeUsd) === totalFeesUsd
  //   netPnlUsd       === realizedPnlUsd + sum(open.deferredFeeUsd)
  readonly grossPnlUsd: number;
  readonly totalFeesUsd: number;
  readonly realizedPnlUsd: number;
  readonly netPnlUsd: number;

  // Performance classification.
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly breakEvenTrades: number;
  /** Ratio of gross-winning-net to gross-losing-net. null when no closed
   *  trades; 1_000_000 sentinel when winning-only (no losses); 0 when
   *  loss-only. */
  readonly profitFactor: number | null;
}
