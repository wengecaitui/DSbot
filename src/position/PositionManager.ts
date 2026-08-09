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
  onFill(position: PositionResolution, plan: PositionPlan | undefined): PositionPlan | null {
    if (position.status === 'missing') return null;

    if (position.status === 'flat') {
      // Close → archive existing plan
      if (!plan || plan.status !== 'active') return null;
      return plan; // caller should archive
    }

    // Open or scale-in → create or keep plan
    if (!plan || plan.status !== 'active') {
      // Create new plan
      const stopPrice = computeStopPrice(position.averageEntryPrice, position.side as 'long' | 'short', this.stopConfig.stopPct);
      if (!Number.isFinite(stopPrice)) return null;
      const planId = generatePlanId(position.symbol ?? '', position.side as 'long' | 'short', position.averageEntryPrice, 0);
      const newPlan: PositionPlan = {
        planId, symbol: position.symbol ?? '', positionSide: position.side as 'long' | 'short',
        side: position.side as 'long' | 'short', entryPrice: position.averageEntryPrice,
        entryQuantity: Math.abs(position.signedQuantity), stopPrice,
        status: 'active', planVersion: 0, sourceKernelEventId: '',
      };
      return newPlan;
    }

    // Scale-in → update stop-price (plan stays)
    const newStopPrice = computeStopPrice(position.averageEntryPrice, position.side as 'long' | 'short', this.stopConfig.stopPct);
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
