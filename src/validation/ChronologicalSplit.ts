// Stage 4A4: Chronological split generator with purge/embargo — no shuffle, no leakage.
import type { WalkForwardConfig, ChronologicalSplit } from './ValidationTypes';

export const SPLIT_ERRORS = {
  INSUFFICIENT_DATA: 'SPLIT_INSUFFICIENT_DATA',
  INVALID_CONFIG: 'SPLIT_INVALID_CONFIG',
  ZERO_BARS: 'SPLIT_ZERO_BARS',
} as const;

export function generateSplits(cfg: WalkForwardConfig): ChronologicalSplit[] {
  if (cfg.totalBars <= 0) throw new Error(SPLIT_ERRORS.ZERO_BARS);
  const minBars = cfg.minFoldBars ?? (cfg.trainBars + cfg.validationBars + cfg.testBars + cfg.purgeBars + cfg.embargoBars);
  if (minBars <= 0) throw new Error(SPLIT_ERRORS.INVALID_CONFIG);
  const step = cfg.testBars;
  if (step <= 0) throw new Error(SPLIT_ERRORS.INVALID_CONFIG);

  const folds: ChronologicalSplit[] = [];
  let foldNum = 0;
  let testEnd = cfg.totalBars;

  while (testEnd >= minBars) {
    const testStart = testEnd - cfg.testBars;
    const embargoEnd = testStart - 1;
    const embargoStart = Math.max(0, embargoEnd - cfg.embargoBars + 1);
    const valEnd = embargoStart - cfg.purgeBars - 1;
    const valStart = Math.max(0, valEnd - cfg.validationBars + 1);
    const trainEnd = valStart - cfg.purgeBars - 1;
    const trainStart = cfg.mode === 'expanding' ? 0 : Math.max(0, trainEnd - cfg.trainBars + 1);

    if (trainStart >= 0 && trainEnd > trainStart && valStart > trainEnd && testStart > valEnd) {
      folds.push({
        fold: foldNum++,
        train:  { start: trainStart, end: trainEnd, count: trainEnd - trainStart + 1 },
        validation: { start: valStart, end: valEnd, count: valEnd - valStart + 1 },
        test: { start: testStart, end: testEnd, count: testEnd - testStart + 1 },
        purgeBars: cfg.purgeBars,
        embargoBars: cfg.embargoBars,
      });
    }
    testEnd -= step;
  }

  if (folds.length === 0) throw new Error(SPLIT_ERRORS.INSUFFICIENT_DATA);
  return folds;
}

/** Verify no overlap between adjacent folds (purge + embargo test). */
export function validateFoldIsolation(fold: ChronologicalSplit, nextFold?: ChronologicalSplit): string[] {
  const issues: string[] = [];
  if (fold.train.end >= fold.validation.start) issues.push('LEAKAGE: train overlaps validation');
  if (fold.validation.end + fold.purgeBars >= fold.test.start) issues.push('LEAKAGE: missing purge before test');
  if (fold.test.end >= (nextFold?.train.start ?? Infinity)) issues.push('LEAKAGE: test leaks into next train');
  return issues;
}
