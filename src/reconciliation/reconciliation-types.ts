// Phase 5B: Reconciliation Contract — types, outcome taxonomy, and ports.
//
// Phase 5A answered: "What should local durable state be after restart?"
// Phase 5B answers:  "What does the broker/execution truth say actually exists
//                     now, and does it agree with recovered Kernel state?"
//
// The reconciliation is split into TWO boundaries:
//   1. Truth acquisition (NONDETERMINISTIC): ExecutionTruthPort.acquireTruth()
//      performs network/broker reads and stamps explicit capture metadata.
//   2. Comparison core (DETERMINISTIC / PURE): reconcile() performs no I/O,
//      no submission, no mutation, no Date.now, and no randomness. Every time
//      or source value it needs is explicit input.
//
// This task defines the contract ONLY. Automatic repair, fill insertion,
// position correction, order resend, cancel/replace, and real exchange
// adapters are OUT OF SCOPE.

import type { ExchangeId } from '../data/MarketIdentity';
import type { OmsOrderStatus } from '../oms/oms-types';

// ─── Identity ────────────────────────────────────────────────────────────────

export interface ReconciliationIdentity {
  readonly accountId: string;
  readonly exchange: ExchangeId;
}

// ─── External (broker/execution) truth ──────────────────────────────────────
// Read-only factual data acquired from the broker/execution layer. Deliberately
// exchange-agnostic — no Binance/Bitget-specific fields. A future PaperBroker /
// PaperExecutionService or a real exchange adapter implements the port and maps
// its native truth into these shapes.

export type ExternalOrderStatus =
  | 'OPEN' // broker holds the order, not yet filled
  | 'FILLED' // broker reports the order filled
  | 'CANCELLED' // broker reports the order cancelled
  | 'NOT_FOUND'; // broker has no record of this order id

export interface ExternalOrder {
  /** Broker-side order identifier. The port MUST map it into the same identity
   *  space as the local OMS orderId so the core can correlate them. */
  readonly orderId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  /** Ordered quantity (> 0). */
  readonly quantity: number;
  readonly status: ExternalOrderStatus;
  /** Filled quantity, 0..quantity. */
  readonly filledQuantity: number;
  /** Average fill price, or null when not filled. */
  readonly averageFillPrice: number | null;
  /** Explicit source timestamp (broker-reported). The core never reads Date.now(). */
  readonly updatedAt: number;
}

export interface ExternalFill {
  readonly fillId: string;
  /** Links the fill to an order. MUST correlate with the local OMS orderId. */
  readonly orderId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly price: number;
  readonly executedAt: number;
}

export interface ExternalPosition {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  /** Non-zero for open positions. */
  readonly signedQuantity: number;
  readonly averageEntryPrice: number;
  /** Explicit source timestamp. */
  readonly updatedAt: number;
}

export interface ExecutionTruthSnapshot {
  readonly identity: ReconciliationIdentity;
  readonly orders: readonly ExternalOrder[];
  readonly fills: readonly ExternalFill[];
  readonly positions: readonly ExternalPosition[];
  /** Explicit acquisition time (stamped by the port, not the core). */
  readonly capturedAt: number;
  /** Provenance label, e.g. 'paper-broker', 'bitget-rest'. */
  readonly source: string;
  /** When false, the core MUST return UNTRUSTED_STATE — external truth is
   *  incomplete, query-failed, or otherwise insufficient to establish MATCH. */
  readonly complete: boolean;
  readonly incompleteReason?: string;
}

// ─── Truth Port (nondeterministic acquisition boundary) ─────────────────────

export interface ExecutionTruthPort {
  acquireTruth(): Promise<ExecutionTruthSnapshot>;
}

// ─── Local (recovered Kernel) snapshot ──────────────────────────────────────
// Immutable, read-only projection of recovered local durable state.

export interface LocalOrder {
  readonly orderId: string;
  readonly intentId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly status: OmsOrderStatus;
  readonly fillId?: string;
  readonly orderVersion: number;
  readonly sourceKernelEventId: string;
}

export interface LocalPosition {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  /** Preserved factual semantics: missing != flat != open. */
  readonly status: 'missing' | 'flat' | 'open';
  readonly side: 'long' | 'short' | 'flat';
  readonly signedQuantity: number;
  readonly averageEntryPrice: number;
  readonly positionVersion: number;
  readonly sourceKernelEventId: string;
}

export interface LocalPlan {
  readonly planId: string;
  readonly exchange: string;
  readonly symbol: string;
  readonly positionSide: 'long' | 'short';
  readonly status: 'active' | 'closed' | 'archived';
  readonly entryPrice: number;
  readonly stopPrice: number;
}

export interface LocalReconciliationSnapshot {
  readonly identity: ReconciliationIdentity;
  readonly orders: readonly LocalOrder[];
  readonly positions: readonly LocalPosition[];
  readonly plans: readonly LocalPlan[];
}

// ─── Required read surface (recorded, NOT added) ────────────────────────────
// The comparison core consumes an immutable LocalReconciliationSnapshot. The
// stores currently expose point reads only; enumeration is MISSING and must be
// added by a later (read-only, non-mutating) stage before a live adapter can
// populate the snapshot:
//
//   OmsOrderStore          → list(): readonly OmsOrderSnapshot[]
//   KernelPositionStateStore → listResolved(): readonly PositionResolution[]
//   PositionPlanStore      → list(): readonly PositionPlan[]
//
// This port records that requirement without adding any mutation API.

export interface LocalReconciliationSource {
  listOrders(): readonly LocalOrder[];
  listPositions(): readonly LocalPosition[];
  listPlans(): readonly LocalPlan[];
}

// ─── Outcome taxonomy (FROZEN) ──────────────────────────────────────────────

export type ReconciliationOutcome =
  | 'MATCH'
  | 'POSITION_MISMATCH'
  | 'UNKNOWN_ORDER'
  | 'MISSING_FILL'
  | 'ORPHAN_ORDER'
  | 'MISSING_PROTECTION'
  | 'UNTRUSTED_STATE';

export type IssueOutcome = Exclude<ReconciliationOutcome, 'MATCH'>;

/**
 * Deterministic severity ordering for the primary outcome. Lower value wins.
 * Ordering reflects safety-criticality:
 *   0 UNTRUSTED_STATE   — truth itself is unusable
 *   1 POSITION_MISMATCH — factual position disagreement
 *   2 MISSING_FILL      — fill evidence discrepancy (money)
 *   3 UNKNOWN_ORDER     — order fate cannot be established
 *   4 ORPHAN_ORDER      — broker order with no local record
 *   5 MISSING_PROTECTION— open position without active protection plan
 */
export const OUTCOME_PRIORITY: Record<IssueOutcome, number> = {
  UNTRUSTED_STATE: 0,
  POSITION_MISMATCH: 1,
  MISSING_FILL: 2,
  UNKNOWN_ORDER: 3,
  ORPHAN_ORDER: 4,
  MISSING_PROTECTION: 5,
};

export interface ReconciliationIssue {
  readonly outcome: IssueOutcome;
  readonly reason: string;
  readonly exchange?: ExchangeId;
  readonly symbol?: string;
  readonly orderId?: string;
  readonly fillId?: string;
  readonly planId?: string;
}

export interface ReconciliationReport {
  /** Primary outcome: MATCH, or the highest-priority issue's outcome. */
  readonly outcome: ReconciliationOutcome;
  /** True iff outcome === 'MATCH'. Any unresolved mismatch ⇒ false. */
  readonly reconciliationVerified: boolean;
  /** All issues, deterministically sorted (priority, then stable key). Empty ⇒ MATCH. */
  readonly issues: readonly ReconciliationIssue[];
  readonly identity: ReconciliationIdentity;
  readonly source: string;
  readonly capturedAt: number;
  /** Evidence digests for audit — why MATCH or a mismatch was produced. */
  readonly localDigest: string;
  readonly externalDigest: string;
}

// ─── LIVE_READY contract (documented, NOT wired in this task) ───────────────
// After Phase 5B, the intended production readiness invariant is:
//
//   RECOVERY_VERIFIED
//     AND RECONCILIATION_VERIFIED
//     AND fresh post-recovery collector market
//   → LIVE_READY
//
// RECONCILIATION_VERIFIED is derived from a PURE function over (local, external)
// inputs — there is no exported setter/token/helper that can grant it. A caller
// can only forge it by forging the inputs themselves, which is outside this
// contract's authority boundary.
