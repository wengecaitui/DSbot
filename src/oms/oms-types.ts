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
  | 'FILLED'
  | 'REJECTED'
  | 'SUBMISSION_UNKNOWN';

export const TERMINAL_STATUSES: readonly OmsOrderStatus[] = ['FILLED', 'REJECTED'];

// ─── OmsOrderSnapshot ───────────────────────────────────────────────────────

export interface OmsOrderSnapshot extends OmsOrder {
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
  | { readonly status: 'filled'; readonly fill: OmsConfirmedFill }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'accepted' }
  | { readonly status: 'unknown'; readonly reason: string };

export interface ExecutionAdapter {
  submit(order: OmsOrder): Promise<ExecutionResult>;
}

// ─── OmsResult ──────────────────────────────────────────────────────────────

export type OmsResult =
  | { readonly status: 'created'; readonly order: OmsOrderSnapshot }
  | { readonly status: 'submitted'; readonly order: OmsOrderSnapshot }
  | { readonly status: 'filled'; readonly order: OmsOrderSnapshot; readonly fill: OmsConfirmedFill }
  | { readonly status: 'rejected'; readonly order: OmsOrderSnapshot; readonly reason: string }
  | { readonly status: 'submission_unknown'; readonly order: OmsOrderSnapshot; readonly reason: string }
  | { readonly status: 'duplicate'; readonly order: OmsOrderSnapshot }
  | { readonly status: 'conflict'; readonly reason: string };
