// Stage 4A4-R8: FinalHoldout allocator — computes independent trailing holdout range.
import type { WalkForwardConfig, FinalHoldoutConfig } from './ValidationTypes';

export const HOLDOUT_ERRORS = {
  INSUFFICIENT_DEVELOPMENT: 'HOLDOUT_INSUFFICIENT_DEVELOPMENT',
  INVALID_RATIO: 'HOLDOUT_INVALID_RATIO',
  INVALID_MIN_BARS: 'HOLDOUT_INVALID_MIN_BARS',
  ZERO_HOLDOUT_BARS: 'HOLDOUT_ZERO_BARS',
  HOLDOUT_EXCEEDS_TOTAL: 'HOLDOUT_EXCEEDS_TOTAL',
} as const;

/**
 * Computes the Final Holdout allocation from a WalkForwardConfig.
 *
 * finalHoldoutBars = max(ceil(totalBars * ratio), minBars)
 * gap = max(purgeBars, embargoBars, labelHorizonBars)
 * developmentEndExclusive = finalHoldoutStart - gap
 *
 * When finalHoldoutRatio is absent (undefined):
 *   finalHoldoutBars = max(3 * testBars, minBars ?? 0)
 *
 * Constraints:
 *   - 0 < ratio < 1 (finite)
 *   - minBars >= 0 (finite, integer)
 *   - finalHoldoutBars > 0
 *   - At least one valid development fold must be producible
 */
export function allocateFinalHoldout(cfg: WalkForwardConfig): FinalHoldoutConfig {
  const { totalBars, testBars, purgeBars, embargoBars, labelHorizonBars } = cfg;
  const ratio = cfg.finalHoldoutRatio;
  const minBars = cfg.finalHoldoutMinBars ?? 0;
  const lbl = labelHorizonBars ?? 0;

  // Validate config
  if (ratio !== undefined) {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error(HOLDOUT_ERRORS.INVALID_RATIO);
  }
  if (!Number.isFinite(minBars) || minBars < 0 || !Number.isInteger(minBars)) throw new Error(HOLDOUT_ERRORS.INVALID_MIN_BARS);

  // Compute holdout bar count
  let holdoutBars: number;
  if (ratio !== undefined) {
    holdoutBars = Math.max(Math.ceil(totalBars * ratio), minBars);
  } else {
    holdoutBars = Math.max(3 * testBars, minBars);
  }
  holdoutBars = Math.round(holdoutBars); // integer enforcement

  if (holdoutBars <= 0) throw new Error(HOLDOUT_ERRORS.ZERO_HOLDOUT_BARS);
  if (holdoutBars >= totalBars) throw new Error(HOLDOUT_ERRORS.HOLDOUT_EXCEEDS_TOTAL);

  // Gap: max of purge, embargo, label horizon
  const gapBars = Math.max(purgeBars, embargoBars, lbl);

  // Holdout occupies the trailing bars
  const holdoutStart = totalBars - holdoutBars;
  const holdoutEnd = totalBars - 1; // inclusive
  const developmentEndExclusive = holdoutStart - gapBars;

  // Must have room for at least one fold
  const minFoldFootprint = cfg.trainBars + cfg.validationBars + cfg.testBars + 2 * Math.max(cfg.purgeBars, lbl) + Math.max(cfg.embargoBars, lbl);
  if (developmentEndExclusive < (cfg.featureLookbackBars ?? 0) + minFoldFootprint) {
    throw new Error(HOLDOUT_ERRORS.INSUFFICIENT_DEVELOPMENT);
  }

  return {
    start: holdoutStart,
    end: holdoutEnd,
    count: holdoutBars,
    ratio: ratio ?? 0,
    minBars,
    gapBars,
    developmentEndExclusive,
  };
}
