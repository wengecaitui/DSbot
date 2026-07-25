// Stage 4A4-R3: Chronological split — proper expanding window, fixed embargo.
import type { WalkForwardConfig, ChronologicalSplit } from './ValidationTypes';

export const SPLIT_ERRORS = { INSUFFICIENT_DATA: 'SPLIT_INSUFFICIENT_DATA', INVALID_CONFIG: 'SPLIT_INVALID_CONFIG', ZERO_BARS: 'SPLIT_ZERO_BARS' } as const;

export function generateSplits(cfg: WalkForwardConfig): ChronologicalSplit[] {
  const { totalBars, trainBars, validationBars, testBars, purgeBars, embargoBars, mode } = cfg;
  const lkbk = cfg.featureLookbackBars ?? 0; const lbl = cfg.labelHorizonBars ?? 0;
  if (!Number.isInteger(totalBars) || totalBars <= 0) throw new Error(SPLIT_ERRORS.ZERO_BARS);
  [trainBars, validationBars, testBars, purgeBars, embargoBars, lkbk, lbl].forEach(v => { if (!Number.isInteger(v) || v < 0) throw new Error(SPLIT_ERRORS.INVALID_CONFIG); });
  if (trainBars === 0 || validationBars === 0 || testBars === 0) throw new Error(SPLIT_ERRORS.INVALID_CONFIG);

  const folds: ChronologicalSplit[] = [];
  let testEnd = totalBars;
  // A label at bar t observes through t + labelHorizonBars. The effective
  // phase gap must satisfy both the configured purge and the label horizon;
  // adjacent out-of-sample windows must satisfy embargo and label horizon.
  const phaseGapBars = Math.max(purgeBars, lbl);
  const outOfSampleGapBars = Math.max(embargoBars, lbl);

  if (mode === 'expanding') {
    const trainStart = lkbk;
    let foldIdx = 0;
    while (true) {
      const tStart = testEnd - testBars;
      const vEnd = tStart - phaseGapBars - 1;
      const vStart = vEnd - validationBars + 1;
      const trainEnd = vStart - phaseGapBars - 1;
      if (trainEnd - trainStart + 1 < trainBars) break;
      folds.push({ fold: foldIdx++, train: { start: trainStart, end: trainEnd, count: trainEnd - trainStart + 1 }, validation: { start: vStart, end: vEnd, count: validationBars }, test: { start: tStart, end: testEnd - 1, count: testBars }, purgeBars, embargoBars, featureLookbackBars: lkbk, labelHorizonBars: lbl });
      testEnd -= testBars + outOfSampleGapBars;
    }
  } else {
    let foldIdx = 0;
    while (true) {
      const tStart = testEnd - testBars;
      const vEnd = tStart - phaseGapBars - 1;
      const vStart = vEnd - validationBars + 1;
      const trainEnd = vStart - phaseGapBars - 1;
      const trainStart = trainEnd - trainBars + 1;
      if (trainStart < lkbk) break;
      folds.push({ fold: foldIdx++, train: { start: trainStart, end: trainEnd, count: trainBars }, validation: { start: vStart, end: vEnd, count: validationBars }, test: { start: tStart, end: testEnd - 1, count: testBars }, purgeBars, embargoBars, featureLookbackBars: lkbk, labelHorizonBars: lbl });
      testEnd -= testBars + outOfSampleGapBars;
    }
  }

  if (folds.length === 0) throw new Error(SPLIT_ERRORS.INSUFFICIENT_DATA);
  return folds.reverse(); // oldest → newest
}

export function validateFoldIsolation(fold: ChronologicalSplit, nextFold?: ChronologicalSplit): string[] {
  const issues: string[] = [];
  if (fold.train.end + fold.purgeBars >= fold.validation.start) issues.push('LEAKAGE: train+purge crosses validation start');
  if (fold.validation.end + fold.purgeBars >= fold.test.start) issues.push('LEAKAGE: val+purge crosses test start');
  if (fold.train.end + fold.labelHorizonBars >= fold.validation.start) issues.push('LEAKAGE: train label horizon crosses validation start');
  if (fold.validation.end + fold.labelHorizonBars >= fold.test.start) issues.push('LEAKAGE: validation label horizon crosses test start');
  if (nextFold && fold.test.end + fold.embargoBars >= nextFold.test.start) issues.push('LEAKAGE: test+embargo crosses next test');
  if (nextFold && fold.test.end + fold.labelHorizonBars >= nextFold.test.start) issues.push('LEAKAGE: test label horizon crosses next test');
  if (fold.train.start < fold.featureLookbackBars) issues.push('LEAKAGE: feature lookback before bar 0');
  return issues;
}
