/**
 * Risk-feature config validation — shared pure module
 *
 * Validates the paper-inspired risk control configuration at config-update
 * time (fail closed), so invalid values are rejected BEFORE they can reach
 * the hot path. Never throw inside the high-frequency loop.
 */

export interface AdaptiveStopConfigLike {
  adaptiveStoplossEnabled: boolean;
  adaptiveSlBasePct: number;
  adaptiveSlHighK: number;
  adaptiveSlNormalK: number;
  adaptiveSlLowK: number;
  adaptiveSlMaxMultiplier: number;
}

export interface CostHurdleConfigLike {
  costHurdleGateEnabled: boolean;
  costHurdleMaxCostRatio: number;
  costHurdleWindowTrades: number;
  costHurdleMinCompletedTrades: number;
  costHurdleBlockCooldownSec: number;
  costHurdleMaxTradesPerHour: number;
}

export interface RegimeGateConfigLike {
  regimeGateEnabled: boolean;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate the price-level adaptive stop config.
 * Returns a list of error strings (empty = valid).
 */
export function validateAdaptiveStopConfig(c: AdaptiveStopConfigLike): string[] {
  const errors: string[] = [];
  if (typeof c.adaptiveStoplossEnabled !== 'boolean') {
    errors.push('adaptiveStoplossEnabled must be a boolean');
  }
  if (!isFiniteNumber(c.adaptiveSlBasePct) || c.adaptiveSlBasePct <= 0) {
    errors.push('adaptiveSlBasePct must be finite and > 0');
  }
  if (!isFiniteNumber(c.adaptiveSlNormalK) || c.adaptiveSlNormalK <= 0) {
    errors.push('adaptiveSlNormalK must be finite and > 0');
  }
  if (!isFiniteNumber(c.adaptiveSlHighK) || c.adaptiveSlHighK <= 0) {
    errors.push('adaptiveSlHighK must be finite and > 0');
  }
  if (!isFiniteNumber(c.adaptiveSlLowK) || c.adaptiveSlLowK <= 0) {
    errors.push('adaptiveSlLowK must be finite and > 0');
  }
  if (!isFiniteNumber(c.adaptiveSlMaxMultiplier) || c.adaptiveSlMaxMultiplier <= 0) {
    errors.push('adaptiveSlMaxMultiplier must be finite and > 0');
  }
  return errors;
}

/**
 * Validate the realized cost-drag breaker config.
 * Returns a list of error strings (empty = valid).
 */
export function validateCostHurdleConfig(c: CostHurdleConfigLike): string[] {
  const errors: string[] = [];
  if (typeof c.costHurdleGateEnabled !== 'boolean') {
    errors.push('costHurdleGateEnabled must be a boolean');
  }
  if (!isFiniteNumber(c.costHurdleMaxCostRatio) || c.costHurdleMaxCostRatio < 0) {
    errors.push('costHurdleMaxCostRatio must be finite and >= 0');
  }
  if (!Number.isInteger(c.costHurdleWindowTrades) || c.costHurdleWindowTrades <= 0) {
    errors.push('costHurdleWindowTrades must be a positive integer');
  }
  if (!Number.isInteger(c.costHurdleMinCompletedTrades) || c.costHurdleMinCompletedTrades <= 0) {
    errors.push('costHurdleMinCompletedTrades must be a positive integer');
  }
  if (c.costHurdleMinCompletedTrades > c.costHurdleWindowTrades) {
    errors.push('costHurdleMinCompletedTrades must be <= costHurdleWindowTrades');
  }
  if (!isFiniteNumber(c.costHurdleBlockCooldownSec) || c.costHurdleBlockCooldownSec < 0) {
    errors.push('costHurdleBlockCooldownSec must be finite and >= 0');
  }
  if (!Number.isInteger(c.costHurdleMaxTradesPerHour) || c.costHurdleMaxTradesPerHour < 0) {
    errors.push('costHurdleMaxTradesPerHour must be a non-negative integer');
  }
  return errors;
}

/**
 * Validate the regime gate config.
 * Returns a list of error strings (empty = valid).
 */
export function validateRegimeGateConfig(c: RegimeGateConfigLike): string[] {
  const errors: string[] = [];
  if (typeof c.regimeGateEnabled !== 'boolean') {
    errors.push('regimeGateEnabled must be a boolean');
  }
  return errors;
}
