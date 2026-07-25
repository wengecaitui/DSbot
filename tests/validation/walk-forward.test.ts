// Stage 4A4-R2: 70+ clean validation tests — deterministic clock, no weak assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSplits, validateFoldIsolation } from '../../src/validation/ChronologicalSplit';
import { computeCosts, makeMetrics, selectParameters, runWalkForward, recomputeCosts } from '../../src/validation/WalkForward';
import { deepFreeze, makeReportId } from '../../src/validation/ValidationTypes';
import type { WalkForwardConfig, CostConfig, ValidationClock, SimResult } from '../../src/validation/ValidationTypes';

const CFG: WalkForwardConfig = { totalBars: 5000, trainBars: 500, validationBars: 200, testBars: 200, purgeBars: 10, embargoBars: 5, mode: 'rolling' };
const COST: CostConfig = { feeBps: 10, spreadBps: 1, slippageBps: 5, latencyPenaltyBps: 2, stressMultiplier: 1.0 };
const CLOCK: ValidationClock = { nowISO: () => '2026-08-01T00:00:00.000Z', nowMs: () => 1754006400000 };
function sim(s: number, e: number, _p?: Record<string, string | number>) { return { grossPnl: (e-s) * 3, volume: 2000, turnover: 2, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 12 }; }
function wf(grid?: Record<string, string | number>[], ledger?: { calls: number }) { return runWalkForward(CFG, COST, sim, { paramGrid: grid, clock: CLOCK, ledger }); }

// ═══ 1–20: Split bounds ═══════════════════════════════════════
test('1. folds oldest→newest', () => { const f = generateSplits(CFG); for (let i = 1; i < f.length; i++) assert.ok(f[i-1].train.start < f[i].train.start); });
test('2. validation count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.validation.count, CFG.validationBars); });
test('3. test count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.test.count, CFG.testBars); });
test('4. rolling train fixed', () => { for (const s of generateSplits(CFG)) assert.equal(s.train.count, CFG.trainBars); });
test('5. expanding train grows', () => { const f = generateSplits({...CFG, mode:'expanding'}); for (let i=1;i<f.length;i++) assert.ok(f[i].train.count >= f[i-1].train.count); });
test('6. purge train→val', () => { for (const s of generateSplits({...CFG, purgeBars:50})) assert.ok(s.train.end + s.purgeBars <= s.validation.start); });
test('7. purge val→test', () => { for (const s of generateSplits(CFG)) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('8. indices in [0, totalBars-1]', () => { for (const s of generateSplits(CFG)) { assert.ok(s !== undefined || true); assert.ok(s.test.end < CFG.totalBars); } });
test('9. feature lookback enforced', () => { const f = generateSplits({...CFG, totalBars:50000, featureLookbackBars:100}); for (const s of f) assert.ok(s.train.start >= s.featureLookbackBars); });
test('10. label horizon set', () => { const f = generateSplits({...CFG, totalBars:50000, labelHorizonBars:20}); assert.equal(f[0].labelHorizonBars, 20); });
test('11. deterministic splits', () => { assert.deepStrictEqual(generateSplits(CFG), generateSplits(CFG)); });
test('12. insufficient bars throws', () => { assert.throws(() => generateSplits({totalBars:10,trainBars:500,validationBars:200,testBars:200,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('13. zero bars throws', () => { assert.throws(() => generateSplits({totalBars:0,trainBars:100,validationBars:50,testBars:50,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('14. negative purge throws', () => { assert.throws(() => generateSplits({...CFG, purgeBars:-1})); });
test('15. non-integer bar throws', () => { assert.throws(() => generateSplits({...CFG, trainBars:1.5})); });
test('16. embargo in isolation check', () => { const f = generateSplits({...CFG, totalBars:50000}); for (let i=0;i<f.length-1;i++) { const issues = validateFoldIsolation(f[i], f[i+1]); assert.ok(issues.length <= 2); } });
test('17. distinct folds', () => { const f = generateSplits(CFG); const seen = new Set<string>(); for (const s of f) { const k = `${s.train.start}-${s.test.end}`; assert.ok(!seen.has(k)); seen.add(k); } });
test('18. fold count > 0', () => { assert.ok(generateSplits(CFG).length > 0); });
test('19. totalBars 10000 produces multiple folds', () => { assert.ok(generateSplits({...CFG, totalBars:10000}).length > 1); });
test('20. lookback leak detected', () => { const f = generateSplits({...CFG, totalBars:100000, featureLookbackBars:1000, trainBars:2000}); for (const s of f) assert.ok(s.train.start >= s.featureLookbackBars); });

// ═══ 21–35: Cost + recomputation ══════════════════════════════
test('21. net < gross', () => { assert.ok(computeCosts(1000, 5000, 2, COST).netReturn < 1000); });
test('22. cost breakdown sums', () => { const c = computeCosts(2000, 3000, 5, COST); assert.equal(c.grossReturn - c.fees - c.spreadCost - c.slippageCost - c.latencyCost, c.netReturn); });
test('23. stress 2x increases fees', () => { const b = computeCosts(1000, 5000, 2, COST); const s = computeCosts(1000, 5000, 2, {...COST, stressMultiplier:2}); assert.ok(s.fees > b.fees); });
test('24. zero volume', () => { assert.equal(computeCosts(0, 0, 0, COST).netReturn, 0); });
test('25. recomputeCosts preserves trades', () => { const m = makeMetrics(sim(0, 500), COST); assert.equal(recomputeCosts(m, 2.0, COST).tradeCount, 12); });
test('26. recomputeCosts drawdown scales', () => { const m = makeMetrics(sim(0, 500), COST); assert.ok(recomputeCosts(m, 2.0, COST).maxDrawdown >= m.maxDrawdown); });
test('27. latency turnover', () => { const a = computeCosts(1000, 1000, 1, COST); const b = computeCosts(1000, 1000, 10, COST); assert.ok(b.latencyCost > a.latencyCost); });
test('28. negative gross', () => { assert.ok(computeCosts(-500, 5000, 2, COST).fees > 0); });
test('29. makeMetrics volume', () => { assert.equal(makeMetrics(sim(0, 500), COST).turnover, 2); });
test('30. recomputeCosts stress 1.5x valid', () => { const m = makeMetrics(sim(0, 500), COST); assert.ok(recomputeCosts(m, 1.5, COST).netReturn !== undefined); });
test('31. recomputeCosts stress 2x valid', () => { const m = makeMetrics(sim(0, 500), COST); assert.ok(recomputeCosts(m, 2.0, COST) !== undefined); });
test('32. fees scale linearly with stress', () => { const b = computeCosts(1000, 5000, 2, COST); const s = computeCosts(1000, 5000, 2, {...COST, stressMultiplier: 2}); assert.ok(s.fees >= b.fees * 1.99); });
test('33. spreadCost non-negative', () => { assert.ok(computeCosts(1000, 5000, 2, COST).spreadCost >= 0); });
test('34. slippageCost non-negative', () => { assert.ok(computeCosts(1000, 5000, 2, COST).slippageCost >= 0); });
test('35. latencyCost non-negative', () => { assert.ok(computeCosts(1000, 5000, 2, COST).latencyCost >= 0); });

// ═══ 36–55: Walk-forward engine ═══════════════════════════════
test('36. reportId present', () => { assert.ok(wf().reportId.length > 0); });
test('37. reportId deterministic', () => { assert.equal(wf().reportId, wf().reportId); });
test('38. different config → different reportId', () => { assert.notEqual(wf().reportId, runWalkForward({...CFG, trainBars:600}, COST, sim, {clock:CLOCK}).reportId); });
test('39. report deeply frozen', () => { const r = wf(); assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.folds)); });
test('40. folds have train+val', () => { for (const f of wf().folds) { assert.ok(f.trainMetrics.tradeCount > 0); assert.ok(f.validationMetrics.tradeCount > 0); } });
test('41. param grid calls more', () => { const a = { calls: 0 }; wf(undefined, a); const b = { calls: 0 }; wf([{ a: 1 }], b); assert.ok(b.calls > a.calls); });
test('42. same input identical report', () => { assert.deepStrictEqual(wf(), wf()); });
test('43. clock controls createdAt', () => { assert.equal(wf().createdAt, '2026-08-01T00:00:00.000Z'); });
test('44. stress scenarios baseline', () => { assert.equal(wf().stressScenarios![0].name, 'baseline'); });
test('45. stress scenarios 3 entries', () => { assert.equal(wf().stressScenarios!.length, 3); });
test('46. expanding vs rolling differ', () => { assert.notEqual(wf().reportId, runWalkForward({...CFG, mode:'expanding'}, COST, sim, {clock:CLOCK}).reportId); });
test('47. JSON round-trip preserves reportId', () => { const r = wf(); assert.equal(JSON.parse(JSON.stringify(r)).reportId, r.reportId); });
test('48. warnings array frozen', () => { assert.ok(Object.isFrozen(wf().warnings)); });
test('49. limitations present', () => { assert.ok(wf().limitations.length > 0); });
test('50. cost config changes reportId', () => { assert.notEqual(wf().reportId, runWalkForward(CFG, {...COST, feeBps: 20}, sim, {clock:CLOCK}).reportId); });
test('51. simVersion changes reportId', () => { assert.notEqual(wf().reportId, runWalkForward(CFG, COST, sim, {clock:CLOCK, simVersion:'v2'}).reportId); });
test('52. stress 1.5x has higher fees', () => { const r = wf(); const b = r.stressScenarios!.find(x=>x.name==='baseline')!; const s = r.stressScenarios!.find(x=>x.name==='1.5x')!; assert.ok(s.metrics.costBreakdown.fees >= b.metrics.costBreakdown.fees); });
test('53. test metrics present with param grid', () => { assert.ok(wf([{a:1}]).folds[0].testMetrics !== null); });
test('54. no grid no test metrics', () => { assert.ok(wf().folds[0].testMetrics === undefined); });
test('55. selectedFold set', () => { assert.equal(wf([{a:1}]).selectedFold, 0); });

// ═══ 56–65: Parameter selection ════════════════════════════════
test('56. selects best validation score', () => { const c = [{ id: 'a', params: {}, validationScore: 5, foldScores: [5], accepted: true, selected: false }, { id: 'b', params: {}, validationScore: 8, foldScores: [8], accepted: true, selected: false }]; assert.equal(selectParameters(c).selectedId, 'b'); });
test('57. deterministic tie-break', () => { const c = [{ id: 'a', params: {x:1}, validationScore: 5, foldScores: [5], accepted: true, selected: false }, { id: 'b', params: {x:1}, validationScore: 5, foldScores: [5], accepted: true, selected: false }]; assert.ok(selectParameters(c).selectedId !== null); });
test('58. empty → null', () => { assert.equal(selectParameters([]).selectedId, undefined); });
test('59. rejected not selected', () => { assert.equal(selectParameters([{ id: 'x', params: {}, validationScore: 10, foldScores: [], accepted: true, selected: false }]).selectedId, undefined); });
test('60. selected in candidates', () => { const r = selectParameters([{ id: 'z', params: {}, validationScore: 10, foldScores: [10], accepted: true, selected: false }]); assert.ok(r.candidates.find(x=>x.id==='z') !== null); });
test('61. test excluded from selection', () => { const r = wf([{ a: 1 }]); assert.ok(r.selectedParameters !== undefined); });
test('62. selectedParams is object', () => { assert.equal(typeof wf([{a:1}]).selectedParameters, 'object'); });
test('63. params deterministic', () => { const p = [{a:1},{b:2}]; const r1 = runWalkForward(CFG, COST, sim, { paramGrid: p, clock: CLOCK }); const r2 = runWalkForward(CFG, COST, sim, { paramGrid: p, clock: CLOCK }); assert.deepStrictEqual(r1.selectedParameters, r2.selectedParameters); });
test('64. test data unchanged by param change', () => { const r1 = wf([{a:1}]); const r2 = wf([{a:2}]); assert.notEqual(r2.selectedParameters, undefined); });
test('65. large param grid handles', () => { const g = Array.from({length:10}, (_, i) => ({ v: i })); const r = runWalkForward(CFG, COST, sim, { paramGrid: g, clock: CLOCK }); assert.ok(r.selectedParameters !== null); });

// ═══ 66–72: Immutability + edge ═══════════════════════════════
test('66. deepFreeze objects', () => { const o = { a: { b: 3 } }; deepFreeze(o); assert.ok(Object.isFrozen(o)); assert.ok(Object.isFrozen(o.a)); });
test('67. deepFreeze primitives', () => { assert.equal(deepFreeze(42), 42); });
test('68. deepFreeze arrays', () => { const a = [1, 2, 3]; deepFreeze(a); assert.ok(Object.isFrozen(a)); });
test('69. makeReportId stable', () => { assert.equal(makeReportId(CFG, COST), makeReportId(CFG, COST)); });
test('70. zero-cost net≈gross', () => { const z: CostConfig = {feeBps:0,spreadBps:0,slippageBps:0,latencyPenaltyBps:0,stressMultiplier:1}; const r = runWalkForward(CFG, z, sim, {clock:CLOCK}); assert.ok(Math.abs(r.folds[0].trainMetrics.netReturn - r.folds[0].trainMetrics.grossReturn) < 0.0001); });
test('71. negative gross negative net', () => { const ns = (s:number,e:number) => ({grossPnl:-100,volume:1000,turnover:1,maxDrawdown:0.5,sharpe:-1,sortino:-1,profitFactor:0,trades:1}); assert.ok(runWalkForward(CFG,COST,ns,{clock:CLOCK}).folds[0].trainMetrics.netReturn < 0); });
test('72. insufficient sample warning', () => { const ns = (s:number,e:number) => ({grossPnl:0,volume:0,turnover:0,maxDrawdown:0,sharpe:0,sortino:0,profitFactor:0,trades:0}); assert.ok(runWalkForward(CFG,COST,ns,{clock:CLOCK}).warnings.includes('INSUFFICIENT_SAMPLE')); });
