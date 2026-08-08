// Phase 2: PreTrade Risk Gateway Types
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { MarketSnapshot } from '../data/MarketSnapshot';
import type { PolicyResolution } from '../types/policy-snapshot';
import type { PositionResolution } from '../types/position-state';

export type TradeAction = 'open' | 'reduce' | 'close' | 'emergency_exit';

export interface HardRiskSnapshot {
  readonly exchange: ExchangeId;
  readonly locked: boolean;
  readonly enabled: boolean;
  readonly totalCapitalUsd: number;
  readonly maxSinglePositionPct: number;
  readonly maxSinglePositionAbsUsd: number;
}

export interface GatewayInput {
  readonly intent: TradeIntent;
  readonly action: TradeAction;
  readonly marketSnapshot: MarketSnapshot | undefined;
  readonly policyResolution: PolicyResolution;
  readonly positionResolution: PositionResolution;
  readonly hardRisk: HardRiskSnapshot;
}

export type RiskReasonCode =
  | 'INVALID_INPUT' | 'PROVENANCE_MISMATCH' | 'KILLSWITCH_LOCKED'
  | 'MARKET_MISSING' | 'MARKET_STALE' | 'MARKET_PRICE_INVALID'
  | 'POSITION_UNKNOWN' | 'ACTION_POSITION_CONFLICT'
  | 'POLICY_UNAVAILABLE' | 'POLICY_ENTRIES_BLOCKED'
  | 'POLICY_DIRECTION_MISMATCH' | 'HARD_RISK_CONFIG_INVALID'
  | 'POSITION_LIMIT_REACHED';

export type GatewayResult =
  | { readonly decision: 'ADMITTED'; readonly action: TradeAction;
      readonly intent: TradeIntent; readonly approvedPositionUsd: number; }
  | { readonly decision: 'REJECTED'; readonly reasonCode: RiskReasonCode; };
