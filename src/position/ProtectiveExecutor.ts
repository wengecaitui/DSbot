// Phase 4: ProtectiveExecutor — wires stop trigger through Gateway → OMS
import type { TradeIntent } from '../types/trade-intent';
import type { PositionPlan, EvaluateResult } from './position-plan-types';
import type { GatewayInput, GatewayResult } from '../risk/pretrade-risk-types';
import type { OmsCore } from '../oms/OmsCore';

/** Construct a defensive close TradeIntent from a triggered plan */
export function buildProtectiveIntent(plan: PositionPlan): TradeIntent {
  return {
    intentId: `stop-${plan.planId}`,
    exchange: 'bitget' as any,
    symbol: plan.symbol,
    direction: plan.positionSide === 'long' ? 'short' : 'long',
    orderType: 'market',
    positionUsd: Math.abs(plan.entryQuantity * plan.entryPrice),
    source: 'position-manager',
    createdAt: Date.now(),
    reason: `stop triggered: ${plan.positionSide} stop=${plan.stopPrice}`,
    biasUpdatedAt: Date.now(),
  };
}

/** Route a triggered close through Gateway → OMS */
export async function executeProtectiveClose(
  plan: PositionPlan,
  gatewayFn: (input: Omit<GatewayInput, 'intent'>) => GatewayResult,
  oms: OmsCore,
): Promise<{ status: 'submitted' | 'blocked'; reason?: string }> {
  const intent = buildProtectiveIntent(plan);
  const gwResult = gatewayFn({
    action: 'close',
    marketSnapshot: undefined,
    policyResolution: { riskLevel: 'conservative', maxPositionMultiplier: 1, allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [], allowNewEntries: false } as any,
    positionResolution: { status: 'open' as const, snapshot: null, side: plan.positionSide, signedQuantity: plan.entryQuantity, averageEntryPrice: plan.entryPrice },
    hardRisk: { exchange: 'bitget' as any, locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity },
  });
  if (gwResult.decision !== 'ADMITTED') return { status: 'blocked', reason: gwResult.reasonCode };
  await oms.submitRequest(intent, 'close', gwResult.approvedPositionUsd);
  return { status: 'submitted' };
}
