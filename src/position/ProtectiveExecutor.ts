// Phase 4: ProtectiveExecutor — wires stop trigger through real Gateway → real OMS
import type { TradeIntent } from '../types/trade-intent';
import type { PositionPlan } from './position-plan-types';
import type { PositionResolution } from '../types/position-state';
import type { HardRiskSnapshot, GatewayInput } from '../risk/pretrade-risk-types';
import { evaluatePreTradeRisk } from '../risk/PreTradeRiskGateway';
import type { OmsCore } from '../oms/OmsCore';

export interface ProtectiveContext {
  readonly plan: PositionPlan;
  readonly currentPosition: PositionResolution;
  readonly exchange: string;
  readonly marketPrice: number | undefined;
  readonly marketSnapshot?: any;  // Real MarketSnapshot from data pipeline
  readonly hardRisk: HardRiskSnapshot;
}

/** Deterministic protective close intent — sized from current factual PositionState */
export function buildProtectiveIntent(ctx: ProtectiveContext): TradeIntent {
  const closeSize = Math.abs(ctx.currentPosition.signedQuantity * ctx.currentPosition.averageEntryPrice);
  return {
    intentId: `protect-${ctx.plan.planId}`,
    exchange: ctx.exchange as any,
    symbol: ctx.plan.symbol,
    direction: ctx.plan.positionSide === 'long' ? 'short' : 'long',
    orderType: 'market',
    positionUsd: closeSize,
    source: 'position-manager',
    createdAt: 0,
    reason: `stop triggered: ${ctx.plan.positionSide} stop=${ctx.plan.stopPrice} market=${ctx.marketPrice}`,
    biasUpdatedAt: 0,
  };
}

export type ProtectiveOutcome =
  | { submitted: true; orderId: string }
  | { submitted: false; reason: 'blocked_by_gateway' | 'no_position' | 'hardrisk_locked' };

/** Evaluate Gateway admission and return intent if ADMITTED */
export function evaluateProtectiveRoute(ctx: ProtectiveContext): { admitted: true; approvedSize: number; intent: TradeIntent } | { admitted: false; reason: string } {
  if (ctx.currentPosition.status === 'missing' || ctx.currentPosition.status === 'flat') {
    return { admitted: false, reason: 'no_position' };
  }
  if (ctx.hardRisk.locked) {
    return { admitted: false, reason: 'hardrisk_locked' };
  }

  const intent = buildProtectiveIntent(ctx);
  const gwResult = evaluatePreTradeRisk({
    intent,
    action: 'close',
    marketSnapshot: ctx.marketSnapshot,
    policyResolution: { riskLevel: 'conservative', maxPositionMultiplier: 1 } as any,
    positionResolution: ctx.currentPosition,
    hardRisk: ctx.hardRisk,
  });

  if (gwResult.decision !== 'ADMITTED') {
    return { admitted: false, reason: `blocked_by_gateway: ${gwResult.reasonCode}` };
  }

  return { admitted: true, approvedSize: gwResult.approvedPositionUsd, intent };
}

/** Route admitted intent through real OMS — returns truthful OMS result */
export async function submitThroughOms(
  intent: TradeIntent,
  approvedSize: number,
  oms: OmsCore,
): Promise<ProtectiveOutcome> {
  const omsResult = await oms.submitRequest(intent, 'close', approvedSize);
  // Truthful: only mark submitted if OMS created or returned existing
  if (omsResult.status === 'submitted' || omsResult.status === 'created') {
    return { submitted: true, orderId: intent.intentId };
  }
  return { submitted: false, reason: 'blocked_by_gateway' };
}
