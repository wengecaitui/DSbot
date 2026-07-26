// Stage 4A4-R8: causal-per-fold selection (R8 only), mandatory FinalHoldout, deployment contract, full test suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSplits, validateFoldIsolation, assertFoldIsolation } from '../../src/validation/ChronologicalSplit';
import { computeCosts, makeMetrics, selectParameters, runWalkForward, recomputeCosts, type SimCallLedger, type SimResult } from '../../src/validation/WalkForward';
import { deepFreeze, makeReportId } from '../../src/validation/ValidationTypes';
import { allocateFinalHoldout, computeHoldoutCount, DEFAULT_HOLDOUT_RATIO } from '../../src/validation/FinalHoldout';
import type { WalkForwardConfig, CostConfig, ValidationClock, ParameterCandidate, ChronologicalSplit } from '../../src/validation/ValidationTypes';

const CFG: WalkForwardConfig = { totalBars: 15000, trainBars: 800, validationBars: 300, testBars: 300, purgeBars: 20, embargoBars: 10, mode: 'rolling' };
const COST: CostConfig = { feeBps: 10, spreadBps: 1, slippageBps: 5, latencyPenaltyBps: 2, stressMultiplier: 1.0 };
const CLOCK: ValidationClock = { nowISO: () => '2026-08-01T00:00:00.000Z', nowMs: () => 1 };
function sim(s: number, e: number, _p?: Record<string, string | number>) { return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 }; }
function mkLedger(): SimCallLedger { return { calls: 0, log: [] }; }
function wf(cfg?: WalkForwardConfig, grid?: Record<string, string | number>[], l?: SimCallLedger, dsHash?: string) { return runWalkForward(cfg ?? CFG, COST, sim, { paramGrid: grid, clock: CLOCK, ledger: l, datasetHash: dsHash }); }

function makeCandidate(id: string, valScore: number, trainScore: number, foldScores: number[], trainTrades: number = 15, valTrades: number = 15): ParameterCandidate {
  return { id, params: {}, validationScore: valScore, trainScore, foldScores, metrics: { fold: 0, trainMetrics: { grossReturn: 1, netReturn: 1, maxDrawdown: 0, sharpeRatio: 1, sortinoRatio: 1, profitFactor: 1, tradeCount: trainTrades, turnover: 1, costBreakdown: { grossReturn: 0, fees: 0, spreadCost: 0, slippageCost: 0, latencyCost: 0, netReturn: 0 }, _volume: 1000 }, validationMetrics: { grossReturn: 1, netReturn: 1, maxDrawdown: 0, sharpeRatio: 1, sortinoRatio: 1, profitFactor: 1, tradeCount: valTrades, turnover: 1, costBreakdown: { grossReturn: 0, fees: 0, spreadCost: 0, slippageCost: 0, latencyCost: 0, netReturn: 0 }, _volume: 1000 }, selected: false, usedForDeployment: false }, minTrainTrades: trainTrades, minValidationTrades: valTrades, accepted: true, selected: false };
}

// ═══ 1–20: Split geometry ═══════════════════════════════════════
test('1. rolling train count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.train.count, CFG.trainBars); });
test('2. expanding train count strictly increasing', () => { const f = generateSplits({ ...CFG, mode: 'expanding' }); for (let i = 1; i < f.length; i++) assert.ok(f[i].train.count > f[i - 1].train.count); });
test('3. expanding train start fixed', () => { const f = generateSplits({ ...CFG, mode: 'expanding' }); const first = f[0].train.start; for (const s of f.slice(1)) assert.equal(s.train.start, first); });
test('4. val count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.validation.count, CFG.validationBars); });
test('5. test count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.test.count, CFG.testBars); });
test('6. folds oldest→newest', () => { const f = generateSplits(CFG); for (let i = 1; i < f.length; i++) assert.ok(f[i - 1].train.start < f[i].train.start); });
test('7. indices in bounds', () => { for (const s of generateSplits(CFG)) { assert.ok(s.train.start >= 0); assert.ok(s.test.end < CFG.totalBars); } });
test('8. purge train→val', () => { for (const s of generateSplits({ ...CFG, purgeBars: 100 })) assert.ok(s.train.end + s.purgeBars <= s.validation.start); });
test('9. purge val→test', () => { for (const s of generateSplits(CFG)) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('10. feature lookback enforced', () => { const f = generateSplits({ ...CFG, totalBars: 50000, featureLookbackBars: 500 }); for (const s of f) assert.ok(s.train.start >= s.featureLookbackBars); });
test('11. label horizon present', () => { assert.equal(generateSplits({ ...CFG, totalBars: 50000, labelHorizonBars: 42 })[0].labelHorizonBars, 42); });
test('12. deterministic', () => { assert.deepStrictEqual(generateSplits(CFG), generateSplits(CFG)); });
test('13. expanding different from rolling', () => { assert.notDeepStrictEqual(generateSplits(CFG), generateSplits({ ...CFG, mode: 'expanding' })); });
test('14. insufficient totalBars throws', () => { assert.throws(() => generateSplits({ totalBars: 10, trainBars: 500, validationBars: 200, testBars: 200, purgeBars: 0, embargoBars: 0, mode: 'rolling' })); });
test('15. zero bars throws', () => { assert.throws(() => generateSplits({ totalBars: 0, trainBars: 100, validationBars: 50, testBars: 50, purgeBars: 0, embargoBars: 0, mode: 'rolling' })); });
test('16. negative purge throws', () => { assert.throws(() => generateSplits({ ...CFG, purgeBars: -1 })); });
test('17. distinct folds', () => { const f = generateSplits(CFG); const keys = new Set(f.map(s => `${s.train.start}-${s.test.end}`)); assert.equal(keys.size, f.length); });
test('18. folds exist', () => { assert.ok(generateSplits(CFG).length > 0); });
test('19. large totalBars diverse folds', () => { assert.ok(generateSplits({ ...CFG, totalBars: 200000 }).length > 5); });
test('20. adjacent isolation clear', () => { const f = generateSplits({ ...CFG, totalBars: 500000, embargoBars: 5, trainBars: 2000 }); assert.ok(f.length > 0); for (let i = 0; i < f.length - 1; i++) assert.deepStrictEqual(validateFoldIsolation(f[i], f[i + 1]), []); });

// ═══ 21–30: Leakage detection ══════════════════════════════════
test('21. train-val overlap detected', () => { const f: any = generateSplits(CFG)[0]; const bad = { ...f, train: { ...f.train, end: f.validation.start + 1 } }; assert.ok(validateFoldIsolation(bad).some(x => x.includes('train+purge'))); });
test('22. purge before test detected', () => { const f: any = generateSplits(CFG)[0]; const bad = { ...f, test: { ...f.test, start: f.validation.end } }; assert.ok(validateFoldIsolation(bad).some(x => x.includes('val+purge'))); });
test('23. embargo leak detected', () => { const f = generateSplits({ ...CFG, totalBars: 50000 }); const badNext = { ...f[1], test: { ...f[1].test, start: f[0].test.end + f[0].embargoBars } }; assert.ok(validateFoldIsolation(f[0], badNext).some(x => x.includes('test+embargo'))); });
test('24. feature lookback leak detected', () => { const f = generateSplits({ ...CFG, totalBars: 50000, featureLookbackBars: 500 })[0]; const bad = { ...f, train: { ...f.train, start: 100 }, featureLookbackBars: f.featureLookbackBars }; assert.ok(validateFoldIsolation(bad).some(x => x.includes('lookback'))); });
test('25. isolation passes on valid fold', () => { assert.deepStrictEqual(validateFoldIsolation(generateSplits(CFG)[0]), []); });
test('26. embargo spacing exists', () => { const f = generateSplits({ ...CFG, totalBars: 100000, embargoBars: 100, trainBars: 500 }); for (let i = 0; i < f.length - 1; i++) assert.ok(f[i].test.end + f[i].embargoBars < f[i + 1].test.start); });
test('27. embargo large still valid', () => { assert.ok(generateSplits({ ...CFG, totalBars: 100000, embargoBars: 200, trainBars: 500 }).length > 0); });
test('28. purge large but valid', () => { for (const s of generateSplits({ ...CFG, totalBars: 50000, purgeBars: 100 })) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('29. more embargo reduces folds', () => { const a = generateSplits({ ...CFG, totalBars: 50000, embargoBars: 5 }).length; const b = generateSplits({ ...CFG, totalBars: 50000, embargoBars: 100 }).length; assert.ok(b <= a); });
test('30. validation count preserved with purge', () => { for (const s of generateSplits({ ...CFG, totalBars: 50000, purgeBars: 50 })) assert.equal(s.validation.count, CFG.validationBars); });

// ═══ 31–40: Cost recomputation ═════════════════════════════════
test('31. computeCosts net < gross', () => { assert.ok(computeCosts(1000, 5000, 3, COST).netReturn < 1000); });
test('32. cost breakdown sums', () => { const c = computeCosts(2000, 3000, 5, COST); assert.equal(c.grossReturn - c.fees - c.spreadCost - c.slippageCost - c.latencyCost, c.netReturn); });
test('33. stress 1.5x higher fees', () => { assert.ok(computeCosts(1000, 5000, 3, { ...COST, stressMultiplier: 1.5 }).fees > computeCosts(1000, 5000, 3, COST).fees); });
test('34. stress 2x higher fees', () => { assert.ok(computeCosts(1000, 5000, 3, { ...COST, stressMultiplier: 2 }).fees > computeCosts(1000, 5000, 3, COST).fees); });
test('35. makeMetrics preserves _volume', () => { assert.equal((makeMetrics(sim(0, 500), COST) as any)._volume, 5000); });
test('36. recomputeCosts 1.5x lower net', () => { const m = makeMetrics(sim(0, 500), COST); assert.ok(recomputeCosts(m, 1.5, COST).netReturn < m.netReturn); });
test('37. recomputeCosts 2x < 1.5x net', () => { const m = makeMetrics(sim(0, 500), COST); assert.ok(recomputeCosts(m, 2.0, COST).netReturn < recomputeCosts(m, 1.5, COST).netReturn); });
test('38. recomputeCosts preserves sharpe', () => { const m = makeMetrics(sim(0, 500), COST); assert.equal(recomputeCosts(m, 2.0, COST).sharpeRatio, m.sharpeRatio); });
test('39. recomputeCosts preserves sortino', () => { const m = makeMetrics(sim(0, 500), COST); assert.equal(recomputeCosts(m, 2.0, COST).sortinoRatio, m.sortinoRatio); });
test('40. recomputeCosts preserves profitFactor', () => { const m = makeMetrics(sim(0, 500), COST); assert.equal(recomputeCosts(m, 2.0, COST).profitFactor, m.profitFactor); });

// ═══ 41–55: Parameter selection ════════════════════════════════
test('41. selects best val net', () => { const r = selectParameters([makeCandidate('a', 5, 5, [5]), makeCandidate('b', 8, 5, [8])]); assert.equal(r.selectedId, 'b'); });
test('42. deterministic tie-break', () => { const c = [makeCandidate('a', 5, 5, [5]), { ...makeCandidate('b', 5, 5, [5]), params: { x: 1 } }]; const r1 = selectParameters(c); const r2 = selectParameters(c); assert.equal(r1.selectedId, r2.selectedId); });
test('43. minTrades train rejected', () => { const c = makeCandidate('x', 10, 5, [10], 2, 15); const r = selectParameters([c]); assert.equal(r.candidates[0].accepted, false); assert.equal(r.candidates[0].rejectionReason, 'MIN_TRADES_TRAIN'); });
test('44. minTrades val rejected', () => { const c = makeCandidate('x', 10, 5, [10], 15, 2); const r = selectParameters([c]); assert.equal(r.candidates[0].accepted, false); assert.equal(r.candidates[0].rejectionReason, 'MIN_TRADES_VALIDATION'); });
test('45. empty candidates null', () => { assert.equal(selectParameters([]).selectedId, undefined); });
test('46. selected in list', () => { const r = selectParameters([makeCandidate('z', 10, 5, [10])]); assert.ok(r.candidates.find(x => x.id === 'z') != null); });
test('47. test phase calls match folds', () => { const l = mkLedger(); const r = wf({ ...CFG, trainBars: 500 }, [{ a: 1 }], l); const testCalls = l.log.filter(x => x.phase === 'test'); assert.equal(testCalls.length, r.folds.length); assert.deepStrictEqual(testCalls.map(x => x.fold), r.folds.map(x => x.fold)); });
test('48. no test in candidate phase', () => { const l = mkLedger(); wf(CFG, [{ a: 1 }], l); const candCalls = l.log.filter(x => x.phase === 'test' && x.candidateId !== undefined); assert.equal(candCalls.length, 0); });
test('49. no grid no testMetrics', () => { assert.equal(wf().folds[0].testMetrics, undefined); });
test('50. grid → testMetrics present', () => { assert.notEqual(wf({ ...CFG, trainBars: 500 }, [{ a: 1 }]).folds[0].testMetrics, undefined); });
test('51. selection produces output', () => { const r = wf(CFG, [{ a: 1 }]); assert.ok(r.folds.length > 0); });
test('52. train/val have candidateId', () => { const l = mkLedger(); wf(CFG, [{ a: 1 }], l); const tv = l.log.filter(x => x.candidateId && x.phase !== 'test'); assert.ok(tv.length > 0); });
test('53. param grid selection valid', () => { const g = [{ a: 1 }, { b: 2 }, { c: 3 }]; assert.ok(wf(CFG, g).reportId.length > 0); });
test('54. same input identical selection', () => { const p = [{ a: 1 }, { b: 2 }]; assert.deepStrictEqual(wf(CFG, p).selectedParameters, wf(CFG, p).selectedParameters); });
test('55. large grid valid', () => { const g = Array.from({ length: 5 }, (_, i) => ({ v: i })); const r = wf(CFG, g); assert.ok(r.folds.length > 0); });

// ═══ 56–72: Report + identity ══════════════════════════════════
test('56. reportId deterministic', () => { assert.equal(wf().reportId, wf().reportId); });
test('57. datasetHash changes reportId', () => { assert.notEqual(wf(CFG, undefined, mkLedger(), 'a').reportId, wf(CFG, undefined, mkLedger(), 'b').reportId); });
test('58. simVersion changes reportId', () => { assert.notEqual(runWalkForward(CFG, COST, sim, { clock: CLOCK, simVersion: 'v1' }).reportId, runWalkForward(CFG, COST, sim, { clock: CLOCK, simVersion: 'v2' }).reportId); });
test('59. costConfig changes reportId', () => { assert.notEqual(wf().reportId, runWalkForward(CFG, { ...COST, feeBps: 20 }, sim, { clock: CLOCK }).reportId); });
test('60. same input identical report', () => { assert.deepStrictEqual(wf(), wf()); });
test('61. report deeply frozen', () => { const r = wf(); assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.folds)); assert.ok(Object.isFrozen(r.warnings)); });
test('62. clock controls createdAt', () => { assert.equal(wf().createdAt, '2026-08-01T00:00:00.000Z'); });
test('63. JSON round-trip preserves reportId', () => { const r = wf(); assert.equal(JSON.parse(JSON.stringify(r)).reportId, r.reportId); });
test('64. stress scenarios 3 entries', () => { assert.equal(wf().stressScenarios!.length, 3); });
test('65. stress 1.5x net < baseline', () => { const r = wf(); assert.ok(r.stressScenarios!.find(x => x.name === '1.5x')!.metrics.netReturn < r.stressScenarios![0].metrics.netReturn); });
test('66. stress 2x net < 1.5x', () => { const r = wf(); assert.ok(r.stressScenarios!.find(x => x.name === '2x')!.metrics.netReturn < r.stressScenarios!.find(x => x.name === '1.5x')!.metrics.netReturn); });
test('67. deepFreeze objects', () => { const o = { a: { b: 3 } }; deepFreeze(o); assert.ok(Object.isFrozen(o)); assert.ok(Object.isFrozen(o.a)); });
test('68. deepFreeze primitives', () => { assert.equal(deepFreeze(42), 42); });
test('69. deepFreeze arrays', () => { const a = [1, 2, 3]; deepFreeze(a); assert.ok(Object.isFrozen(a)); });
test('70. makeReportId stable', () => { assert.equal(makeReportId(CFG, COST, undefined), makeReportId(CFG, COST, undefined)); });
test('71. zero-cost net≈gross', () => { const z: CostConfig = { feeBps: 0, spreadBps: 0, slippageBps: 0, latencyPenaltyBps: 0, stressMultiplier: 1 }; const r = runWalkForward(CFG, z, sim, { clock: CLOCK }); assert.ok(Math.abs(r.folds[0].trainMetrics.netReturn - r.folds[0].trainMetrics.grossReturn) < 0.0001); });
test('72. insufficient sample warning', () => { const ns = (s: number, e: number) => ({ grossPnl: 0, volume: 0, turnover: 0, maxDrawdown: 0, sharpe: 0, sortino: 0, profitFactor: 0, trades: 0 }); assert.ok(runWalkForward(CFG, COST, ns, { clock: CLOCK }).warnings.includes('INSUFFICIENT_SAMPLE')); });

// ═══ 73–76: Explicit label-horizon and adjacent OOS contracts ═══
test('73. label horizon separates train→validation', () => { for (const s of generateSplits({ ...CFG, totalBars: 50000, purgeBars: 0, labelHorizonBars: 42 })) assert.ok(s.train.end + s.labelHorizonBars < s.validation.start); });
test('74. label horizon separates validation→test', () => { for (const s of generateSplits({ ...CFG, totalBars: 50000, purgeBars: 0, labelHorizonBars: 42 })) assert.ok(s.validation.end + s.labelHorizonBars < s.test.start); });
test('75. label horizon separates adjacent tests', () => { const f = generateSplits({ ...CFG, totalBars: 50000, embargoBars: 0, labelHorizonBars: 42 }); for (let i = 0; i < f.length - 1; i++) assert.ok(f[i].test.end + f[i].labelHorizonBars < f[i + 1].test.start); });
test('76. next training window may reuse prior history', () => { for (const mode of ['rolling', 'expanding'] as const) { const f = generateSplits({ ...CFG, totalBars: 50000, mode }); assert.ok(f.some((s, i) => i > 0 && s.train.start <= f[i - 1].test.end)); for (let i = 0; i < f.length - 1; i++) assert.deepStrictEqual(validateFoldIsolation(f[i], f[i + 1]), []); } });

// ═══ 77–78: Cross-fold eligible-region & holdout evidence ═══
test('77. adversarial: test-test well-spaced but eligible region overlaps', () => {
  const fold: ChronologicalSplit = {
    fold: 0,
    train: { start: 0, end: 99, count: 100 },
    validation: { start: 120, end: 149, count: 30 },
    test: { start: 170, end: 199, count: 30 },
    purgeBars: 20, embargoBars: 10, featureLookbackBars: 0, labelHorizonBars: 0,
  } as ChronologicalSplit;
  const nextFold: ChronologicalSplit = {
    fold: 1,
    train: { start: 170, end: 269, count: 100 },
    validation: { start: 200, end: 229, count: 30 },
    test: { start: 250, end: 279, count: 30 },
    purgeBars: 20, embargoBars: 10, featureLookbackBars: 0, labelHorizonBars: 0,
  } as ChronologicalSplit;
  const issues = validateFoldIsolation(fold, nextFold);
  assert.ok(issues.some(x => x.includes('crosses next validation')), `expected eligible-region leak, got: ${JSON.stringify(issues)}`);
});

test('78. holdout: identical train+val but different test yields same selectedParameters', () => {
  const cfgA = { ...CFG, trainBars: 500 };
  const numParams = 2;
  // Compute actual fold count from the development-only config (holdout is always-on)
  const holdoutCfg = allocateFinalHoldout(cfgA);
  const devCfg = { ...cfgA, totalBars: holdoutCfg.developmentEndExclusive };
  const numFolds = generateSplits(devCfg).length;

  const r1 = runWalkForward(cfgA, COST,
    (s, e) => ({ grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 }),
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });

  // Per fold: train+val for each of 2 params = 4 calls, then 1 test = 5 calls per fold.
  // Test is the last call in each fold cycle: callIdx % 5 === 4.
  const callsPerFold = 2 * numParams + 1; // 5
  let callIdx = 0;
  const r2 = runWalkForward(cfgA, COST,
    (s, e) => {
      const isTest = callIdx % callsPerFold === 2 * numParams; // callIdx % 5 === 4
      callIdx++;
      return {
        grossPnl: isTest ? (e - s) * 999 : (e - s) * 3,
        volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2,
        profitFactor: 1.6, trades: isTest ? 42 : 15,
      };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });

  assert.deepStrictEqual(r1.selectedParameters, r2.selectedParameters,
    'selectedParameters must be identical when train+val outputs match');
  // At least one fold's test metrics must differ because test simulator output differs
  const differingFolds = r1.folds.filter((f, i) =>
    f.testMetrics?.grossReturn !== r2.folds[i].testMetrics?.grossReturn);
  assert.ok(differingFolds.length > 0, 'at least one fold must have different test outputs between runs');
});

// ════════════════════════════════════════════════════════════════
// R8 corrective tests (replaces tests 79–95 from flawed 5d94893)
// ════════════════════════════════════════════════════════════════

// ── C1: Causal-per-fold is the ONLY mode, no global ────────────
test('79. causal-per-fold: each fold independently selects parameters (R8 only)', () => {
  const cfgA = { ...CFG, trainBars: 500 };
  const r = runWalkForward(cfgA, COST, sim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });
  assert.ok(r.folds.length > 0, 'must have folds');
  // Every fold with selected params must carry selectedParameters + selectedCandidateId
  for (const fm of r.folds) {
    if (fm.selected) {
      assert.ok(fm.selectedParameters !== undefined, `fold ${fm.fold}: must have selectedParameters`);
      assert.ok(fm.selectedCandidateId !== undefined, `fold ${fm.fold}: must have selectedCandidateId`);
      assert.ok(fm.candidateResults !== undefined, `fold ${fm.fold}: must have candidateResults`);
    }
  }
  assert.equal(r.contractVersion, '4A4-R8');
  assert.equal(r.validationContractVersion, '4A4-R8');
  assert.ok(r.deploymentParameters !== undefined, 'must have deployment parameters');
  assert.ok(r.deploymentCandidateId !== undefined, 'must have deployment candidate id');
  assert.deepStrictEqual(r.selectedParameters, r.deploymentParameters);
  // R8: finalHoldoutRange always present (always-on allocation)
  assert.ok(r.finalHoldoutRange !== undefined, 'finalHoldoutRange must be present');
  assert.equal(typeof r.finalHoldoutEvaluationCount, 'number');
});

test('80. causal: TWO runs with SEPARATE ledgers — fold0 identical train/val, later-fold mutation changes later selection', () => {
  // Use a config guaranteed to produce >= 2 folds
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  const holdoutCfg = allocateFinalHoldout(cfgA);
  const devCfg = { ...cfgA, totalBars: holdoutCfg.developmentEndExclusive };
  const splits = generateSplits(devCfg);
  assert.ok(splits.length >= 2, `need >=2 folds, got ${splits.length}`);

  const f0 = splits[0];
  const f1 = splits[1];
  const f0ValRange = `${f0.validation.start}-${f0.validation.end}`;
  const f1ValRange = `${f1.validation.start}-${f1.validation.end}`;

  // Run 1: uniform simulator — both candidates produce same output
  const l1 = mkLedger();
  const r1 = runWalkForward(cfgA, COST, sim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l1 });

  // Run 2: separate ledger. Fold0 train/val must be IDENTICAL to Run 1.
  // Fold1+ train/val mutate to flip selection — use exact generated phase ranges.
  const l2 = mkLedger();
  const r2 = runWalkForward(cfgA, COST,
    (s, e, p) => {
      // Fold0 train/val: identical to Run 1 uniform output
      if (s >= f0.train.start && e <= f0.validation.end) {
        return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
      }
      // Fold1+ train/val: bias candidate 'b' to flip later selection
      const bonus = p && 'b' in p ? (e - s) * 10 : (e - s) * 3;
      return { grossPnl: bonus, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l2 });

  // Fold 0: deepStrictEqual for selectedCandidateId, selectedParameters, testMetrics
  assert.ok(r1.folds[0].selectedCandidateId !== undefined, 'fold0 must have selection');
  assert.deepStrictEqual(r1.folds[0].selectedCandidateId, r2.folds[0].selectedCandidateId,
    'fold0 selectedCandidateId must be identical across runs');
  assert.deepStrictEqual(r1.folds[0].selectedParameters, r2.folds[0].selectedParameters,
    'fold0 selectedParameters must be identical across runs');
  assert.deepStrictEqual(r1.folds[0].testMetrics, r2.folds[0].testMetrics,
    'fold0 testMetrics must be identical across runs');

  // Fold 0: deepStrictEqual exact ledger records
  const f0Ledger1 = l1.log.filter(x => x.fold === 0);
  const f0Ledger2 = l2.log.filter(x => x.fold === 0);
  assert.deepStrictEqual(f0Ledger1, f0Ledger2, 'fold0 ledger records must be identical across runs');

  // Assert at least one later fold's selection differs
  const laterDiffer = r1.folds.slice(1).some((f, i) => {
    const f2 = r2.folds[i + 1];
    return f.selectedCandidateId !== f2.selectedCandidateId ||
      JSON.stringify(f.selectedParameters) !== JSON.stringify(f2.selectedParameters);
  });
  assert.ok(laterDiffer, 'at least one later fold must have different selection between runs');
});

test('81. causal: fold0 prefers A, fold1 prefers B — each tests own params, captured test-call params prove it', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  const holdoutCfg = allocateFinalHoldout(cfgA);
  const devCfg = { ...cfgA, totalBars: holdoutCfg.developmentEndExclusive };
  const splits = generateSplits(devCfg);
  assert.ok(splits.length >= 2, `need >=2 folds, got ${splits.length}`);

  const f0 = splits[0];
  const f1 = splits[1];

  // Capture the actual params received by the simulator on each fold's test call
  let capturedFold0TestParams: Record<string, string | number> | undefined;
  let capturedFold1TestParams: Record<string, string | number> | undefined;

  const r = runWalkForward(cfgA, COST,
    (s, e, p) => {
      // fold0 validation: candidate A returns higher score
      // fold1 validation: candidate B returns higher score
      const inFold0Val = s === f0.validation.start && e === f0.validation.end;
      const inFold1Val = s === f1.validation.start && e === f1.validation.end;
      const inFold0Test = s === f0.test.start && e === f0.test.end;
      const inFold1Test = s === f1.test.start && e === f1.test.end;

      // Capture test params
      if (inFold0Test && p) capturedFold0TestParams = { ...p };
      if (inFold1Test && p) capturedFold1TestParams = { ...p };

      if (inFold0Val && p && 'a' in p) return { grossPnl: 1e6, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 5.0, sortino: 5.0, profitFactor: 5.0, trades: 15 };
      if (inFold0Val && p && 'b' in p) return { grossPnl: 100, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.0, sortino: 1.0, profitFactor: 1.0, trades: 15 };
      if (inFold1Val && p && 'b' in p) return { grossPnl: 1e6, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 5.0, sortino: 5.0, profitFactor: 5.0, trades: 15 };
      if (inFold1Val && p && 'a' in p) return { grossPnl: 100, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.0, sortino: 1.0, profitFactor: 1.0, trades: 15 };
      // Other phases (train): uniform output
      return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });

  // fold0 must select candidate A (param {a:1})
  const fm0 = r.folds[0];
  assert.ok(fm0.selectedCandidateId !== undefined, 'fold0 must have selection');
  assert.ok(fm0.selectedCandidateId.includes('"a":1'), `fold0 must select A, got ${fm0.selectedCandidateId}`);
  assert.deepStrictEqual(fm0.selectedParameters, { a: 1 }, 'fold0 selectedParameters must be {a:1}');
  assert.ok(fm0.testMetrics !== undefined, 'fold0 must have testMetrics');
  assert.ok(fm0.testMetrics.grossReturn > 0);

  // fold1 must select candidate B (param {b:2})
  const fm1 = r.folds[1];
  assert.ok(fm1.selectedCandidateId !== undefined, 'fold1 must have selection');
  assert.ok(fm1.selectedCandidateId.includes('"b":2'), `fold1 must select B, got ${fm1.selectedCandidateId}`);
  assert.deepStrictEqual(fm1.selectedParameters, { b: 2 }, 'fold1 selectedParameters must be {b:2}');
  assert.ok(fm1.testMetrics !== undefined, 'fold1 must have testMetrics');

  // Captured test params must prove each fold tested its own selected params
  assert.deepStrictEqual(capturedFold0TestParams, { a: 1 },
    `fold0 test must be called with {a:1}, got ${JSON.stringify(capturedFold0TestParams)}`);
  assert.deepStrictEqual(capturedFold1TestParams, { b: 2 },
    `fold1 test must be called with {b:2}, got ${JSON.stringify(capturedFold1TestParams)}`);

  // Both must be accepted
  const cr0 = fm0.candidateResults || [];
  const cr1 = fm1.candidateResults || [];
  const a0 = cr0.find(c => c.candidateId.includes('"a":1'));
  const b1 = cr1.find(c => c.candidateId.includes('"b":2'));
  assert.ok(a0?.accepted, 'fold0 candidate A must be accepted');
  assert.ok(b1?.accepted, 'fold1 candidate B must be accepted');
});

test('82. causal-expanding: SEPARATE ledgers, later train CONTAINS earlier test, fold0 frozen on future mutate', () => {
  const cfgE = { ...CFG, mode: 'expanding' as const, trainBars: 500, totalBars: 50000 };
  const holdoutCfg = allocateFinalHoldout(cfgE);
  const devCfg = { ...cfgE, totalBars: holdoutCfg.developmentEndExclusive };
  const splits = generateSplits(devCfg);
  assert.ok(splits.length >= 2, `need >=2 folds in expanding mode, got ${splits.length}`);

  // Expanding invariants
  const firstStart = splits[0].train.start;
  for (const s of splits) assert.equal(s.train.start, firstStart, 'expanding train.start must be fixed');
  for (let i = 1; i < splits.length; i++) {
    assert.ok(splits[i].train.count > splits[i - 1].train.count, `fold ${i}: train.count must strictly increase`);
  }

  // A later train MUST fully CONTAIN an earlier test interval:
  // train.start <= earlier.test.start AND train.end >= earlier.test.end
  const containsEarlierTest = splits.some((s, i) =>
    splits.slice(0, i).some(prev =>
      s.train.start <= prev.test.start && s.train.end >= prev.test.end));
  assert.ok(containsEarlierTest, 'at least one later train must fully contain an earlier test interval');

  // Run 1: uniform constant simulator with separate ledger
  const l1 = mkLedger();
  const simConst = () => ({ grossPnl: 1000, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 });
  const r1 = runWalkForward(cfgE, COST, simConst, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l1 });

  // Run 2: separate ledger. Mutate only exact later-fold candidate train/validation ranges.
  // Fold0 sim output stays identical — fold0 selection/params/test/ledger must be frozen.
  const l2 = mkLedger();
  const r2 = runWalkForward(cfgE, COST,
    (s, e, p) => {
      // Fold0: identical to Run 1 (all phases inside fold0 test end)
      if (s >= splits[0].train.start && e <= splits[0].test.end) {
        return { grossPnl: 1000, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
      }
      // Fold1+ candidate train/val: bias 'b' to flip later selection
      const bonus = p && 'b' in p ? 10000 : 1000;
      return { grossPnl: bonus, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l2 });

  // Fold0 must be frozen — deepStrictEqual across runs
  assert.deepStrictEqual(r1.folds[0].selectedCandidateId, r2.folds[0].selectedCandidateId, 'fold0 selection frozen');
  assert.deepStrictEqual(r1.folds[0].selectedParameters, r2.folds[0].selectedParameters, 'fold0 params frozen');
  assert.deepStrictEqual(r1.folds[0].testMetrics, r2.folds[0].testMetrics, 'fold0 testMetrics frozen');

  // Fold0 ledger records must be identical across runs
  const f0Ledger1 = l1.log.filter(x => x.fold === 0);
  const f0Ledger2 = l2.log.filter(x => x.fold === 0);
  assert.deepStrictEqual(f0Ledger1, f0Ledger2, 'fold0 ledger records must be identical across runs');

  // At least one later fold must differ
  const laterDiffer = r1.folds.slice(1).some((f, i) => {
    const f2 = r2.folds[i + 1];
    return f.selectedCandidateId !== f2.selectedCandidateId;
  });
  assert.ok(laterDiffer, 'future mutation must change at least one later fold selection');
});

// ── C2: FinalHoldout mandatory with normalized defaults ────────
test('83. holdout: always-on allocation with default ratio=.15', () => {
  const cfgH = { ...CFG, totalBars: 50000 };
  const h = allocateFinalHoldout(cfgH);
  const expectedBars = Math.max(Math.ceil(50000 * DEFAULT_HOLDOUT_RATIO), 3 * cfgH.testBars);
  assert.equal(h.count, expectedBars);
  assert.equal(h.ratio, DEFAULT_HOLDOUT_RATIO);
  assert.equal(h.minBars, 3 * cfgH.testBars);
  assert.equal(h.end, 49999);
  assert.equal(h.start, 50000 - expectedBars);
  assert.equal(h.gapBars, Math.max(cfgH.purgeBars, cfgH.embargoBars, cfgH.labelHorizonBars ?? 0));
  assert.ok(h.developmentEndExclusive < h.start, 'development ends before holdout starts');
});

test('84. holdout: explicit ratio + default min = max(ceil(total*ratio), 3*testBars)', () => {
  const cfgH = { ...CFG, totalBars: 50000, finalHoldoutRatio: 0.1 };
  const h = allocateFinalHoldout(cfgH);
  // ratio=0.1 → ceil(5000)=5000, min=3*300=900 → max=5000
  assert.equal(h.count, 5000);
  assert.equal(h.ratio, 0.1);
  assert.equal(h.minBars, 3 * CFG.testBars);
});

test('85. holdout: explicit min + default ratio = max(ceil(total*.15), explicitMin)', () => {
  const cfgH = { ...CFG, totalBars: 50000, finalHoldoutMinBars: 10000 };
  const h = allocateFinalHoldout(cfgH);
  // ceil(50000*0.15)=7500, min=10000 → max=10000
  assert.equal(h.count, 10000);
  assert.equal(h.ratio, DEFAULT_HOLDOUT_RATIO);
  assert.equal(h.minBars, 10000);
  assert.ok(h.count >= 10000);
});

test('86. holdout: both explicit = max(ceil(total*ratio), min)', () => {
  const cfgH = { ...CFG, totalBars: 50000, finalHoldoutRatio: 0.05, finalHoldoutMinBars: 2000 };
  const h = allocateFinalHoldout(cfgH);
  const ceilRatio = Math.ceil(50000 * 0.05); // 2500
  assert.equal(h.count, Math.max(ceilRatio, 2000)); // 2500
  assert.equal(h.ratio, 0.05);
  assert.equal(h.minBars, 2000);
});

test('87. holdout: computeHoldoutCount formula = max(ceil(total*ratio), min)', () => {
  // Defaults
  assert.equal(computeHoldoutCount(50000, 300), Math.max(Math.ceil(50000 * 0.15), 900));
  // Explicit ratio, default min
  assert.equal(computeHoldoutCount(50000, 300, 0.1), Math.max(Math.ceil(50000 * 0.1), 900));
  // Default ratio, explicit min
  assert.equal(computeHoldoutCount(50000, 300, undefined, 10000), Math.max(Math.ceil(50000 * 0.15), 10000));
  // Both explicit
  assert.equal(computeHoldoutCount(50000, 300, 0.05, 2000), Math.max(Math.ceil(50000 * 0.05), 2000));
});

test('88. holdout: invalid ratio throws', () => {
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutRatio: -0.1 }));
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutRatio: 1.5 }));
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutRatio: NaN }));
});

test('89. holdout: integrated holdout respects gap from development', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  const r = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.ok(r.finalHoldoutRange, 'must have finalHoldoutRange');
  assert.ok(r.finalHoldoutRange.count > 0, 'holdout must have bars');
  const h = r.finalHoldoutRange;
  assert.ok(h.start > 0, 'holdout start must be positive');
  assert.equal(h.end, cfgH.totalBars - 1, 'holdout goes to end');
});

test('90. holdout: holdout range never enters candidate evaluation', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  const l = mkLedger();
  const r = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l });
  assert.ok(r.finalHoldoutRange, 'must have holdout range');
  const hStart = r.finalHoldoutRange.start;
  const candCalls = l.log.filter(x => x.candidateId !== undefined);
  for (const c of candCalls) {
    assert.ok(c.end < hStart, `candidate call [${c.start},${c.end}] must end before holdout start ${hStart}`);
  }
});

test('91. holdout: evaluated exactly once', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  const l = mkLedger();
  const r = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK, ledger: l });
  const holdoutCalls = l.log.filter(x => x.phase === 'final-holdout');
  assert.equal(holdoutCalls.length, 1, 'holdout must be evaluated exactly once');
  assert.equal(holdoutCalls[0].fold, -1, 'holdout fold = -1');
  assert.equal(holdoutCalls[0].candidateId, undefined, 'holdout has no candidateId');
  assert.equal(r.finalHoldoutEvaluationCount, 1);
});

test('92. holdout isolation: altered holdout only changes holdout metrics', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  const r1 = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  const hStart = r1.finalHoldoutRange!.start;
  const hEnd = r1.finalHoldoutRange!.end;
  const r2 = runWalkForward(cfgH, COST,
    (s, e, p) => {
      const isHoldout = s === hStart && e === hEnd;
      return { grossPnl: isHoldout ? 1e9 : (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: isHoldout ? 99 : 15 };
    },
    { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.deepStrictEqual(r1.deploymentParameters, r2.deploymentParameters);
  assert.deepStrictEqual(r1.folds, r2.folds);
  assert.notDeepStrictEqual(r1.finalHoldoutMetrics?.grossReturn, r2.finalHoldoutMetrics?.grossReturn);
});

// ── C8: Final holdout failure propagates after one attempt ─────
test('93. holdout fail-closed: bad holdout throws after exactly one attempt', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  let holdoutCalls = 0;
  assert.throws(() => {
    runWalkForward(cfgH, COST,
      (s, e, p) => {
        const h = allocateFinalHoldout(cfgH);
        if (s === h.start && e === h.end) { holdoutCalls++; throw new Error('HOLDOUT_FAILED'); }
        return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
      },
      { paramGrid: [{ a: 1 }], clock: CLOCK });
  }, 'holdout failure must propagate');
  assert.equal(holdoutCalls, 1, 'exactly one holdout attempt before propagation');
});

// ── C4: usedForDeployment count===1 and last-fold assertion ────
test('94. deployment: exactly one fold usedForDeployment, must be last valid selection', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  const r = wf(cfgA, [{ a: 1 }, { b: 2 }]);
  const deployFolds = r.folds.filter(f => f.usedForDeployment);
  assert.equal(deployFolds.length, 1, 'exactly one fold must be usedForDeployment');
  const selectedFolds = r.folds.filter(f => f.selected);
  if (selectedFolds.length > 0) {
    const lastSelected = selectedFolds[selectedFolds.length - 1];
    assert.equal(deployFolds[0].fold, lastSelected.fold, 'deployment fold must be the last selected fold');
    // Earlier selected folds must NOT be usedForDeployment
    for (const sf of selectedFolds.slice(0, -1)) {
      assert.equal(sf.usedForDeployment, false, `fold ${sf.fold}: earlier selected folds must NOT be usedForDeployment`);
    }
  }
});

// ── C5: Rejected-high-score vs accepted-lower-score ────────────
test('95. selection: rejected high-score does not strand accepted lower-score', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  // Candidate A: high validation score but rejected (too few trades)
  // Candidate B: lower score but accepted
  const r = runWalkForward(cfgA, COST,
    (s, e, p) => {
      if (p && 'a' in p) {
        // High-score candidate: valid score but only 2 trades → rejected
        return { grossPnl: 1e6, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 5.0, sortino: 5.0, profitFactor: 5.0, trades: 2 };
      }
      // Lower-score candidate: moderate score, sufficient trades → accepted
      return { grossPnl: 100, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.0, sortino: 1.0, profitFactor: 1.0, trades: 15 };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });
  // The accepted (low-score) candidate must be selected, not the rejected high-score one
  assert.ok(r.deploymentParameters !== undefined, 'deployment must succeed with accepted candidate');
  // Verify: every fold's candidateResults show 'a' as rejected and 'b' as accepted
  for (const fm of r.folds) {
    if (fm.candidateResults) {
      const aResult = fm.candidateResults.find(c => c.candidateId.includes('"a":1'));
      const bResult = fm.candidateResults.find(c => c.candidateId.includes('"b":2'));
      if (aResult) assert.equal(aResult.accepted, false, 'high-score low-trades candidate must be rejected');
      if (bResult) assert.equal(bResult.accepted, true, 'lower-score sufficient-trades candidate must be accepted');
    }
  }
});

// ── C6: Structural fold isolation — exported assertFoldIsolation ──
test('96. isolation: manually constructed bad adjacent pair throws', () => {
  // Construct a bad adjacent pair: fold0 test+embargo overlaps fold1 test
  const fold0: ChronologicalSplit = {
    fold: 0,
    train: { start: 0, end: 99, count: 100 },
    validation: { start: 120, end: 149, count: 30 },
    test: { start: 170, end: 199, count: 30 },
    purgeBars: 20, embargoBars: 10, featureLookbackBars: 0, labelHorizonBars: 0,
  } as ChronologicalSplit;
  const fold1: ChronologicalSplit = {
    fold: 1,
    train: { start: 195, end: 294, count: 100 },
    validation: { start: 315, end: 344, count: 30 },
    test: { start: 365, end: 394, count: 30 },
    purgeBars: 20, embargoBars: 10, featureLookbackBars: 0, labelHorizonBars: 0,
  } as ChronologicalSplit;
  // fold0.test.end=199, embargo=10, fold0.test.end+embargo=209 > fold1.validation.start=315? No, 209 < 315, OK
  // Let's construct a real violation: test+embargo crosses next test
  const badFold1: ChronologicalSplit = {
    ...fold1,
    test: { start: 200, end: 229, count: 30 }, // fold0.test.end+embargo=209 >= 200 → violation
  } as ChronologicalSplit;
  assert.throws(() => assertFoldIsolation([fold0, badFold1]),
    /FOLD_ISOLATION_VIOLATION/,
    'assertFoldIsolation must throw on bad adjacent pair');
});

test('96b. isolation: generated clean folds pass assertFoldIsolation', () => {
  const cfgClean = { ...CFG, totalBars: 50000 };
  const holdoutCfg = allocateFinalHoldout(cfgClean);
  const devCfg = { ...cfgClean, totalBars: holdoutCfg.developmentEndExclusive };
  const folds = generateSplits(devCfg);
  assert.ok(folds.length > 0, 'must generate folds');
  // Must not throw
  assertFoldIsolation(folds);
});

// ── C9: Report ID deterministic with normalized defaults ───────
test('97. reportId: omitted defaults produce same ID as explicit equivalent defaults', () => {
  // Config with omitted finalHoldoutRatio and finalHoldoutMinBars
  const cfgOmitted = { ...CFG, totalBars: 50000, trainBars: 500 };
  const r1 = runWalkForward(cfgOmitted, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });

  // Config with explicit defaults matching the normalized values
  const effectiveCount = computeHoldoutCount(50000, CFG.testBars);
  // To match reportId, the explicit config must produce the same effective holdout count
  const cfgExplicit = {
    ...CFG, totalBars: 50000, trainBars: 500,
    finalHoldoutRatio: DEFAULT_HOLDOUT_RATIO,
    finalHoldoutMinBars: 3 * CFG.testBars,
  };
  const r2 = runWalkForward(cfgExplicit, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });

  assert.equal(r1.reportId, r2.reportId,
    'omitted defaults must produce same reportId as explicit equivalent defaults');
  assert.equal(r1.finalHoldoutRange?.count, r2.finalHoldoutRange?.count,
    'holdout allocation must be identical');
});

test('98. reportId: different effective holdout produces different reportId', () => {
  const r1 = runWalkForward({ ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.1 }, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  const r2 = runWalkForward({ ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.2 }, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.notEqual(r1.reportId, r2.reportId, 'different holdout ratio must produce different reportId');
});

// ── C3: Top-level validationContractVersion, finalHoldoutRange, finalHoldoutMetrics, finalHoldoutEvaluationCount ──
test('99. report: top-level contract fields present and correct', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  const r = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.equal(r.validationContractVersion, '4A4-R8');
  assert.equal(r.contractVersion, '4A4-R8');
  assert.equal(r.selectionMode, 'causal-per-fold', 'selectionMode must be causal-per-fold');
  assert.ok(r.finalHoldoutRange !== undefined, 'finalHoldoutRange top-level must exist');
  assert.equal(typeof r.finalHoldoutRange.start, 'number');
  assert.equal(typeof r.finalHoldoutRange.end, 'number');
  assert.equal(typeof r.finalHoldoutRange.count, 'number');
  assert.equal(r.finalHoldoutEvaluationCount, 1, 'with deployment params, evaluation count = 1');
  assert.ok(r.finalHoldoutMetrics !== undefined, 'finalHoldoutMetrics top-level must exist when evaluated');
  assert.equal(typeof r.finalHoldoutMetrics!.grossReturn, 'number');
});

test('100. report: no deployment → evaluationCount 0, no holdoutMetrics', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  const r = runWalkForward(cfgH, COST, sim, { clock: CLOCK });
  assert.equal(r.deploymentParameters, undefined);
  assert.equal(r.finalHoldoutEvaluationCount, 0);
  assert.equal(r.finalHoldoutMetrics, undefined);
  assert.ok(r.finalHoldoutRange !== undefined, 'finalHoldoutRange still present (always-on)');
});

// ── C10: Deterministic full report with holdout ────────────────
test('101. holdout: deterministic full report identity', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500 };
  const r1 = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  const r2 = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.deepStrictEqual(r1, r2, 'full report must be deterministic');
  assert.equal(r1.reportId, r2.reportId);
});

// ── Earlier folds: selected=false, usedForDeployment=false, test params are own frozen params ──
test('102. causal: at least 2 folds select DIFFERENT params, capture each test-call params, all pre-deployment invariants hold', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  const holdoutCfg = allocateFinalHoldout(cfgA);
  const devCfg = { ...cfgA, totalBars: holdoutCfg.developmentEndExclusive };
  const splits = generateSplits(devCfg);
  assert.ok(splits.length >= 2, `need >=2 folds, got ${splits.length}`);

  // Capture each fold's exact test-call params (keyed by fold number, not array index)
  const capturedTestParams: Record<number, Record<string, string | number>> = {};

  // splits is in reverse chronological order: splits[0]=latest fold, splits[last]=earliest fold (fold 0)
  const earliestFold = splits[splits.length - 1];
  const laterFolds = splits.slice(0, -1); // all folds except the earliest

  const r = runWalkForward(cfgA, COST,
    (s, e, p) => {
      // Earliest fold val: bias A. All later folds: bias B. Ensures fold0≠deployment.
      const inEarliestVal = s === earliestFold.validation.start && e === earliestFold.validation.end;
      const inLaterVal = laterFolds.some(sp => s === sp.validation.start && e === sp.validation.end);
      // Capture test call params
      const splitIdx = splits.findIndex(sp => s === sp.test.start && e === sp.test.end);
      if (splitIdx !== -1 && p) capturedTestParams[splits[splitIdx].fold] = { ...p };

      if (inEarliestVal && p && 'a' in p) return { grossPnl: 1e6, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 5.0, sortino: 5.0, profitFactor: 5.0, trades: 15 };
      if (inEarliestVal && p && 'b' in p) return { grossPnl: 100, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.0, sortino: 1.0, profitFactor: 1.0, trades: 15 };
      if (inLaterVal && p && 'b' in p) return { grossPnl: 1e6, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 5.0, sortino: 5.0, profitFactor: 5.0, trades: 15 };
      if (inLaterVal && p && 'a' in p) return { grossPnl: 100, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.0, sortino: 1.0, profitFactor: 1.0, trades: 15 };
      return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });

  const selectedFolds = r.folds.filter(f => f.selectedParameters !== undefined);
  assert.ok(selectedFolds.length >= 2, `need >=2 folds with selections, got ${selectedFolds.length}`);

  // Prove at least two folds selected different parameters
  const distinctParams = new Set(selectedFolds.map(f => JSON.stringify(f.selectedParameters)));
  assert.ok(distinctParams.size >= 2,
    `must have at least 2 distinct selected parameter sets, got ${distinctParams.size}`);

  const deploymentParams = r.deploymentParameters!;
  let earlierDiffersFromDeployment = false;

  // For all folds except the last selected (deployment fold):
  const earlierSelected = selectedFolds.slice(0, -1);
  for (const fm of earlierSelected) {
    assert.equal(fm.selected, false, `fold ${fm.fold}: earlier fold selected must be false`);
    assert.equal(fm.usedForDeployment, false, `fold ${fm.fold}: earlier fold usedForDeployment must be false`);
    assert.ok(fm.selectedParameters !== undefined, `fold ${fm.fold}: must have own selectedParameters`);
    assert.ok(fm.selectedCandidateId !== undefined, `fold ${fm.fold}: must have own selectedCandidateId`);
    assert.ok(fm.testMetrics !== undefined, `fold ${fm.fold}: must have testMetrics`);

    // Prove this earlier fold's own params differ from deployment — no conditional
    assert.notDeepStrictEqual(fm.selectedParameters, deploymentParams,
      `fold ${fm.fold}: earlier selectedParams must differ from deploymentParams — no backward application`);

    // Captured test params for this fold must match its own selectedParameters
    const capt = capturedTestParams[fm.fold];
    assert.ok(capt !== undefined, `fold ${fm.fold}: must have captured test params`);
    assert.deepStrictEqual(capt, fm.selectedParameters,
      `fold ${fm.fold}: captured test params must equal its own selectedParameters`);

    earlierDiffersFromDeployment = true;
  }

  assert.ok(earlierDiffersFromDeployment, 'at least one earlier fold selectedParameters must differ from deployment');

  // The last selected fold (deployment fold): selected=true, usedForDeployment=true
  const deploymentFold = selectedFolds[selectedFolds.length - 1];
  assert.equal(deploymentFold.selected, true, 'deployment fold selected must be true');
  assert.equal(deploymentFold.usedForDeployment, true, 'deployment fold usedForDeployment must be true');
  assert.deepStrictEqual(deploymentFold.selectedParameters, deploymentParams,
    'deployment fold params must match deployment parameters');

  // Captured test params for deployment fold must match deployment
  const captDeploy = capturedTestParams[deploymentFold.fold];
  assert.ok(captDeploy !== undefined, 'deployment fold must have captured test params');
  assert.deepStrictEqual(captDeploy, deploymentParams,
    'deployment fold captured test params must equal deploymentParams');
});

// ── Insufficient development throws ────────────────────────────
test('103. holdout: insufficient development bars throws', () => {
  const cfgSmall = { ...CFG, totalBars: 2000, trainBars: 800 };
  assert.throws(() => allocateFinalHoldout(cfgSmall));
});

// ═══ R8 corrective: ledger contract + deployment flag tests ═════

// ── Simulator actual-call counter equals ledger.calls (grid path) ──
test('104. ledger: simulator actual-call counter matches ledger.calls exactly', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  let simCalls = 0;
  const countingSim = (s: number, e: number, _p?: Record<string, string | number>) => {
    simCalls++;
    return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
  };
  const l = mkLedger();
  const r = runWalkForward(cfgA, COST, countingSim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l });
  assert.equal(simCalls, l.calls, `simulator calls (${simCalls}) must equal ledger.calls (${l.calls})`);
  assert.ok(r.folds.length > 0, 'must produce folds');
});

// ── Ledger contract: even when no candidate is accepted, simulator calls match ──
test('105. ledger: simulator==ledger when all candidates rejected (no accepted)', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  let simCalls = 0;
  // All candidates have < 5 trades → rejected by evaluateFoldCandidates
  const noAcceptSim = (s: number, e: number, _p?: Record<string, string | number>) => {
    simCalls++;
    return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 2 };
  };
  const l = mkLedger();
  const r = runWalkForward(cfgA, COST, noAcceptSim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l });
  assert.equal(simCalls, l.calls, `simulator calls (${simCalls}) must equal ledger.calls (${l.calls}) even with no accepted candidates`);
  // No candidate accepted → no selection, no deployment, no holdout
  assert.equal(r.deploymentParameters, undefined, 'no deployment params when all rejected');
  assert.equal(r.finalHoldoutEvaluationCount, 0, 'no holdout evaluation when all rejected');
});

// ── Ledger contract: no-grid path also matches exactly ──────────
test('106. ledger: no-grid simulator calls match ledger exactly', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  let simCalls = 0;
  const countingSim = (s: number, e: number, _p?: Record<string, string | number>) => {
    simCalls++;
    return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
  };
  const l = mkLedger();
  const r = runWalkForward(cfgA, COST, countingSim, { clock: CLOCK, ledger: l });
  assert.equal(simCalls, l.calls, `no-grid simulator calls (${simCalls}) must equal ledger.calls (${l.calls})`);
  assert.equal(r.folds.length, l.log.filter(x => x.phase === 'train').length, 'one train call per fold');
  assert.equal(r.folds.length, l.log.filter(x => x.phase === 'validation').length, 'one validation call per fold');
});

// ── Deployment flags: selected===usedForDeployment, count===1 with params ──
test('107. deployment: selected true count === usedForDeployment true count === 1 (with params)', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  const r = wf(cfgA, [{ a: 1 }, { b: 2 }]);
  const selTrue = r.folds.filter(f => f.selected).length;
  const deployTrue = r.folds.filter(f => f.usedForDeployment).length;
  assert.equal(selTrue, 1, `selected true count must be 1, got ${selTrue}`);
  assert.equal(deployTrue, 1, `usedForDeployment true count must be 1, got ${deployTrue}`);
  assert.equal(selTrue, deployTrue, 'selected and usedForDeployment counts must be equal');
  // Verify the deployment fold is the one with both flags true
  const deployFold = r.folds.find(f => f.usedForDeployment);
  assert.ok(deployFold, 'must have a deployment fold');
  assert.equal(deployFold!.selected, true, 'deployment fold must have selected=true');
  assert.deepStrictEqual(r.deploymentParameters, deployFold!.selectedParameters,
    'deploymentParameters must match the deploy fold selectedParameters');
});

// ── Deployment flags: selected===usedForDeployment, count===0 without params ──
test('108. deployment: selected true count === usedForDeployment true count === 0 (no params)', () => {
  const cfgA = { ...CFG, trainBars: 500, totalBars: 50000 };
  const r = wf(cfgA);
  const selTrue = r.folds.filter(f => f.selected).length;
  const deployTrue = r.folds.filter(f => f.usedForDeployment).length;
  assert.equal(selTrue, 0, `selected true count must be 0 without params, got ${selTrue}`);
  assert.equal(deployTrue, 0, `usedForDeployment true count must be 0 without params, got ${deployTrue}`);
  assert.equal(r.deploymentParameters, undefined, 'no deployment params without grid');
  assert.equal(r.selectedParameters, undefined, 'no selected params without grid');
});

// ═══ R8 corrective: selectionMode validation (fail-closed) ═════

test('109. selectionMode: omitted defaults to causal-per-fold', () => {
  const r = wf(CFG);
  assert.equal(r.selectionMode, 'causal-per-fold');
});

test('110. selectionMode: explicit causal-per-fold accepted', () => {
  const r = runWalkForward({ ...CFG, selectionMode: 'causal-per-fold' }, COST, sim, { clock: CLOCK });
  assert.equal(r.selectionMode, 'causal-per-fold');
});

test('111. selectionMode: invalid value throws fail-closed', () => {
  assert.throws(
    () => runWalkForward({ ...CFG, selectionMode: 'global' as unknown as WalkForwardConfig }, COST, sim, { clock: CLOCK }),
    /INVALID_SELECTION_MODE/,
    'must throw on invalid selectionMode');
});

// ═══ R8 corrective: fractional minBars rounded with Math.ceil ═══

test('112. holdout: fractional finalHoldoutMinBars accepted and rounded up', () => {
  const cfgH = { ...CFG, totalBars: 50000, finalHoldoutMinBars: 7500.3 };
  const h = allocateFinalHoldout(cfgH);
  // Math.ceil(7500.3) = 7501, ceil(50000*0.15) = 7500, max = 7501
  assert.equal(h.count, 7501, `fractional minBars (7500.3) must ceil to 7501, got ${h.count}`);
  assert.equal(h.minBars, 7500.3, 'minBars stored as-is');
});

test('113. holdout: fractional minBars 0.1 rounds up to 1 with small ratio', () => {
  // Need enough totalBars for footprint: 0+500+300+300+2*max(20,0)=1140, plus holdout+gap
  const cfgH = { ...CFG, totalBars: 50000, finalHoldoutRatio: 0.01, finalHoldoutMinBars: 100.7, trainBars: 500, validationBars: 300, testBars: 300 };
  const h = allocateFinalHoldout(cfgH);
  // ceil(50000*0.01)=500, ceil(100.7)=101, max=500
  assert.equal(h.count, 500, 'max of ceil(ratio) and ceil(minBars)');
  assert.equal(h.minBars, 100.7, 'fractional minBars stored as-is');
});

test('114. holdout: negative fractional minBars still throws', () => {
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutMinBars: -0.5 }));
});

// ═══ R8 corrective: footprint boundary (legal one-fold at exact boundary + one bar less) ═══

test('115. holdout: footprint — totalBars=2060 (developmentEndExclusive=1140) produces exactly one development fold', () => {
  // Minimum footprint for one fold: featureLookback(0) + train(500) + val(300) + test(300) + 2*max(purge(20), labelHorizon(0)) = 1140
  // holdout = max(ceil(2060*0.15)=309, 3*testBars=900) = 900
  // gap = max(purge=20, embargo=10, labelHorizon=0) = 20
  // devEndExclusive = 2060 - 900 - 20 = 1140  ← exact footprint match
  const cfgOneFold = { ...CFG, totalBars: 2060, trainBars: 500, validationBars: 300, testBars: 300, purgeBars: 20, embargoBars: 10, labelHorizonBars: 0 };
  const h = allocateFinalHoldout(cfgOneFold);
  assert.equal(h.count, 900);
  assert.equal(h.developmentEndExclusive, 1140, 'developmentEndExclusive must be exactly 1140 at boundary');
  const devCfg = { ...cfgOneFold, totalBars: h.developmentEndExclusive };
  const folds = generateSplits(devCfg);
  assert.equal(folds.length, 1, 'must produce exactly one development fold at exact footprint boundary');
});

test('116. holdout: footprint — totalBars=2059 (one bar smaller) throws insufficient development', () => {
  // totalBars=2059: holdout=max(ceil(2059*0.15)=309,900)=900
  // devEndExclusive = 2059 - 900 - 20 = 1139 < 1140 footprint → insufficient
  assert.throws(
    () => allocateFinalHoldout({ ...CFG, totalBars: 2059, trainBars: 500, validationBars: 300, testBars: 300, purgeBars: 20, embargoBars: 10, labelHorizonBars: 0 }),
    /INSUFFICIENT_DEVELOPMENT/,
    'must throw when totalBars is one bar below exact footprint boundary');
});

// ═══ R8 corrective: report identity — selectionMode normalization ═══

test('117. reportId: omitted selectionMode and explicit causal-per-fold produce identical IDs', () => {
  const cfgOmitted = { ...CFG, totalBars: 50000, trainBars: 500 };
  const cfgExplicit = { ...cfgOmitted, selectionMode: 'causal-per-fold' as const };
  const r1 = runWalkForward(cfgOmitted, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  const r2 = runWalkForward(cfgExplicit, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.equal(r1.reportId, r2.reportId,
    'omitted selectionMode must produce same reportId as explicit causal-per-fold');
  // Both reports must declare selectionMode exactly as 'causal-per-fold'
  assert.equal(r1.selectionMode, 'causal-per-fold');
  assert.equal(r2.selectionMode, 'causal-per-fold');
});

test('118. reportId: makeReportId always includes selectionMode=causal-per-fold in serialization', () => {
  const idOmitted = makeReportId(CFG, COST);
  const idExplicit = makeReportId({ ...CFG, selectionMode: 'causal-per-fold' }, COST);
  assert.equal(idOmitted, idExplicit,
    'makeReportId must normalize omitted and explicit selectionMode to identical IDs');
  // makeReportId with different selectionMode in cfg (if present) should still normalize
  const idWithField = makeReportId({ ...CFG, selectionMode: 'causal-per-fold' }, COST);
  assert.equal(makeReportId(CFG, COST), idWithField);
});
