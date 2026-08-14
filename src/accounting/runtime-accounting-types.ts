// Phase 6A: Runtime Accounting — immutable read-model contract.
//
// Derived READ MODEL over the canonical factual sources:
//   - PaperAccountLedger / PaperExecutionService (durable economic facts)
//   - KernelMarketStateStore (current factual market marks)
//
// This module owns NO mutable cash/position/PnL state. It is a pure projection.

import type { ExchangeId } from '../data/MarketIdentity';

export type ValuationStatus = 'COMPLETE' | 'INCOMPLETE';
export type AttributionStatus = 'COMPLETE' | 'INCOMPLETE';

// ─── Per-position marked accounting ─────────────────────────────────────────

export interface RuntimePositionAccounting {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly signedQuantity: number;
  readonly averageEntryPriceUsd: number;
  // Current market valuation evidence — null when no usable current mark.
  readonly markPriceUsd: number | null;
  readonly marketSnapshotVersion: number | null;
  readonly marketLastUpdatedAt: number | null;
  readonly marketValueUsd: number | null;
  readonly unrealizedPnlUsd: number | null;
}

// ─── Execution cost attribution ─────────────────────────────────────────────

export interface FillSlippageEvidence {
  readonly fillId: string;
  readonly sourceOrderId?: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly executionReferencePriceUsd: number;
  readonly executedPriceUsd: number;
  readonly observedSlippageUsd: number;
}

export interface SlippageAttribution {
  /** COMPLETE only when every attributed fill has a factual reference price. */
  readonly status: AttributionStatus;
  /** null when INCOMPLETE — a known partial subtotal is exposed separately. */
  readonly totalObservedSlippageUsd: number | null;
  readonly partialObservedSlippageUsd: number;
  readonly attributedFills: readonly FillSlippageEvidence[];
  readonly unattributedFillCount: number;
}

export interface FeeAttribution {
  /** Canonical total from PaperAccountSnapshot.totalFeesUsd. */
  readonly totalFeesUsd: number;
  /** Sum of individual persisted fill fees. */
  readonly summedFillFeesUsd: number;
  /** true when summedFillFeesUsd reconciles with totalFeesUsd within epsilon. */
  readonly reconciled: boolean;
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

export interface RuntimeAccountingSnapshot {
  // Identity / lineage.
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly sourceLedgerSequence: number;
  readonly sourceLedgerUpdatedAt: number;
  readonly source: string;
  readonly capturedAt: number;

  // Durable account facts (from the canonical Paper snapshot).
  readonly initialCashUsd: number;
  readonly cashUsd: number;
  readonly realizedPnlUsd: number;
  readonly totalFeesUsd: number;
  readonly processedFills: number;

  // Current valuation. Aggregate market-dependent values are null when INCOMPLETE.
  readonly valuationStatus: ValuationStatus;
  readonly unrealizedPnlUsd: number | null;
  readonly equityUsd: number | null;
  readonly grossExposureUsd: number | null;
  readonly netExposureUsd: number | null;
  readonly openPositions: number;
  readonly positions: readonly RuntimePositionAccounting[];

  // Execution cost attribution.
  readonly fees: FeeAttribution;
  readonly slippage: SlippageAttribution;
}
