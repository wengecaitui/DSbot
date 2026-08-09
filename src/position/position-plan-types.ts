// Phase 4: Position Plan Types
import type { ExchangeId } from '../data/MarketIdentity';

export interface StopConfig {
  readonly stopPct: number; // 0.05 = 5% from entry
  readonly enabled: boolean;
}

export const DEFAULT_STOP_CONFIG: StopConfig = {
  stopPct: 0.05,
  enabled: true,
};

export interface PositionPlan {
  readonly planId: string;
  readonly exchange: string;
  readonly symbol: string;
  readonly positionSide: 'long' | 'short';
  /** Side that opened the position for this plan */
  readonly side: 'long' | 'short';
  /** Average entry price at plan creation */
  readonly entryPrice: number;
  /** Signed quantity covered by this plan at creation */
  readonly entryQuantity: number;
  /** Active stop price computed from entry */
  readonly stopPrice: number;
  /** Plan lifecycle */
  readonly status: 'active' | 'closed' | 'archived';
  /** Version — kernelLogicalSequence of last plan event */
  readonly planVersion: number;
  readonly sourceKernelEventId: string;
}

export type EvaluateResult =
  | { readonly decision: 'hold' }
  | { readonly decision: 'close'; readonly reason: string };
