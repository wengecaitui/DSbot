// Phase 4: PositionManager — deterministic protective evaluation
import type { ExchangeId } from '../data/MarketIdentity';
import type { PositionPlan, StopConfig, EvaluateResult } from './position-plan-types';
import { DEFAULT_STOP_CONFIG } from './position-plan-types';
import type { PositionResolution } from '../types/position-state';
import { generatePlanId } from './plan-id';

function computeStopPrice(entryPrice: number, side: 'long' | 'short', stopPct: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return NaN;
  if (!Number.isFinite(stopPct) || stopPct <= 0 || stopPct >= 1) return NaN;
  return side === 'long' ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
}

export class PositionManager {
  private stopConfig: StopConfig;

  constructor(config?: StopConfig) {
    this.stopConfig = config ?? DEFAULT_STOP_CONFIG;
  }

  /** Production: fill-driven lifecycle — create/update/terminate plan */
  onFill(position: PositionResolution, exchange: string, symbol: string, plan: PositionPlan | undefined): PositionPlan | null {
    if (position.status === 'missing') return null;

    // Flat → terminate active plan
    if (position.status === 'flat') {
      if (!plan || plan.status !== 'active') return null;
      return { ...plan, status: 'closed' as const };
    }

    const side = position.side as 'long' | 'short';
    const stopPrice = computeStopPrice(position.averageEntryPrice, side, this.stopConfig.stopPct);

    // No active plan or plan for wrong side → create new plan (flip)
    if (!plan || plan.status !== 'active' || plan.positionSide !== side) {
      if (!Number.isFinite(stopPrice)) return null;
      const planId = generatePlanId(exchange, symbol, side, position.averageEntryPrice, 0);
      return {
        planId, symbol, positionSide: side, side, entryPrice: position.averageEntryPrice,
        entryQuantity: Math.abs(position.signedQuantity), stopPrice,
        status: 'active', planVersion: 0, sourceKernelEventId: '',
      };
    }

    // Scale-in/partial reduce → update stop price if entry changed
    const newStopPrice = computeStopPrice(position.averageEntryPrice, side, this.stopConfig.stopPct);
    if (newStopPrice !== plan.stopPrice && Number.isFinite(newStopPrice))
      return { ...plan, stopPrice: newStopPrice };
    return null;
  }

  /** Called on market ticker — evaluate stop trigger */
  evaluate(plan: PositionPlan, marketPrice: number): EvaluateResult {
    if (!plan || plan.status !== 'active') return { decision: 'hold' };
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { decision: 'hold' };

    const triggered = plan.positionSide === 'long'
      ? marketPrice <= plan.stopPrice
      : marketPrice >= plan.stopPrice;

    return triggered
      ? { decision: 'close', reason: `stop triggered: side=${plan.positionSide}, stop=${plan.stopPrice}, market=${marketPrice}` }
      : { decision: 'hold' };
  }

  getStopConfig(): StopConfig { return { ...this.stopConfig }; }
}
