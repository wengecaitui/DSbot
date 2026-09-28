// Phase G8H1: Gate.io Live accounting read-model — explicit types.
//
// This is a DERIVED READ MODEL over existing factual sources. It owns no exchange truth, no position
// authority, no OMS authority, no execution authority and no Risk admission authority: it only projects
// facts that already exist into one immutable, deterministic snapshot. Nothing here flows back into
// execution, and it must never be mistaken for autonomous-risk authority.
//
// Missing facts are NEVER encoded as numeric zero. Each fact carries an explicit completeness status.
import type { GateIoCanonicalAccountTruth, GateIoCanonicalInstrumentFacts } from '../runtime/gateio/GateIoAuthenticatedReadFoundation';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';

/** COMPLETE: every field of this fact came from a factual source. INCOMPLETE: some field is null/unknown.
 *  UNAVAILABLE: no factual source exists at all for this fact in the current repository. */
export type AccountingCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';

/** Fee amounts are correlated to executions, but Gate's cashflow convention is not proven by any repository
 *  or balance evidence yet (G8H0: FEE_SIGN_SEMANTICS_PROVEN=false), so a fee cashflow value is never emitted. */
export type FeeCashflowSemanticsStatus = 'UNPROVEN';

export type GateIoLiveAction = 'open' | 'close' | 'reduce' | 'emergency_exit';

/** One factual Gate position leg, projected without reinterpretation. */
export interface GateIoLivePositionFact {
  readonly contract: string;
  readonly mode: string;
  readonly signedSize: number;
  /** Only derivable when valid instrument facts are supplied; never guessed from a ticker. */
  readonly signedBaseQuantity: number | null;
  readonly baseQuantityStatus: AccountingCompleteness;
  /** Factual Gate quote-value exposure witness (F-09: size alone can be zero after decimal fills). */
  readonly quoteValue: number;
  readonly entryPrice: number | null;
  readonly markPrice: number | null;
  readonly realizedPnl: number | null;
  readonly unrealizedPnl: number | null;
  readonly updatedAt: number;
}

/** Exact order lineage rebuilt from kernel events (orderId correlation only, never fuzzy). */
export interface GateIoLiveOrderLineage {
  readonly orderId: string;
  readonly intentId: string | null;
  readonly action: GateIoLiveAction;
  readonly side: 'buy' | 'sell';
  readonly approvedNotionalUsd: number | null;
  readonly submitted: boolean;
  readonly rejected: boolean;
  readonly rejectionReason: string | null;
  readonly submissionUnknown: boolean;
  readonly prepared: boolean;
  readonly reduceOnly: boolean | null;
  readonly venueQuantity: number | null;
  readonly requestedQuantity: number | null;
  /** Gate order identity used for exact trade correlation; null when no execution observation exists. */
  readonly exchangeOrderId: string | null;
  readonly fillIds: readonly string[];
}

/** One confirmed fill, projected with its exact order linkage. */
export interface GateIoLiveFillFact {
  readonly fillId: string;
  readonly orderId: string;
  readonly intentId: string | null;
  readonly action: GateIoLiveAction;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly price: number;
  readonly executedAt: number;
  readonly reduceOnly: boolean | null;
  readonly exchangeOrderId: string | null;
}

/** Raw Gate trade facts, attributed to an action only through exact order identity. */
export interface GateIoLiveTradeFact {
  readonly tradeId: string;
  readonly orderId: string;
  readonly signedSize: number;
  readonly price: number;
  readonly fee: number;
  readonly pointFee: number;
  readonly role: 'maker' | 'taker';
  readonly createdAtMs: number;
  /** Action of the OMS order this trade was exactly correlated to; null when unmatched. */
  readonly correlatedAction: GateIoLiveAction | null;
}

export interface GateIoLiveFeeAttribution {
  readonly status: AccountingCompleteness;
  readonly cashflowSemantics: FeeCashflowSemanticsStatus;
  /** Factual arithmetic sum over trades correlated to this journal's executions; null when not fully correlated. */
  readonly rawFeeSum: number | null;
  readonly rawPointFeeSum: number | null;
  /** Always null in G8H1: sign/cashflow semantics are unproven, so no cashflow value may be published. */
  readonly feeCashflowUsd: null;
  readonly attributedTradeCount: number;
  readonly unmatchedTradeCount: number;
  readonly unattributedFillCount: number;
}

export interface GateIoLiveAccountingInput {
  /** Explicit capture time — never read from an ambient clock. */
  readonly capturedAt: number;
  readonly accountTruth: GateIoCanonicalAccountTruth;
  /** Optional: only needed for signed base quantity derivation. */
  readonly instrumentFacts?: GateIoCanonicalInstrumentFacts | null;
  /** Kernel events of the durable journal (read-only; never mutated). */
  readonly events: readonly KernelEventEnvelope[];
}

export interface GateIoLiveAccountingSnapshot {
  // identity
  readonly exchange: 'gateio';
  readonly accountId: string;

  // source lineage
  readonly capturedAt: number;
  readonly accountObservedAt: number;
  readonly accountServerTimeMs: number;
  readonly accountTruthSource: string;
  readonly accountFreshness: string;
  readonly journalLastSequence: number | null;
  readonly journalLastEventId: string | null;

  // account facts
  readonly accountTotalUsd: number;
  readonly availableBalanceUsd: number;
  readonly accountUnrealizedPnlUsd: number | null;
  readonly accountUnrealizedPnlStatus: AccountingCompleteness;
  readonly positionMode: string | null;
  readonly accountState: 'FLAT' | 'OPEN';
  readonly openOrderCount: number;

  // position facts
  readonly positions: readonly GateIoLivePositionFact[];
  readonly positionCount: number;

  // exposure (derived from factual Gate quoteValue)
  readonly grossExposureUsd: number;
  readonly netExposureUsd: number;

  // realized-PnL semantics: observed facts only, never promoted to durable account PnL
  readonly observedPositionRealizedPnlUsd: number | null;
  readonly observedPositionRealizedPnlStatus: AccountingCompleteness;
  readonly dailyRealizedPnlUsd: null;
  readonly dailyRealizedPnlStatus: AccountingCompleteness;
  readonly lifetimeRealizedPnlUsd: null;
  readonly lifetimeRealizedPnlStatus: AccountingCompleteness;

  // execution lineage
  readonly confirmedFillCount: number;
  readonly orders: readonly GateIoLiveOrderLineage[];
  readonly fills: readonly GateIoLiveFillFact[];
  readonly executionLineageStatus: AccountingCompleteness;
  readonly executionLineageDurability: AccountingCompleteness;

  // exact trade / fee correlation
  readonly trades: readonly GateIoLiveTradeFact[];
  readonly tradedGateOrderIds: readonly string[];
  readonly fees: GateIoLiveFeeAttribution;

  // gross execution PnL (fees and funding never subtracted)
  readonly grossTradingPnlUsd: number | null;
  readonly grossTradingPnlStatus: AccountingCompleteness;

  // funding
  readonly currentFundingRateMetadata: number | null;
  readonly fundingPaymentStatus: AccountingCompleteness;
  readonly fundingPaymentUsd: null;

  // slippage
  readonly slippageStatus: AccountingCompleteness;
  readonly totalObservedSlippageUsd: null;

  // risk history
  readonly dailyRealizedLossUsd: null;
  readonly dailyRealizedLossStatus: AccountingCompleteness;
  readonly dailyTotalLossUsd: null;
  readonly dailyTotalLossStatus: AccountingCompleteness;
  readonly highWaterAccountTotalUsd: null;
  readonly highWaterStatus: AccountingCompleteness;
  readonly drawdownUsd: null;
  readonly drawdownPct: null;
  readonly drawdownStatus: AccountingCompleteness;

  // durability (reported separately: the account observation is ephemeral, execution lineage is durable)
  readonly accountSnapshotDurability: AccountingCompleteness;
  readonly riskHistoryDurability: AccountingCompleteness;

  // autonomous risk gate — literal false for the current source set, never configurable
  readonly autonomousRiskReady: false;
  readonly autonomousRiskBlockers: readonly string[];
}

/** Every source that is still missing for autonomous risk. Order is stable and part of the contract. */
export const GATEIO_LIVE_ACCOUNTING_AUTONOMOUS_RISK_BLOCKERS = Object.freeze([
  'FUNDING_PAYMENT_HISTORY_UNAVAILABLE',
  'FEE_CASHFLOW_SEMANTICS_UNPROVEN',
  'DAILY_LOSS_HISTORY_UNAVAILABLE',
  'HIGH_WATER_HISTORY_UNAVAILABLE',
  'DRAWDOWN_HISTORY_UNAVAILABLE',
  'LIVE_ACCOUNT_SNAPSHOT_NOT_DURABLE',
] as const);
