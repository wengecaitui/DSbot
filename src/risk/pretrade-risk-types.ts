// Phase 2: PreTrade Risk Gateway Types
export type TradeAction = 'open' | 'reduce' | 'close' | 'emergency_exit';

export interface HardRiskSnapshot {
  readonly exchange: string;
  readonly locked: boolean;
  readonly enabled: boolean;
  readonly totalCapitalUsd: number;
  readonly maxSinglePositionPct: number;
  readonly maxSinglePositionAbsUsd: number;
}

export interface MarketSnapshot {
  readonly exchange: string;
  readonly symbol: string;
  readonly isStale: boolean;
  readonly ticker?: { readonly ticker: { readonly last: number } };
}

export interface PolicyResolution {
  readonly status: 'missing' | 'active' | 'degraded' | 'expired';
  readonly allowNewEntries: boolean;
  readonly maxPositionMultiplier: number;
  readonly directionBias: 'bullish' | 'bearish' | 'neutral' | 'mixed';
}

export interface PositionResolution {
  readonly status: 'missing' | 'flat' | 'open';
  readonly side: 'long' | 'short' | 'flat';
  readonly signedQuantity: number;
}

export interface GatewayInput {
  readonly intent: { readonly intentId: string; readonly exchange: string;
    readonly symbol: string; readonly direction: 'long' | 'short';
    readonly positionUsd: number; };
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
      readonly intent: GatewayInput['intent']; readonly approvedPositionUsd: number; }
  | { readonly decision: 'REJECTED'; readonly reasonCode: RiskReasonCode; };
