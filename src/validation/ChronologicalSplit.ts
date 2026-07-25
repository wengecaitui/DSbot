// Stage 4A4-R1: Chronological split with feature lookback, label horizon, oldest→newest folds.
import type { WalkForwardConfig, ChronologicalSplit } from './ValidationTypes';

export const SPLIT_ERRORS = {
  INSUFFICIENT_DATA: 'SPLIT_INSUFFICIENT_DATA',
  INVALID_CONFIG: 'SPLIT_INVALID_CONFIG',
  ZERO_BARS: 'SPLIT_ZERO_BARS',
} as const;

function assertNonNegInt(v: number, name: string): void {
  if (!Number.isInteger(v) || v < 0) throw new Error(`${SPLIT_ERRORS.INVALID_CONFIG}: ${name}=${v}`);
}

export function generateSplits(cfg: WalkForwardConfig): ChronologicalSplit[] {
  if (!Number.isInteger(cfg.totalBars) || cfg.totalBars <= 0) throw new Error(SPLIT_ERRORS.ZERO_BARS);
  assertNonNegInt(cfg.trainBars, 'trainBars'); assertNonNegInt(cfg.validationBars, 'validationBars');
  assertNonNegInt(cfg.testBars, 'testBars'); assertNonNegInt(cfg.purgeBars, 'purgeBars'); assertNonNegInt(cfg.embargoBars, 'embargoBars');
  const lkbk = cfg.featureLookbackBars ?? 0; const lbl = cfg.labelHorizonBars ?? 0;
  assertNonNegInt(lkbk, 'featureLookbackBars'); assertNonNegInt(lbl, 'labelHorizonBars');

  const folds: ChronologicalSplit[] = [];
  let testEnd = cfg.totalBars;
  let foldNum = 0;

  while (testEnd >= cfg.trainBars + cfg.validationBars + cfg.testBars + 2 * cfg.purgeBars + cfg.embargoBars + lkbk + lbl) {
    const testStart = testEnd - cfg.testBars;
    const valEnd = testStart - cfg.purgeBars - 1;
    const valStart = valEnd - cfg.validationBars + 1;
    const trainEnd = valStart - cfg.purgeBars - 1;
    const trainStart = cfg.mode === 'expanding' ? Math.max(lkbk, trainEnd - cfg.trainBars + 1) : Math.max(lkbk, trainEnd - cfg.trainBars + 1);
    if (cfg.mode === 'expanding') {
      // expanding: train grows leftward
      const expandingStart = Math.max(lkbk, testEnd - cfg.trainBars - cfg.validationBars - 2 * cfg.purgeBars - cfg.testBars - lkbk - lbl);
      folds.push({
        fold: foldNum++,
        train: { start: expandingStart, end: trainEnd, count: trainEnd - expandingStart + 1 },
        validation: { start: valStart, end: valEnd, count: cfg.validationBars },
        test: { start: testStart, end: testEnd - 1, count: cfg.testBars },
        purgeBars: cfg.purgeBars, embargoBars: cfg.embargoBars,
        featureLookbackBars: lkbk, labelHorizonBars: lbl,
      });
    } else {
      folds.push({
        fold: foldNum++,
        train: { start: trainStart, end: trainEnd, count: trainEnd - trainStart + 1 },
        validation: { start: valStart, end: valEnd, count: cfg.validationBars },
        test: { start: testStart, end: testEnd - 1, count: cfg.testBars },
        purgeBars: cfg.purgeBars, embargoBars: cfg.embargoBars,
        featureLookbackBars: lkbk, labelHorizonBars: lbl,
      });
    }
    testEnd -= cfg.testBars;
  }

  if (folds.length === 0) throw new Error(SPLIT_ERRORS.INSUFFICIENT_DATA);
  return folds.reverse(); // oldest → newest
}

export function validateFoldIsolation(fold: ChronologicalSplit, nextFold?: ChronologicalSplit): string[] {
  const issues: string[] = [];
  if (fold.train.end >= fold.validation.start) issues.push('LEAKAGE: train overlaps validation');
  if (fold.validation.end + fold.purgeBars >= fold.test.start) issues.push('LEAKAGE: insufficient purge before test');
  if (fold.test.end + fold.embargoBars >= (nextFold?.train.start ?? Infinity)) issues.push('LEAKAGE: embargo violated between test and next train');
  if (fold.train.start < fold.featureLookbackBars) issues.push('LEAKAGE: insufficient lookback before train');
  if (fold.test.end + fold.labelHorizonBars > (nextFold?.train.start ?? Infinity) && fold.test.end + fold.labelHorizonBars >= fold.test.end) issues.push('LEAKAGE: label horizon crosses into next fold');
  return issues;
}
