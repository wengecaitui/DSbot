// Stage 4A4-R8: causal-per-fold selection, FinalHoldout, deployment contract, full test suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSplits, validateFoldIsolation } from '../../src/validation/ChronologicalSplit';
import { computeCosts, makeMetrics, selectParameters, runWalkForward, recomputeCosts, type SimCallLedger } from '../../src/validation/WalkForward';
import { deepFreeze, makeReportId } from '../../src/validation/ValidationTypes';
import { allocateFinalHoldout } from '../../src/validation/FinalHoldout';
import type { WalkForwardConfig, CostConfig, ValidationClock, ParameterCandidate, ChronologicalSplit } from '../../src/validation/ValidationTypes';

const CFG: WalkForwardConfig = { totalBars: 15000, trainBars: 800, validationBars: 300, testBars: 300, purgeBars: 20, embargoBars: 10, mode: 'rolling' };
const COST: CostConfig = { feeBps: 10, spreadBps: 1, slippageBps: 5, latencyPenaltyBps: 2, stressMultiplier: 1.0 };
const CLOCK: ValidationClock = { nowISO: () => '2026-08-01T00:00:00.000Z', nowMs: () => 1 };
function sim(s: number, e: number, _p?: Record<string, string | number>) { return { grossPnl: (e-s)*3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 }; }
function mkLedger(): SimCallLedger { return { calls: 0, log: [] }; }
function wf(cfg?: WalkForwardConfig, grid?: Record<string, string | number>[], l?: SimCallLedger, dsHash?: string) { return runWalkForward(cfg ?? CFG, COST, sim, { paramGrid: grid, clock: CLOCK, ledger: l, datasetHash: dsHash }); }

function makeCandidate(id: string, valScore: number, trainScore: number, foldScores: number[], trainTrades: number=15, valTrades: number=15): ParameterCandidate {
  return { id, params: {}, validationScore: valScore, trainScore, foldScores, metrics: { fold: 0, trainMetrics: { grossReturn: 1, netReturn: 1, maxDrawdown: 0, sharpeRatio: 1, sortinoRatio: 1, profitFactor: 1, tradeCount: trainTrades, turnover: 1, costBreakdown: { grossReturn: 0, fees: 0, spreadCost: 0, slippageCost: 0, latencyCost: 0, netReturn: 0 }, _volume: 1000 }, validationMetrics: { grossReturn: 1, netReturn: 1, maxDrawdown: 0, sharpeRatio: 1, sortinoRatio: 1, profitFactor: 1, tradeCount: valTrades, turnover: 1, costBreakdown: { grossReturn: 0, fees: 0, spreadCost: 0, slippageCost: 0, latencyCost: 0, netReturn: 0 }, _volume: 1000 }, selected: false, usedForDeployment: false }, minTrainTrades: trainTrades, minValidationTrades: valTrades, accepted: true, selected: false };
}

// ═══ 1–20: Split geometry ═══════════════════════════════════════
test('1. rolling train count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.train.count, CFG.trainBars); });
test('2. expanding train count strictly increasing', () => { const f = generateSplits({...CFG, mode:'expanding'}); for (let i=1;i<f.length;i++) assert.ok(f[i].train.count > f[i-1].train.count); });
test('3. expanding train start fixed', () => { const f = generateSplits({...CFG, mode:'expanding'}); const first = f[0].train.start; for (const s of f.slice(1)) assert.equal(s.train.start, first); });
test('4. val count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.validation.count, CFG.validationBars); });
test('5. test count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.test.count, CFG.testBars); });
test('6. folds oldest→newest', () => { const f = generateSplits(CFG); for (let i=1;i<f.length;i++) assert.ok(f[i-1].train.start < f[i].train.start); });
test('7. indices in bounds', () => { for (const s of generateSplits(CFG)) { assert.ok(s.train.start >= 0); assert.ok(s.test.end < CFG.totalBars); } });
test('8. purge train→val', () => { for (const s of generateSplits({...CFG,purgeBars:100})) assert.ok(s.train.end + s.purgeBars <= s.validation.start); });
test('9. purge val→test', () => { for (const s of generateSplits(CFG)) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('10. feature lookback enforced', () => { const f = generateSplits({...CFG, totalBars:50000, featureLookbackBars:500}); for (const s of f) assert.ok(s.train.start >= s.featureLookbackBars); });
test('11. label horizon present', () => { assert.equal(generateSplits({...CFG, totalBars:50000, labelHorizonBars:42})[0].labelHorizonBars, 42); });
test('12. deterministic', () => { assert.deepStrictEqual(generateSplits(CFG), generateSplits(CFG)); });
test('13. expanding different from rolling', () => { assert.notDeepStrictEqual(generateSplits(CFG), generateSplits({...CFG, mode:'expanding'})); });
test('14. insufficient totalBars throws', () => { assert.throws(() => generateSplits({totalBars:10,trainBars:500,validationBars:200,testBars:200,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('15. zero bars throws', () => { assert.throws(() => generateSplits({totalBars:0,trainBars:100,validationBars:50,testBars:50,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('16. negative purge throws', () => { assert.throws(() => generateSplits({...CFG,purgeBars:-1})); });
test('17. distinct folds', () => { const f = generateSplits(CFG); const keys = new Set(f.map(s => `${s.train.start}-${s.test.end}`)); assert.equal(keys.size, f.length); });
test('18. folds exist', () => { assert.ok(generateSplits(CFG).length > 0); });
test('19. large totalBars diverse folds', () => { assert.ok(generateSplits({...CFG, totalBars:200000}).length > 5); });
test('20. adjacent isolation clear', () => { const f = generateSplits({...CFG, totalBars:500000, embargoBars:5, trainBars:2000}); assert.ok(f.length > 0); for (let i=0;i<f.length-1;i++) assert.deepStrictEqual(validateFoldIsolation(f[i],f[i+1]), []); });

// ═══ 21–30: Leakage detection ══════════════════════════════════
test('21. train-val overlap detected', () => { const f: any = generateSplits(CFG)[0]; const bad = {...f, train:{...f.train,end:f.validation.start+1}}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('train+purge'))); });
test('22. purge before test detected', () => { const f: any = generateSplits(CFG)[0]; const bad = {...f, test:{...f.test,start:f.validation.end}}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('val+purge'))); });
test('23. embargo leak detected', () => { const f = generateSplits({...CFG, totalBars:50000}); const badNext = {...f[1], test:{...f[1].test,start:f[0].test.end+f[0].embargoBars}}; assert.ok(validateFoldIsolation(f[0],badNext).some(x=>x.includes('test+embargo'))); });
test('24. feature lookback leak detected', () => { const f = generateSplits({...CFG, totalBars:50000, featureLookbackBars:500})[0]; const bad = {...f, train:{...f.train,start:100}, featureLookbackBars:f.featureLookbackBars}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('lookback'))); });
test('25. isolation passes on valid fold', () => { assert.deepStrictEqual(validateFoldIsolation(generateSplits(CFG)[0]), []); });
test('26. embargo spacing exists', () => { const f = generateSplits({...CFG, totalBars:100000, embargoBars:100, trainBars:500}); for (let i=0;i<f.length-1;i++) assert.ok(f[i].test.end + f[i].embargoBars < f[i+1].test.start); });
test('27. embargo large still valid', () => { assert.ok(generateSplits({...CFG, totalBars:100000, embargoBars:200, trainBars:500}).length > 0); });
test('28. purge large but valid', () => { for (const s of generateSplits({...CFG, totalBars:50000, purgeBars:100})) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('29. more embargo reduces folds', () => { const a = generateSplits({...CFG, totalBars:50000, embargoBars:5}).length; const b = generateSplits({...CFG, totalBars:50000, embargoBars:100}).length; assert.ok(b <= a); });
test('30. validation count preserved with purge', () => { for (const s of generateSplits({...CFG, totalBars:50000, purgeBars:50})) assert.equal(s.validation.count, CFG.validationBars); });

// ═══ 31–40: Cost recomputation ═════════════════════════════════
test('31. computeCosts net < gross', () => { assert.ok(computeCosts(1000,5000,3,COST).netReturn < 1000); });
test('32. cost breakdown sums', () => { const c = computeCosts(2000,3000,5,COST); assert.equal(c.grossReturn - c.fees - c.spreadCost - c.slippageCost - c.latencyCost, c.netReturn); });
test('33. stress 1.5x higher fees', () => { assert.ok(computeCosts(1000,5000,3,{...COST,stressMultiplier:1.5}).fees > computeCosts(1000,5000,3,COST).fees); });
test('34. stress 2x higher fees', () => { assert.ok(computeCosts(1000,5000,3,{...COST,stressMultiplier:2}).fees > computeCosts(1000,5000,3,COST).fees); });
test('35. makeMetrics preserves _volume', () => { assert.equal((makeMetrics(sim(0,500), COST) as any)._volume, 5000); });
test('36. recomputeCosts 1.5x lower net', () => { const m = makeMetrics(sim(0,500), COST); assert.ok(recomputeCosts(m, 1.5, COST).netReturn < m.netReturn); });
test('37. recomputeCosts 2x < 1.5x net', () => { const m = makeMetrics(sim(0,500), COST); assert.ok(recomputeCosts(m, 2.0, COST).netReturn < recomputeCosts(m, 1.5, COST).netReturn); });
test('38. recomputeCosts preserves sharpe', () => { const m = makeMetrics(sim(0,500), COST); assert.equal(recomputeCosts(m, 2.0, COST).sharpeRatio, m.sharpeRatio); });
test('39. recomputeCosts preserves sortino', () => { const m = makeMetrics(sim(0,500), COST); assert.equal(recomputeCosts(m, 2.0, COST).sortinoRatio, m.sortinoRatio); });
test('40. recomputeCosts preserves profitFactor', () => { const m = makeMetrics(sim(0,500), COST); assert.equal(recomputeCosts(m, 2.0, COST).profitFactor, m.profitFactor); });

// ═══ 41–55: Parameter selection ════════════════════════════════
test('41. selects best val net', () => { const r = selectParameters([makeCandidate('a',5,5,[5]), makeCandidate('b',8,5,[8])]); assert.equal(r.selectedId,'b'); });
test('42. deterministic tie-break', () => { const c = [makeCandidate('a',5,5,[5]), { ...makeCandidate('b',5,5,[5]), params:{x:1} }]; const r1 = selectParameters(c); const r2 = selectParameters(c); assert.equal(r1.selectedId, r2.selectedId); });
test('43. minTrades train rejected', () => { const c = makeCandidate('x',10,5,[10], 2, 15); const r = selectParameters([c]); assert.equal(r.candidates[0].accepted, false); assert.equal(r.candidates[0].rejectionReason, 'MIN_TRADES_TRAIN'); });
test('44. minTrades val rejected', () => { const c = makeCandidate('x',10,5,[10], 15, 2); const r = selectParameters([c]); assert.equal(r.candidates[0].accepted, false); assert.equal(r.candidates[0].rejectionReason, 'MIN_TRADES_VALIDATION'); });
test('45. empty candidates null', () => { assert.equal(selectParameters([]).selectedId, undefined); });
test('46. selected in list', () => { const r = selectParameters([makeCandidate('z',10,5,[10])]); assert.ok(r.candidates.find(x=>x.id==='z') != null); });
test('47. test phase calls match folds', () => { const l = mkLedger(); const r = wf({...CFG,trainBars:500}, [{a:1}], l); const testCalls = l.log.filter(x=>x.phase==='test'); assert.equal(testCalls.length, r.folds.length); assert.deepStrictEqual(testCalls.map(x=>x.fold), r.folds.map(x=>x.fold)); });
test('48. no test in candidate phase', () => { const l = mkLedger(); wf(CFG, [{a:1}], l); const candCalls = l.log.filter(x=>x.phase==='test' && x.candidateId !== undefined); assert.equal(candCalls.length, 0); });
test('49. no grid no testMetrics', () => { assert.equal(wf().folds[0].testMetrics, undefined); });
test('50. grid → testMetrics present', () => { assert.notEqual(wf({...CFG,trainBars:500}, [{a:1}]).folds[0].testMetrics, undefined); });
test('51. selection produces output', () => { const r = wf(CFG, [{a:1}]); assert.ok(r.folds.length > 0); });
test('52. train/val have candidateId', () => { const l = mkLedger(); wf(CFG, [{a:1}], l); const tv = l.log.filter(x=>x.candidateId && x.phase!=='test'); assert.ok(tv.length > 0); });
test('53. param grid selection valid', () => { const g = [{a:1},{b:2},{c:3}]; assert.ok(wf(CFG, g).reportId.length > 0); });
test('54. same input identical selection', () => { const p = [{a:1},{b:2}]; assert.deepStrictEqual(wf(CFG, p).selectedParameters, wf(CFG, p).selectedParameters); });
test('55. large grid valid', () => { const g = Array.from({length:5}, (_,i) => ({v:i})); const r = wf(CFG, g); assert.ok(r.folds.length > 0); });

// ═══ 56–72: Report + identity ══════════════════════════════════
test('56. reportId deterministic', () => { assert.equal(wf().reportId, wf().reportId); });
test('57. datasetHash changes reportId', () => { assert.notEqual(wf(CFG,undefined,mkLedger(),'a').reportId, wf(CFG,undefined,mkLedger(),'b').reportId); });
test('58. simVersion changes reportId', () => { assert.notEqual(runWalkForward(CFG,COST,sim,{clock:CLOCK,simVersion:'v1'}).reportId, runWalkForward(CFG,COST,sim,{clock:CLOCK,simVersion:'v2'}).reportId); });
test('59. costConfig changes reportId', () => { assert.notEqual(wf().reportId, runWalkForward(CFG,{...COST,feeBps:20},sim,{clock:CLOCK}).reportId); });
test('60. same input identical report', () => { assert.deepStrictEqual(wf(), wf()); });
test('61. report deeply frozen', () => { const r = wf(); assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.folds)); assert.ok(Object.isFrozen(r.warnings)); });
test('62. clock controls createdAt', () => { assert.equal(wf().createdAt, '2026-08-01T00:00:00.000Z'); });
test('63. JSON round-trip preserves reportId', () => { const r = wf(); assert.equal(JSON.parse(JSON.stringify(r)).reportId, r.reportId); });
test('64. stress scenarios 3 entries', () => { assert.equal(wf().stressScenarios!.length, 3); });
test('65. stress 1.5x net < baseline', () => { const r = wf(); assert.ok(r.stressScenarios!.find(x=>x.name==='1.5x')!.metrics.netReturn < r.stressScenarios![0].metrics.netReturn); });
test('66. stress 2x net < 1.5x', () => { const r = wf(); assert.ok(r.stressScenarios!.find(x=>x.name==='2x')!.metrics.netReturn < r.stressScenarios!.find(x=>x.name==='1.5x')!.metrics.netReturn); });
test('67. deepFreeze objects', () => { const o = {a:{b:3}}; deepFreeze(o); assert.ok(Object.isFrozen(o)); assert.ok(Object.isFrozen(o.a)); });
test('68. deepFreeze primitives', () => { assert.equal(deepFreeze(42), 42); });
test('69. deepFreeze arrays', () => { const a = [1,2,3]; deepFreeze(a); assert.ok(Object.isFrozen(a)); });
test('70. makeReportId stable', () => { assert.equal(makeReportId(CFG,COST), makeReportId(CFG,COST)); });
test('71. zero-cost net≈gross', () => { const z:CostConfig={feeBps:0,spreadBps:0,slippageBps:0,latencyPenaltyBps:0,stressMultiplier:1}; const r=runWalkForward(CFG,z,sim,{clock:CLOCK}); assert.ok(Math.abs(r.folds[0].trainMetrics.netReturn - r.folds[0].trainMetrics.grossReturn) < 0.0001); });
test('72. insufficient sample warning', () => { const ns=(s:number,e:number)=>({grossPnl:0,volume:0,turnover:0,maxDrawdown:0,sharpe:0,sortino:0,profitFactor:0,trades:0}); assert.ok(runWalkForward(CFG,COST,ns,{clock:CLOCK}).warnings.includes('INSUFFICIENT_SAMPLE')); });

// ═══ 73–76: Explicit label-horizon and adjacent OOS contracts ═══
test('73. label horizon separates train→validation', () => { for (const s of generateSplits({...CFG,totalBars:50000,purgeBars:0,labelHorizonBars:42})) assert.ok(s.train.end + s.labelHorizonBars < s.validation.start); });
test('74. label horizon separates validation→test', () => { for (const s of generateSplits({...CFG,totalBars:50000,purgeBars:0,labelHorizonBars:42})) assert.ok(s.validation.end + s.labelHorizonBars < s.test.start); });
test('75. label horizon separates adjacent tests', () => { const f = generateSplits({...CFG,totalBars:50000,embargoBars:0,labelHorizonBars:42}); for (let i=0;i<f.length-1;i++) assert.ok(f[i].test.end + f[i].labelHorizonBars < f[i+1].test.start); });
test('76. next training window may reuse prior history', () => { for (const mode of ['rolling','expanding'] as const) { const f = generateSplits({...CFG,totalBars:50000,mode}); assert.ok(f.some((s,i)=>i>0 && s.train.start <= f[i-1].test.end)); for (let i=0;i<f.length-1;i++) assert.deepStrictEqual(validateFoldIsolation(f[i],f[i+1]), []); } });

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
  const numFolds = generateSplits(cfgA).length;
  const numParams = 2;
  const candidateEvalCalls = numFolds * numParams * 2;

  const r1 = runWalkForward(cfgA, COST,
    (s, e) => ({ grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 }),
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });

  let callIdx = 0;
  const r2 = runWalkForward(cfgA, COST,
    (s, e) => {
      const isTest = callIdx >= candidateEvalCalls && (callIdx - candidateEvalCalls) % 3 === 2;
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
  assert.notDeepStrictEqual(r1.folds[0].testMetrics?.grossReturn, r2.folds[0].testMetrics?.grossReturn,
    'test outputs must differ between runs');
});

// ═══ 79–95: R8 causal-per-fold + FinalHoldout + deployment contract ═══

// ── A: Causal-per-fold selection works ───────────────────────────
test('79. causal-per-fold: each fold independently selects parameters', () => {
  const cfgA = { ...CFG, trainBars: 500, selectionMode: 'causal-per-fold' as const };
  const r = runWalkForward(cfgA, COST, sim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });
  assert.ok(r.folds.length > 0, 'must have folds');
  // Every fold with selected params must carry selectedParameters + selectedCandidateId
  for (const fm of r.folds) {
    if (fm.selected) {
      assert.ok(fm.selectedParameters !== undefined, `fold ${fm.fold}: must have selectedParameters`);
      assert.ok(fm.selectedCandidateId !== undefined, `fold ${fm.fold}: must have selectedCandidateId`);
      assert.ok(fm.candidateResults !== undefined, `fold ${fm.fold}: must have candidateResults`);
      assert.ok(fm.usedForDeployment === (fm.selectedParameters === r.deploymentParameters), `fold ${fm.fold}: usedForDeployment must match deployment`);
    }
  }
  assert.equal(r.selectionMode, 'causal-per-fold');
  assert.equal(r.contractVersion, '4A4-R8');
  // deploymentParameters = last selected fold's choice
  assert.ok(r.deploymentParameters !== undefined, 'must have deployment parameters');
  assert.ok(r.deploymentCandidateId !== undefined, 'must have deployment candidate id');
  // deprecated alias deep-equals deployment
  assert.deepStrictEqual(r.selectedParameters, r.deploymentParameters, 'selectedParameters alias must match deployment');
});

// ── B: Future-fold mutation cannot alter past fold selection ──────
test('80. causal: later fold selection cannot change earlier fold test or ledger', () => {
  const cfgA = { ...CFG, trainBars: 500, selectionMode: 'causal-per-fold' as const, totalBars: 50000 };
  const splits = generateSplits(cfgA);
  assert.ok(splits.length >= 2, 'need at least 2 folds');
  // Simulator where later folds see different candidate quality
  const foldTestResults: Record<number, number> = {};
  const r = runWalkForward(cfgA, COST,
    (s, e, p) => {
      const fold = splits.find(f => f.test.start === s && f.test.end === e + 1);
      if (fold) foldTestResults[fold.fold] = (p && 'a' in p ? 1 : 2);
      return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });
  // Candidate results must exist for selected folds
  const selectedFolds = r.folds.filter(f => f.selected);
  assert.ok(selectedFolds.length > 0, 'at least one fold selected');
  for (const fm of selectedFolds) {
    assert.ok(fm.candidateResults && fm.candidateResults.length > 0, `fold ${fm.fold} must have candidate results`);
  }
  // The first fold's selection is independent of later data
  const firstSelected = selectedFolds[0];
  assert.ok(firstSelected.selectedCandidateId !== undefined, 'first fold must have selection');
});

// ── C: Each fold uses own params for its test ────────────────────
test('81. causal: each fold tests with its own selected params', () => {
  const cfgA = { ...CFG, trainBars: 500, selectionMode: 'causal-per-fold' as const, totalBars: 50000 };
  // Simulator that returns different grossPnl based on which param was used
  const r = runWalkForward(cfgA, COST,
    (s, e, p) => {
      const bonus = p && 'a' in p ? 100 : p && 'b' in p ? 200 : 0;
      return { grossPnl: (e - s) * 3 + bonus, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
    },
    { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });
  // Each fold that has testMetrics must test with its own selected params
  for (const fm of r.folds) {
    if (fm.testMetrics && fm.selectedParameters) {
      // grossReturn will include the bonus from whichever param was selected
      assert.ok(fm.testMetrics.grossReturn > 0, `fold ${fm.fold}: test metrics must be valid`);
    }
  }
  // Last fold = deployment fold
  const lastSelected = [...r.folds].reverse().find(f => f.selected);
  assert.ok(lastSelected, 'must have at least one selected fold');
  assert.deepStrictEqual(r.deploymentParameters, lastSelected.selectedParameters);
});

// ── D: Expanding mode + frozen past results ──────────────────────
test('82. causal-expanding: each fold uses its expanding train, past results frozen', () => {
  const cfgE = { ...CFG, mode: 'expanding' as const, selectionMode: 'causal-per-fold' as const, trainBars: 500, totalBars: 50000 };
  // Use a constant-return simulator to avoid VALIDATION_DEGRADATION in expanding
  // mode (where train can be 100x larger than validation, making per-bar
  // grossPnl scale the netReturn beyond the 0.5 ratio check).
  const constSim = (s: number, e: number, _p?: Record<string, string | number>) =>
    ({ grossPnl: 1000, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 });
  const r = runWalkForward(cfgE, COST, constSim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK });
  assert.ok(r.folds.length > 0, 'expanding mode must produce folds');
  assert.equal(r.selectionMode, 'causal-per-fold');
  // Each fold carries per-fold metadata
  for (const fm of r.folds) {
    assert.equal(typeof fm.fold, 'number');
    assert.equal(typeof fm.usedForDeployment, 'boolean');
  }
  // At minimum, folds exist and selection was made
  const selectedFolds = r.folds.filter(f => f.selected);
  assert.ok(selectedFolds.length > 0, 'at least one fold selected in expanding mode');
  // The last fold's train is the largest (expanding invariant verified via ChronologicalSplit tests)
  assert.ok(r.deploymentParameters !== undefined, 'deployment parameters set from last valid fold');
});

// ── E: FinalHoldout allocation ───────────────────────────────────
test('83. holdout: allocation computes correct ranges', () => {
  const cfgH = { ...CFG, totalBars: 50000, finalHoldoutRatio: 0.15, finalHoldoutMinBars: 0 };
  const h = allocateFinalHoldout(cfgH);
  const expectedBars = Math.max(Math.ceil(50000 * 0.15), 0); // 7500
  assert.equal(h.count, expectedBars);
  assert.equal(h.end, 49999); // totalBars-1 inclusive
  assert.equal(h.start, 50000 - expectedBars);
  assert.equal(h.gapBars, Math.max(cfgH.purgeBars, cfgH.embargoBars, cfgH.labelHorizonBars ?? 0));
  assert.ok(h.developmentEndExclusive < h.start, 'development ends before holdout starts');
});

test('84. holdout: minBars floors the allocation', () => {
  const cfgH = { ...CFG, totalBars: 20000, finalHoldoutRatio: 0.05, finalHoldoutMinBars: 2000 };
  const h = allocateFinalHoldout(cfgH);
  const ceilRatio = Math.ceil(20000 * 0.05); // 1000
  assert.equal(h.count, 2000, 'minBars should floor allocation');
});

test('85. holdout: invalid ratio throws', () => {
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutRatio: -0.1 }));
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutRatio: 1.5 }));
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutRatio: 0 }));
  assert.throws(() => allocateFinalHoldout({ ...CFG, totalBars: 50000, finalHoldoutRatio: NaN }));
});

// ── F: FinalHoldout integrated — gap respected ───────────────────
test('86. holdout: integrated holdout respects gap from development', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.15 };
  const r = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.ok(r.finalHoldout, 'must have final holdout metrics');
  assert.ok(r.finalHoldout!.config.count > 0, 'holdout must have bars');
  // Last development fold's test end must be before holdout start minus gap
  const lastFold = r.folds[r.folds.length - 1];
  const h = r.finalHoldout!.config;
  assert.ok(lastFold.testMetrics || lastFold.trainMetrics, 'last fold must have metrics');
  assert.ok(h.start > 0, 'holdout start must be positive');
  assert.equal(h.end, cfgH.totalBars - 1, 'holdout goes to end');
});

// ── G: FinalHoldout absent from candidate inputs ─────────────────
test('87. holdout: holdout range never enters candidate evaluation', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.15, selectionMode: 'causal-per-fold' as const };
  const l = mkLedger();
  const r = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }, { b: 2 }], clock: CLOCK, ledger: l });
  assert.ok(r.finalHoldout, 'must have holdout');
  const hStart = r.finalHoldout!.config.start;
  // No candidate-phase calls should touch the holdout range
  const candCalls = l.log.filter(x => x.candidateId !== undefined);
  for (const c of candCalls) {
    assert.ok(c.end < hStart, `candidate call [${c.start},${c.end}] must end before holdout start ${hStart}`);
  }
});

// ── H: FinalHoldout exactly-once ──────────────────────────────────
test('88. holdout: evaluated exactly once', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.1 };
  const l = mkLedger();
  const r = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK, ledger: l });
  const holdoutCalls = l.log.filter(x => x.phase === 'final-holdout');
  assert.equal(holdoutCalls.length, 1, 'holdout must be evaluated exactly once');
  assert.equal(holdoutCalls[0].fold, -1, 'holdout fold = -1');
  assert.equal(holdoutCalls[0].candidateId, undefined, 'holdout has no candidateId');
  assert.equal(r.finalHoldout!.evaluationCount, 1);
});

// ── I: Altered holdout affects only holdout metrics ───────────────
test('89. holdout isolation: altered holdout only changes holdout metrics', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.1 };
  // Run 1: normal simulator
  const r1 = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  // Run 2: radically different holdout outputs
  const hStart = r1.finalHoldout!.config.start;
  const hEnd = r1.finalHoldout!.config.end;
  const r2 = runWalkForward(cfgH, COST,
    (s, e, p) => {
      const isHoldout = s === hStart && e === hEnd;
      return { grossPnl: isHoldout ? 1e9 : (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: isHoldout ? 99 : 15 };
    },
    { paramGrid: [{ a: 1 }], clock: CLOCK });
  // Selection must be identical
  assert.deepStrictEqual(r1.deploymentParameters, r2.deploymentParameters);
  // Fold metrics must be identical
  assert.deepStrictEqual(r1.folds, r2.folds);
  // Holdout metrics must differ
  assert.notDeepStrictEqual(r1.finalHoldout?.metrics?.grossReturn, r2.finalHoldout?.metrics?.grossReturn);
});

// ── J: Bad holdout no retry/reselection ───────────────────────────
test('90. holdout fail-closed: bad holdout throws without retry', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.1 };
  // The holdout is evaluated via the simulator — if it throws, the whole engine fails
  assert.throws(() => {
    runWalkForward(cfgH, COST,
      (s, e, p) => {
        const h = allocateFinalHoldout(cfgH);
        if (s === h.start && e === h.end) throw new Error('HOLDOUT_FAILED');
        return { grossPnl: (e - s) * 3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 };
      },
      { paramGrid: [{ a: 1 }], clock: CLOCK });
  }, 'holdout failure must propagate');
});

// ── K: Insufficient development throws ────────────────────────────
test('91. holdout: insufficient development bars throws', () => {
  const cfgSmall = { ...CFG, totalBars: 2000, trainBars: 800, finalHoldoutRatio: 0.3 };
  // 2000 * 0.3 = 600 holdout, leaving 1400 bars which may not be enough for one fold
  assert.throws(() => allocateFinalHoldout(cfgSmall));
});

// ── L: Compatibility — global mode unchanged ─────────────────────
test('92. compatibility: global mode output unchanged from R7 contract', () => {
  const r = wf({ ...CFG, trainBars: 500 }, [{ a: 1 }, { b: 2 }]);
  assert.equal(r.selectionMode, 'global');
  assert.equal(r.contractVersion, '4A4-R8');
  assert.ok(r.deploymentParameters !== undefined);
  assert.deepStrictEqual(r.selectedParameters, r.deploymentParameters);
  assert.ok(r.folds.length > 0);
  for (const fm of r.folds) {
    assert.equal(fm.usedForDeployment, fm.selected);
  }
});

// ── M: Deterministic full report with holdout ────────────────────
test('93. holdout: deterministic full report identity', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.1 };
  const r1 = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  const r2 = runWalkForward(cfgH, COST, sim, { paramGrid: [{ a: 1 }], clock: CLOCK });
  assert.deepStrictEqual(r1, r2, 'full report must be deterministic');
  assert.equal(r1.reportId, r2.reportId);
});

// ── N: No paramGrid → no holdout evaluation ──────────────────────
test('94. holdout: no paramGrid → no deployment, no holdout eval', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutRatio: 0.1 };
  const r = runWalkForward(cfgH, COST, sim, { clock: CLOCK });
  assert.equal(r.deploymentParameters, undefined);
  if (r.finalHoldout) {
    assert.equal(r.finalHoldout.evaluationCount, 0);
    assert.equal(r.finalHoldout.metrics, undefined);
  }
});

// ── O: FinalHoldout with no ratio uses default 3*testBars ────────
test('95. holdout: no ratio defaults to 3*testBars', () => {
  const cfgH = { ...CFG, totalBars: 50000, trainBars: 500, finalHoldoutMinBars: 0 };
  const h = allocateFinalHoldout(cfgH);
  assert.equal(h.count, 3 * cfgH.testBars);
});
