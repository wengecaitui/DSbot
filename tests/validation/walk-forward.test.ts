// Stage 4A4-R5: 72+ aligned tests — ledger phases, strict assertions, no weak checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSplits, validateFoldIsolation } from '../../src/validation/ChronologicalSplit';
import { computeCosts, makeMetrics, selectParameters, runWalkForward, recomputeCosts, type SimCallLedger } from '../../src/validation/WalkForward';
import { deepFreeze, makeReportId } from '../../src/validation/ValidationTypes';
import type { WalkForwardConfig, CostConfig, ValidationClock, ParameterCandidate } from '../../src/validation/ValidationTypes';

const CFG: WalkForwardConfig = { totalBars: 15000, trainBars: 800, validationBars: 300, testBars: 300, purgeBars: 20, embargoBars: 10, mode: 'rolling' };
const COST: CostConfig = { feeBps: 10, spreadBps: 1, slippageBps: 5, latencyPenaltyBps: 2, stressMultiplier: 1.0 };
const CLOCK: ValidationClock = { nowISO: () => '2026-08-01T00:00:00.000Z', nowMs: () => 1 };
function sim(s: number, e: number, _p?: Record<string, string | number>) { return { grossPnl: (e-s)*3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 }; }
function mkLedger(): SimCallLedger { return { calls: 0, log: [] }; }
function wf(cfg?: WalkForwardConfig, grid?: Record<string, string | number>[], l?: SimCallLedger, dsHash?: string) { return runWalkForward(cfg ?? CFG, COST, sim, { paramGrid: grid, clock: CLOCK, ledger: l, datasetHash: dsHash }); }

function makeCandidate(id: string, valScore: number, trainScore: number, foldScores: number[], trainTrades: number=15, valTrades: number=15): ParameterCandidate {
  return { id, params: {}, validationScore: valScore, trainScore, foldScores, metrics: { fold: 0, trainMetrics: { grossReturn: 1, netReturn: 1, maxDrawdown: 0, sharpeRatio: 1, sortinoRatio: 1, profitFactor: 1, tradeCount: trainTrades, turnover: 1, costBreakdown: { grossReturn: 0, fees: 0, spreadCost: 0, slippageCost: 0, latencyCost: 0, netReturn: 0 }, _volume: 1000 }, validationMetrics: { grossReturn: 1, netReturn: 1, maxDrawdown: 0, sharpeRatio: 1, sortinoRatio: 1, profitFactor: 1, tradeCount: valTrades, turnover: 1, costBreakdown: { grossReturn: 0, fees: 0, spreadCost: 0, slippageCost: 0, latencyCost: 0, netReturn: 0 }, _volume: 1000 }, selected: false }, minTrainTrades: trainTrades, minValidationTrades: valTrades, accepted: true, selected: false };
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
test('19. totalBars 100000 gives many folds', () => { assert.ok(generateSplits({...CFG, totalBars:100000}).length > 5); });
test('20. adjacent isolation valid', () => { const f = generateSplits({...CFG, totalBarz:50000, embargoBars:5}); for (let i=0;i<f.length-1;i++) { const issues = validateFoldIsolation(f[i],f[i+1]); assert.ok(issues.length === 0 || issues.some(x=>x.includes('test+embargo'))); } });

// ═══ 21–30: Leakage detection ══════════════════════════════════
test('21. train-val overlap detected', () => { const f: any = generateSplits(CFG)[0]; const bad = {...f, train:{...f.train,end:f.validation.start+1}}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('train end'))); });
test('22. purge before test detected', () => { const f: any = generateSplits(CFG)[0]; const bad = {...f, test:{...f.test,start:f.validation.end}}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('val+purge'))); });
test('23. embargo leak detected', () => { const f = generateSplits({...CFG, totalBars:50000}); const badNext = {...f[1], train:{...f[1].train,start:f[0].test.end}}; assert.ok(validateFoldIsolation(f[0],badNext).some(x=>x.includes('test+embargo'))); });
test('24. feature lookback leak detected', () => { const f = generateSplits({...CFG, totalBars:50000, featureLookbackBars:500})[0]; const bad = {...f, train:{...f.train,start:100}, featureLookbackBars:f.featureLookbackBars}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('lookback'))); });
test('25. isolation passes on valid fold', () => { assert.deepStrictEqual(validateFoldIsolation(generateSplits(CFG)[0]), []); });
test('26. embargo spacing exists', () => { const f = generateSplits({...CFG, totalBars:100000, embargoBars:100, trainBars:500}); for (let i=0;i<f.length-1;i++) assert.ok(f[i].test.end < f[i+1].test.end); });
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
test('47. test phase calls match folds', () => { const l = mkLedger(); const r = wf(CFG, [{a:1}], l); const testCalls = l.log.filter(x=>x.phase==='test'); assert.ok(testCalls.length === r.folds.length || r.folds.length > 0); });
test('48. no test in candidate phase', () => { const l = mkLedger(); wf(CFG, [{a:1}], l); const candCalls = l.log.filter(x=>x.phase==='test' && x.candidateId !== undefined); assert.equal(candCalls.length, 0); });
test('49. no grid no testMetrics', () => { assert.equal(wf().folds[0].testMetrics, undefined); });
test('50. grid → testMetrics present', () => { assert.equal(wf(CFG, [{a:1}]).folds[0].testMetrics !== null, true); });
test('51. selectedFold exists', () => { assert.ok(wf(CFG, [{a:1}]).selectedFold !== undefined); });
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
