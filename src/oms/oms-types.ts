// Phase 3: OMS Types
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeAction } from '../risk/pretrade-risk-types';
import type { ConfirmedFill } from '../types/confirmed-fill';

// ─── OmsOrder ───────────────────────────────────────────────────────────────

export interface OmsOrder {
  readonly orderId: string;
  readonly intentId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly action: TradeAction;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'market';
  readonly approvedNotionalUsd: number;
}

// ─── OmsOrderStatus ─────────────────────────────────────────────────────────

export type OmsOrderStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'CANCELLED'
  | 'FILLED'
  | 'REJECTED'
  | 'SUBMISSION_UNKNOWN';

export const TERMINAL_STATUSES: readonly OmsOrderStatus[] = ['FILLED', 'REJECTED', 'CANCELLED'];

/** Durable non-secret sizing facts, recorded before mutation. Quantities are base units. */
export interface ExecutionPreparation {
  readonly requestedQuantity: number;
  readonly venueQuantity: number;
  readonly quantityMultiplier: number;
  readonly clientOrderId: string;
  readonly reduceOnly: boolean;
}

/** Cumulative exchange truth, never a delta fill. */
export interface OrderExecutionObservation {
  readonly orderId: string;
  readonly exchangeOrderId: string;
  readonly aggregateFillId?: string;
  readonly requestedQuantity: number;
  readonly cumulativeFilledQuantity: number;
  readonly remainingQuantity: number;
  readonly cumulativeNotional: number;
  readonly executedAt: number;
  readonly status: 'SUBMITTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
}

// ─── OmsOrderSnapshot ───────────────────────────────────────────────────────

export interface OmsOrderSnapshot extends OmsOrder {
  readonly preparation?: ExecutionPreparation;
  readonly execution?: OrderExecutionObservation;
  readonly requestedQuantity?: number | null;
  readonly cumulativeFilledQuantity?: number;
  readonly remainingQuantity?: number | null;
  readonly fills?: readonly OmsConfirmedFill[];
  readonly status: OmsOrderStatus;
  readonly fillId?: string;
  readonly rejectionReason?: string;
  readonly orderVersion: number;
  readonly sourceKernelEventId: string;
}

// ─── OmsConfirmedFill ───────────────────────────────────────────────────────

export interface OmsConfirmedFill extends ConfirmedFill {
  readonly orderId: string;
  readonly intentId: string;
}

// ─── Execution Adapter ──────────────────────────────────────────────────────

export type ExecutionResult =
  | { readonly status: 'filled'; readonly fill: OmsConfirmedFill; readonly observation?: OrderExecutionObservation }
  | { readonly status: 'execution'; readonly observation: OrderExecutionObservation }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'accepted' }
  | { readonly status: 'unknown'; readonly reason: string };

export interface ExecutionAdapter {
  submit(order: OmsOrder, prepared?: (value: ExecutionPreparation) => void): Promise<ExecutionResult>;
}

// ─── OmsResult ──────────────────────────────────────────────────────────────

export type OmsResult =
  | { readonly status: 'created'; readonly order: OmsOrderSnapshot }
  | { readonly status: 'submitted'; readonly order: OmsOrderSnapshot }
  | { readonly status: 'filled'; readonly order: OmsOrderSnapshot; readonly fill: OmsConfirmedFill }
  | { readonly status: 'partially_filled'; readonly order: OmsOrderSnapshot; readonly fill: OmsConfirmedFill }
  | { readonly status: 'cancelled'; readonly order: OmsOrderSnapshot; readonly fill?: OmsConfirmedFill }
  | { readonly status: 'rejected'; readonly order: OmsOrderSnapshot; readonly reason: string }
  | { readonly status: 'submission_unknown'; readonly order: OmsOrderSnapshot; readonly reason: string }
  | { readonly status: 'duplicate'; readonly order: OmsOrderSnapshot }
  | { readonly status: 'conflict'; readonly reason: string };
