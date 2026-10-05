// Phase 2: PreTrade Risk Gateway Types
import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { MarketSnapshot } from '../data/MarketSnapshot';
import type { PolicyResolution } from '../types/policy-snapshot';
import type { PositionResolution } from '../types/position-state';
import type { AccountRiskAuthorizationContext } from './account-risk-authorization-context-types';

export type TradeAction = 'open' | 'reduce' | 'close' | 'emergency_exit';

export interface HardRiskSnapshot {
  readonly exchange: ExchangeId;
  readonly locked: boolean;
  readonly enabled: boolean;
  readonly totalCapitalUsd: number;
  readonly maxSinglePositionPct: number;
  readonly maxSinglePositionAbsUsd: number;
}

/**
 * Production composition identity wrapper. The risk gateway remains exchange
 * focused, while the application owner additionally proves that the source is
 * bound to the same durable paper account before publishing a spine.
 */
export interface AccountBoundHardRiskSnapshot extends HardRiskSnapshot {
  readonly accountId: string;
  readonly lockReason?: string;
}

export interface GatewayInput {
  readonly intent: TradeIntent;
  readonly action: TradeAction;
  readonly marketSnapshot: MarketSnapshot | undefined;
  readonly policyResolution: PolicyResolution;
  readonly positionResolution: PositionResolution;
  readonly hardRisk: HardRiskSnapshot;
  /** Optional composition-owned limit. Limited-live fixes this at 1 with scaling disabled. */
  readonly positionLimits?: {
    readonly maxConcurrentPositions: number;
    readonly openPositionCount: number;
    readonly allowScale: boolean;
  };
}

/** Frozen legacy/paper contract. Account-bound evaluation uses a separate,
 * explicitly discriminated entrypoint and can never fall back to this mode. */
export type LegacyPaperGatewayInput = GatewayInput & {
  readonly mode?: never;
  readonly authorizationContext?: never;
};

export interface AccountBoundGatewayInput extends Omit<GatewayInput, 'action' | 'hardRisk'> {
  readonly mode: 'ACCOUNT_BOUND';
  /** The current canonical action name covers both a new position and same-side increase. */
  readonly action: 'open';
  readonly hardRisk: AccountBoundHardRiskSnapshot;
  readonly authorizationContext: AccountRiskAuthorizationContext;
}

export type CanonicalRiskIncreaseEffect = 'OPEN' | 'INCREASE';

export interface ExactRiskComparisonEvidence {
  readonly metric:
    | 'DAILY_EQUITY_LOSS'
    | 'DRAWDOWN_FRACTION'
    | 'POSITION_NOTIONAL'
    | 'POSITION_FRACTION_NOTIONAL';
  readonly actualExact: string;
  readonly limitExact: string;
  readonly rejectWhen: '>=' | '>';
  readonly outcome: 'PASS' | 'REJECT';
}

export interface AccountBoundGatewayDecisionProvenance {
  readonly mode: 'ACCOUNT_BOUND';
  readonly riskEffect: CanonicalRiskIncreaseEffect | null;
  readonly exchange: string | null;
  readonly settle: string | null;
  readonly accountId: string | null;
  readonly symbol: string | null;
  readonly intentId: string | null;
  readonly positionVersion: number | null;
  readonly positionSourceKernelEventId: string | null;
  readonly contextDigest: string | null;
  readonly snapshotDigest: string | null;
  readonly mandateDigest: string | null;
  readonly evaluationTime: number | null;
  readonly accountingDayId: string | null;
  readonly mandateId: string | null;
  readonly mandateVersion: number | null;
  readonly comparisons: readonly ExactRiskComparisonEvidence[];
}

export type RiskReasonCode =
  | 'INVALID_INPUT' | 'PROVENANCE_MISMATCH' | 'KILLSWITCH_LOCKED'
  | 'MARKET_MISSING' | 'MARKET_STALE' | 'MARKET_PRICE_INVALID'
  | 'POSITION_UNKNOWN' | 'ACTION_POSITION_CONFLICT'
  | 'POLICY_UNAVAILABLE' | 'POLICY_ENTRIES_BLOCKED'
  | 'POLICY_DIRECTION_MISMATCH' | 'HARD_RISK_CONFIG_INVALID'
  | 'POSITION_LIMIT_REACHED'
  | 'ACCOUNT_RISK_MODE_INVALID'
  | 'ACCOUNT_RISK_CONTEXT_REQUIRED'
  | 'ACCOUNT_RISK_CONTEXT_INCOMPATIBLE'
  | 'ACCOUNT_RISK_CONTEXT_PROVENANCE_INVALID'
  | 'ACCOUNT_RISK_IDENTITY_MISMATCH'
  | 'ACCOUNT_RISK_EFFECT_UNRESOLVED'
  | 'ACCOUNT_RISK_SYMBOL_NOT_ALLOWED'
  | 'ACCOUNT_RISK_EFFECT_NOT_ALLOWED'
  | 'ACCOUNT_RISK_EXACT_VALUE_INVALID'
  | 'ACCOUNT_RISK_DAILY_LOSS_LIMIT_REACHED'
  | 'ACCOUNT_RISK_DRAWDOWN_LIMIT_REACHED'
  | 'ACCOUNT_RISK_POSITION_NOTIONAL_LIMIT_EXCEEDED'
  | 'ACCOUNT_RISK_POSITION_FRACTION_LIMIT_EXCEEDED';

export type GatewayResult =
  | { readonly decision: 'ADMITTED'; readonly action: TradeAction;
      readonly intent: TradeIntent; readonly approvedPositionUsd: number; }
  | { readonly decision: 'REJECTED'; readonly reasonCode: RiskReasonCode; };

export type AccountBoundGatewayResult =
  | { readonly decision: 'ADMITTED'; readonly action: 'open';
      readonly intent: TradeIntent; readonly approvedPositionUsd: number;
      readonly provenance: AccountBoundGatewayDecisionProvenance; }
  | { readonly decision: 'REJECTED'; readonly reasonCode: RiskReasonCode;
      readonly provenance: AccountBoundGatewayDecisionProvenance; };
