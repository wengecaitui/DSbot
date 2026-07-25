// Stage 4A4-R3: Chronological split — proper expanding window, fixed embargo.
import type { WalkForwardConfig, ChronologicalSplit } from './ValidationTypes';

export const SPLIT_ERRORS = { INSUFFICIENT_DATA: 'SPLIT_INSUFFICIENT_DATA', INVALID_CONFIG: 'SPLIT_INVALID_CONFIG', ZERO_BARS: 'SPLIT_ZERO_BARS' } as const;

export function generateSplits(cfg: WalkForwardConfig): ChronologicalSplit[] {
  const { totalBars, trainBars, validationBars, testBars, purgeBars, embargoBars, mode } = cfg;
  const lkbk = cfg.featureLookbackBars ?? 0; const lbl = cfg.labelHorizonBars ?? 0;
  if (!Number.isInteger(totalBars) || totalBars <= 0) throw new Error(SPLIT_ERRORS.ZERO_BARS);
  [trainBars, validationBars, testBars, purgeBars, embargoBars, lkbk, lbl].forEach(v => { if (!Number.isInteger(v) || v < 0) throw new Error(SPLIT_ERRORS.INVALID_CONFIG); });

  const folds: ChronologicalSplit[] = [];
  let testEnd = totalBars;
  const minSpan = trainBars + validationBars + 2 * purgeBars + testBars + embargoBars + lkbk + lbl;

  if (mode === 'expanding') {
    const trainStart = lkbk;
    let foldIdx = 0;
    while (testEnd >= minSpan + lkbk) {
      const tStart = testEnd - testBars;
      const vEnd = tStart - purgeBars - 1;
      const vStart = vEnd - validationBars + 1;
      const trainEnd = vStart - purgeBars - 1;
      if (trainEnd < trainStart + trainBars) break;
      folds.push({ fold: foldIdx++, train: { start: trainStart, end: trainEnd, count: trainEnd - trainStart + 1 }, validation: { start: vStart, end: vEnd, count: validationBars }, test: { start: tStart, end: testEnd - 1, count: testBars }, purgeBars, embargoBars, featureLookbackBars: lkbk, labelHorizonBars: lbl });
      testEnd -= testBars + embargoBars;
    }
  } else {
    let foldIdx = 0;
    while (testEnd >= lkbk + minSpan) {
      const tStart = testEnd - testBars;
      const vEnd = tStart - purgeBars - 1;
      const vStart = vEnd - validationBars + 1;
      const trainEnd = vStart - purgeBars - 1;
      const trainStart = trainEnd - trainBars + 1;
      if (trainStart < lkbk) break;
      folds.push({ fold: foldIdx++, train: { start: trainStart, end: trainEnd, count: trainBars }, validation: { start: vStart, end: vEnd, count: validationBars }, test: { start: tStart, end: testEnd - 1, count: testBars }, purgeBars, embargoBars, featureLookbackBars: lkbk, labelHorizonBars: lbl });
      testEnd -= testBars + embargoBars;
    }
  }

  if (folds.length === 0) throw new Error(SPLIT_ERRORS.INSUFFICIENT_DATA);
  return folds.reverse(); // oldest → newest
}

export function validateFoldIsolation(fold: ChronologicalSplit, nextFold?: ChronologicalSplit): string[] {
  const issues: string[] = [];
  if (fold.train.end >= fold.validation.start) issues.push('LEAKAGE: train end >= validation start');
  if (fold.validation.end + fold.purgeBars >= fold.test.start) issues.push('LEAKAGE: val+purge crosses test start');
  if (fold.test.end + fold.embargoBars > (nextFold?.train.start ?? Infinity)) issues.push('LEAKAGE: test+embargo crosses next train');
  if (fold.train.start < fold.featureLookbackBars) issues.push('LEAKAGE: feature lookback before bar 0');
  return issues;
}
