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

  /** Called on execution.fill.confirmed — creates/updates/archives plan */
  onFill(position: PositionResolution, symbol: string, plan: PositionPlan | undefined): PositionPlan | null {
    if (position.status === 'missing') return null;

    if (position.status === 'flat') {
      if (!plan || plan.status !== 'active') return null;
      return plan;
    }

    if (!plan || plan.status !== 'active') {
      const side = position.side as 'long' | 'short';
      const stopPrice = computeStopPrice(position.averageEntryPrice, side, this.stopConfig.stopPct);
      if (!Number.isFinite(stopPrice)) return null;
      const planId = generatePlanId(symbol, side, position.averageEntryPrice, 0);
      const newPlan: PositionPlan = {
        planId, symbol, positionSide: side, side, entryPrice: position.averageEntryPrice,
        entryQuantity: Math.abs(position.signedQuantity), stopPrice,
        status: 'active', planVersion: 0, sourceKernelEventId: '',
      };
      return newPlan;
    }

    const side = position.side as 'long' | 'short';
    const newStopPrice = computeStopPrice(position.averageEntryPrice, side, this.stopConfig.stopPct);
    return newStopPrice !== plan.stopPrice && Number.isFinite(newStopPrice)
      ? { ...plan, stopPrice: newStopPrice } : null;
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

  /** Ensure MFE/MAE or other analytics are not embedded here */
  getStopConfig(): StopConfig { return { ...this.stopConfig }; }
}
