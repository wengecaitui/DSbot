// Phase 4: ProtectiveExecutor — wires stop trigger through Gateway → OMS
import type { TradeIntent } from '../types/trade-intent';
import type { PositionPlan } from './position-plan-types';
import type { GatewayResult } from '../risk/pretrade-risk-types';
import type { PositionResolution } from '../types/position-state';
import type { HardRiskSnapshot } from '../risk/pretrade-risk-types';
import type { KernelEventEnvelope } from '../kernel/KernelEventEnvelope';
import { evaluatePreTradeRisk } from '../risk/PreTradeRiskGateway';
import type { OmsOrder, ExecutionAdapter, ExecutionResult, OmsConfirmedFill } from '../oms/oms-types';

export interface ProtectiveContext {
  readonly plan: PositionPlan;
  readonly currentPosition: PositionResolution;
  readonly marketPrice: number | undefined;
  readonly hardRisk: HardRiskSnapshot;
}

/** Deterministic protective close intent — sized from current factual PositionState */
export function buildProtectiveIntent(ctx: ProtectiveContext): TradeIntent {
  const closeSize = Math.abs(ctx.currentPosition.signedQuantity * ctx.currentPosition.averageEntryPrice);
  return {
    intentId: `protect-${ctx.plan.planId}`,
    exchange: 'bitget' as any,
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
  | { submitted: false; reason: 'blocked_by_gateway' | 'oms_rejected' | 'oms_unknown' | 'no_position' | 'hardrisk_locked' };

/** Deterministic evaluator — same inputs → same outcome */
export function evaluateAndRoute(
  ctx: ProtectiveContext,
): ProtectiveOutcome {
  // Missing / flat → no position to protect
  if (ctx.currentPosition.status === 'missing' || ctx.currentPosition.status === 'flat') {
    return { submitted: false, reason: 'no_position' };
  }

  // HardRisk locked → block
  if (ctx.hardRisk.locked) {
    return { submitted: false, reason: 'hardrisk_locked' };
  }

  const intent = buildProtectiveIntent(ctx);
  const gwResult: GatewayResult = evaluatePreTradeRisk({
    intent,
    action: 'close',
    marketSnapshot: ctx.marketPrice != null ? {
      exchange: 'bitget',
      symbol: ctx.plan.symbol,
      ticker: { ticker: { last: ctx.marketPrice, open: ctx.marketPrice, high: ctx.marketPrice, low: ctx.marketPrice, vol: 0, change: 0, changePercent: 0 }, receivedAt: 0 },
      klines: null,
    } as any : undefined,
    policyResolution: { riskLevel: 'conservative', maxPositionMultiplier: 1 } as any,
    positionResolution: ctx.currentPosition,
    hardRisk: ctx.hardRisk,
  });

  if (gwResult.decision !== 'ADMITTED') {
    return { submitted: false, reason: 'blocked_by_gateway' };
  }

  // OMS will be called externally — return approved intent
  return { submitted: true, orderId: intent.intentId };
}
