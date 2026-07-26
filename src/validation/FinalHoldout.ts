// Stage 4A4-R8: FinalHoldout allocator — always-on with normalized defaults, failure propagates after one attempt.

import type { WalkForwardConfig, FinalHoldoutConfig } from './ValidationTypes';

export const HOLDOUT_ERRORS = {
  INSUFFICIENT_DEVELOPMENT: 'HOLDOUT_INSUFFICIENT_DEVELOPMENT',
  INVALID_RATIO: 'HOLDOUT_INVALID_RATIO',
  INVALID_MIN_BARS: 'HOLDOUT_INVALID_MIN_BARS',
  ZERO_HOLDOUT_BARS: 'HOLDOUT_ZERO_BARS',
  HOLDOUT_EXCEEDS_TOTAL: 'HOLDOUT_EXCEEDS_TOTAL',
} as const;

/** Default final holdout ratio when not explicitly configured. */
export const DEFAULT_HOLDOUT_RATIO = 0.15;

/**
 * Compute the effective final holdout bar count.
 *
 * Normalized defaults:
 *   - ratio defaults to 0.15
 *   - minBars defaults to 3 * testBars
 *
 * Formula: count = max(ceil(totalBars * effectiveRatio), effectiveMinBars)
 *
 * When ratio is explicit and min omitted: count = max(ceil(total*ratio), 3*testBars)
 * When ratio omitted and min explicit: count = max(ceil(total*0.15), min)
 * When both omitted: count = max(ceil(total*0.15), 3*testBars)
 * When both explicit: count = max(ceil(total*ratio), min)
 */
export function computeHoldoutCount(totalBars: number, testBars: number, ratio?: number, minBars?: number): number {
  const effectiveRatio = ratio ?? DEFAULT_HOLDOUT_RATIO;
  const effectiveMin = minBars ?? 3 * testBars;
  return Math.max(Math.ceil(totalBars * effectiveRatio), Math.ceil(effectiveMin));
}

/**
 * Computes the Final Holdout allocation from a WalkForwardConfig.
 *
 * Always allocated — ratio defaults to 0.15, minBars defaults to 3 * testBars.
 *
 * finalHoldoutBars = max(ceil(totalBars * ratio), minBars)
 * gap = max(purgeBars, embargoBars, labelHorizonBars)
 * developmentEndExclusive = finalHoldoutStart - gap
 *
 * Constraints:
 *   - 0 < ratio < 1 (finite)
 *   - minBars >= 0 (finite; fractional accepted, rounded up via Math.ceil)
 *   - finalHoldoutBars > 0
 *   - At least one valid development fold must be producible
 */
export function allocateFinalHoldout(cfg: WalkForwardConfig): FinalHoldoutConfig {
  const { totalBars, testBars, purgeBars, embargoBars, labelHorizonBars } = cfg;
  const ratio = cfg.finalHoldoutRatio ?? DEFAULT_HOLDOUT_RATIO;
  const minBars = cfg.finalHoldoutMinBars ?? 3 * testBars;
  const lbl = labelHorizonBars ?? 0;

  // Validate config
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error(HOLDOUT_ERRORS.INVALID_RATIO);
  if (!Number.isFinite(minBars) || minBars < 0) throw new Error(HOLDOUT_ERRORS.INVALID_MIN_BARS);

  // Compute holdout bar count — fractional minBars rounded upward
  const holdoutBars = Math.max(Math.ceil(totalBars * ratio), Math.ceil(minBars));

  if (holdoutBars <= 0) throw new Error(HOLDOUT_ERRORS.ZERO_HOLDOUT_BARS);
  if (holdoutBars >= totalBars) throw new Error(HOLDOUT_ERRORS.HOLDOUT_EXCEEDS_TOTAL);

  // Gap: max of purge, embargo, label horizon
  const gapBars = Math.max(purgeBars, embargoBars, lbl);

  // Holdout occupies the trailing bars
  const holdoutStart = totalBars - holdoutBars;
  const holdoutEnd = totalBars - 1; // inclusive
  const developmentEndExclusive = holdoutStart - gapBars;

  // Must have room for at least one fold: featureLookback + train + val + test + 2*max(purge,labelHorizon).
  // inter-fold outOfSampleGap/embargo is NOT added — finalHoldoutGap already isolates development from holdout.
  const minFoldFootprint = (cfg.featureLookbackBars ?? 0) + cfg.trainBars + cfg.validationBars + cfg.testBars + 2 * Math.max(cfg.purgeBars, lbl);
  if (developmentEndExclusive < minFoldFootprint) {
    throw new Error(HOLDOUT_ERRORS.INSUFFICIENT_DEVELOPMENT);
  }

  return {
    start: holdoutStart,
    end: holdoutEnd,
    count: holdoutBars,
    ratio,
    minBars,
    gapBars,
    developmentEndExclusive,
  };
}
