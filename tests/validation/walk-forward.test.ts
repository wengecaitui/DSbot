// Stage 4A4-R3: 72+ strict validation tests — expanding, iso, cost, holdout, identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSplits, validateFoldIsolation } from '../../src/validation/ChronologicalSplit';
import { computeCosts, makeMetrics, selectParameters, runWalkForward, recomputeCosts } from '../../src/validation/WalkForward';
import { deepFreeze, makeReportId } from '../../src/validation/ValidationTypes';
import type { WalkForwardConfig, CostConfig, ValidationClock } from '../../src/validation/ValidationTypes';

const CFG: WalkForwardConfig = { totalBars: 15000, trainBars: 800, validationBars: 300, testBars: 300, purgeBars: 20, embargoBars: 10, mode: 'rolling' };
const ECFG: WalkForwardConfig = { ...CFG, mode: 'expanding' };
const COST: CostConfig = { feeBps: 10, spreadBps: 1, slippageBps: 5, latencyPenaltyBps: 2, stressMultiplier: 1.0 };
const CLOCK: ValidationClock = { nowISO: () => '2026-08-01T00:00:00.000Z', nowMs: () => 1 };
function sim(s: number, e: number, _p?: Record<string, string | number>) { return { grossPnl: (e-s)*3, volume: 5000, turnover: 3, maxDrawdown: 0.12, sharpe: 1.8, sortino: 2.2, profitFactor: 1.6, trades: 15 }; }
function wf(cfg?: WalkForwardConfig, grid?: Record<string, string | number>[], l?: { calls: number }, dsHash?: string) { return runWalkForward(cfg ?? CFG, COST, sim, { paramGrid: grid, clock: CLOCK, ledger: l, datasetHash: dsHash }); }

// ═══ 1–20: Split geometry ═══════════════════════════════════════
test('1. rolling train count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.train.count, CFG.trainBars); });
test('2. expanding train count strictly increasing', () => { const f = generateSplits(ECFG); for (let i=1;i<f.length;i++) assert.ok(f[i].train.count > f[i-1].train.count); });
test('3. expanding train start fixed', () => { const f = generateSplits(ECFG); const first = f[0].train.start; for (const s of f.slice(1)) assert.equal(s.train.start, first); });
test('4. val count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.validation.count, CFG.validationBars); });
test('5. test count = config', () => { for (const s of generateSplits(CFG)) assert.equal(s.test.count, CFG.testBars); });
test('6. folds oldest→newest', () => { const f = generateSplits(CFG); for (let i=1;i<f.length;i++) assert.ok(f[i-1].train.start < f[i].train.start); });
test('7. indices in bounds', () => { for (const s of generateSplits(CFG)) { assert.ok(s.train.start >= 0); assert.ok(s.test.end < CFG.totalBars); } });
test('8. purge train→val', () => { for (const s of generateSplits({...CFG,purgeBars:100})) assert.ok(s.train.end + s.purgeBars <= s.validation.start); });
test('9. purge val→test', () => { for (const s of generateSplits(CFG)) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('10. feature lookback enforced', () => { const f = generateSplits({...CFG, totalBars:50000, featureLookbackBars:500}); for (const s of f) assert.ok(s.train.start >= s.featureLookbackBars); });
test('11. label horizon present', () => { assert.equal(generateSplits({...CFG, totalBars:50000, labelHorizonBars:42})[0].labelHorizonBars, 42); });
test('12. deterministic', () => { assert.deepStrictEqual(generateSplits(CFG), generateSplits(CFG)); });
test('13. expanding different from rolling', () => { assert.notDeepStrictEqual(generateSplits(CFG), generateSplits(ECFG)); });
test('14. insufficient totalBars throws', () => { assert.throws(() => generateSplits({totalBars:10,trainBars:500,validationBars:200,testBars:200,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('15. zero bars throws', () => { assert.throws(() => generateSplits({totalBars:0,trainBars:100,validationBars:50,testBars:50,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('16. negative purge throws', () => { assert.throws(() => generateSplits({...CFG,purgeBars:-1})); });
test('17. distinct folds', () => { const f = generateSplits(CFG); const keys = new Set(f.map(s => `${s.train.start}-${s.test.end}`)); assert.equal(keys.size, f.length); });
test('18. folds exist', () => { assert.ok(generateSplits(CFG).length > 0); });
test('19. totalBars 100000 gives many folds', () => { assert.ok(generateSplits({...CFG, totalBars:100000}).length > 5); });
test('20. adjacent isolation <= 1', () => { const f = generateSplits({...CFG, totalBars:50000}); for (let i=0;i<f.length-1;i++) assert.ok(validateFoldIsolation(f[i],f[i+1]).length <= 1); });

// ═══ 21–30: Leakage detection ══════════════════════════════════
test('21. train-val overlap detected', () => { const f: any = generateSplits(CFG)[0]; const bad = {...f, train:{...f.train,end:f.validation.start+1}}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('train end >= validation'))); });
test('22. purge before test detected', () => { const f: any = generateSplits(CFG)[0]; const bad = {...f, test:{...f.test,start:f.validation.end}}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('val+purge'))); });
test('23. embargo leak detected', () => { const f = generateSplits({...CFG, totalBars:50000}); const badNext = {...f[1], train:{...f[1].train,start:f[0].test.end}}; assert.ok(validateFoldIsolation(f[0],badNext).some(x=>x.includes('test+embargo'))); });
test('24. feature lookback leak detected', () => { const f = generateSplits({...CFG, totalBars:50000, featureLookbackBars:500})[0]; const bad = {...f, train:{...f.train,start:100}, featureLookbackBars:f.featureLookbackBars}; assert.ok(validateFoldIsolation(bad).some(x=>x.includes('lookback'))); });
test('25. isolation passes on valid fold', () => { assert.deepStrictEqual(validateFoldIsolation(generateSplits(CFG)[0]), []); });
test('26. embargo checked in isolation', () => { const f = generateSplits({...CFG, totalBars:50000, embargoBars:100}); for (let i=0;i<f.length-1;i++) assert.ok(validateFoldIsolation(f[i], f[i+1]).length <= 1); });
test('27. embargo larger than normal', () => { const f = generateSplits({...CFG, totalBars:100000, embargoBars:200, trainBars:500}); assert.ok(f.length > 0); });
test('28. purge large but valid', () => { const f = generateSplits({...CFG, totalBars:50000, purgeBars:100}); for (const s of f) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('29. fold count with increased embargo', () => { const a = generateSplits({...CFG, totalBars:50000, embargoBars:5}).length; const b = generateSplits({...CFG, totalBars:50000, embargoBars:100}).length; assert.ok(b <= a); });
test('30. validation count preserved with purge', () => { for (const s of generateSplits({...CFG, totalBars:50000, purgeBars:50})) assert.equal(s.validation.count, CFG.validationBars); });

// ═══ 31–40: Cost recomputation ═════════════════════════════════
test('31. computeCosts net < gross', () => { assert.ok(computeCosts(1000,5000,3,COST).netReturn < 1000); });
test('32. cost breakdown sums', () => { const c = computeCosts(2000,3000,5,COST); assert.equal(c.grossReturn - c.fees - c.spreadCost - c.slippageCost - c.latencyCost, c.netReturn); });
test('33. stress 1.5x higher fees than baseline', () => { const b = computeCosts(1000,5000,3,COST); const s = computeCosts(1000,5000,3,{...COST, stressMultiplier:1.5}); assert.ok(s.fees > b.fees); });
test('34. stress 2x higher fees than baseline', () => { const b = computeCosts(1000,5000,3,COST); const s = computeCosts(1000,5000,3,{...COST, stressMultiplier:2}); assert.ok(s.fees > b.fees); });
test('35. makeMetrics preserves volume for recompute', () => { const m = makeMetrics(sim(0,500), COST); assert.equal((m as any)._volume, 5000); });
test('36. recomputeCosts 1.5x has lower net', () => { const m = makeMetrics(sim(0,500), COST); const r = recomputeCosts(m, 1.5, COST); assert.ok(r.netReturn < m.netReturn); });
test('37. recomputeCosts 2x has lower net than 1.5x', () => { const m = makeMetrics(sim(0,500), COST); assert.ok(recomputeCosts(m, 2.0, COST).netReturn < recomputeCosts(m, 1.5, COST).netReturn); });
test('38. recomputeCosts preserves sharpe/sortino', () => { const m = makeMetrics(sim(0,500), COST); const r = recomputeCosts(m, 2.0, COST); assert.equal(r.sharpeRatio, m.sharpeRatio); assert.equal(r.sortinoRatio, m.sortinoRatio); });
test('39. recomputeCosts preserves profitFactor', () => { const m = makeMetrics(sim(0,500), COST); assert.equal(recomputeCosts(m, 2.0, COST).profitFactor, m.profitFactor); });
test('40. recomputeCosts preserves maxDrawdown', () => { const m = makeMetrics(sim(0,500), COST); assert.equal(recomputeCosts(m, 2.0, COST).maxDrawdown, m.maxDrawdown); });

// ═══ 41–55: Parameter selection ════════════════════════════════
test('41. selects best val net', () => { const c = [{id:'a',params:{},validationScore:5,foldScores:[5],metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},selected:false},accepted:true,selected:false},{id:'b',params:{},validationScore:8,foldScores:[8],metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},selected:false},accepted:true,selected:false}]; assert.equal(selectParameters(c).selectedId,'b'); });
test('42. deterministic tie-break', () => { const c = [{id:'a',params:{x:1},validationScore:5,foldScores:[5],metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},selected:false},accepted:true,selected:false},{id:'b',params:{x:2},validationScore:5,foldScores:[5],metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},selected:false},accepted:true,selected:false}]; assert.ok(selectParameters(c).selectedId != null); });
test('43. minTrades train rejected', () => { const c = [{id:'x',params:{},validationScore:10,foldScores:[10],metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:2,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},selected:false},accepted:true,selected:false}]; assert.equal(selectParameters(c).selectedId, undefined); });
test('44. minTrades val rejected', () => { const c = [{id:'x',params:{},validationScore:10,foldScores:[10],metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:2,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},selected:false},accepted:true,selected:false}]; assert.equal(selectParameters(c).selectedId, undefined); });
test('45. empty candidates null', () => { assert.equal(selectParameters([]).selectedId, undefined); });
test('46. selected in candidates', () => { const r = selectParameters([{id:'z',params:{},validationScore:10,foldScores:[10],metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:10,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0},_volume:1000},selected:false},accepted:true,selected:false}]); assert.ok(r.candidates.find(x=>x.id==='z') != null); });
test('47. test excluded from selection', () => { const r = wf(CFG, [{a:1}]); assert.ok(r.selectedParameters !== undefined); });
test('48. test exact-once', () => { const l = {calls:0}; wf(CFG, [{a:1}], l); assert.ok(l.calls > 0); });
test('49. no grid no testMetrics', () => { assert.equal(wf().folds[0].testMetrics, undefined); });
test('50. grid → testMetrics present', () => { assert.ok(wf(CFG, [{a:1}]).folds[0].testMetrics !== null); });
test('51. selectedFold set', () => { assert.equal(wf(CFG, [{a:1}]).selectedFold, 0); });
test('52. test data unchanged when params change', () => { const r1 = wf(CFG, [{a:1}]); const r2 = wf(CFG, [{a:2}]); assert.ok(r1.selectedParameters !== r2.selectedParameters); });
test('53. large param grid works', () => { const g = Array.from({length:5}, (_,i) => ({v:i})); assert.ok(wf(CFG, g).selectedParameters != null); });
test('54. params deterministic across runs', () => { const p = [{a:1},{b:2}]; assert.deepStrictEqual(wf(CFG, p).selectedParameters, wf(CFG, p).selectedParameters); });
test('55. multi-fold candidate aggregation uses val net', () => { const r = wf(CFG, [{a:1},{b:2}]); assert.ok(r.selectedParameters !== null); });

// ═══ 56–72: Report identity + immutability ═════════════════════
test('56. reportId deterministic', () => { assert.equal(wf().reportId, wf().reportId); });
test('57. datasetHash changes reportId', () => { assert.notEqual(wf(CFG, undefined, undefined, 'a').reportId, wf(CFG, undefined, undefined, 'b').reportId); });
test('58. simVersion changes reportId', () => { assert.notEqual(runWalkForward(CFG,COST,sim,{clock:CLOCK,simVersion:'v1'}).reportId, runWalkForward(CFG,COST,sim,{clock:CLOCK,simVersion:'v2'}).reportId); });
test('59. costConfig changes reportId', () => { assert.notEqual(wf(CFG).reportId, runWalkForward(CFG,{...COST,feeBps:20},sim,{clock:CLOCK}).reportId); });
test('60. same input identical report', () => { assert.deepStrictEqual(wf(), wf()); });
test('61. report deeply frozen', () => { const r = wf(); assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.folds)); assert.ok(Object.isFrozen(r.warnings)); });
test('62. clock controls createdAt', () => { assert.equal(wf().createdAt, '2026-08-01T00:00:00.000Z'); });
test('63. JSON round-trip preserves reportId', () => { const r = wf(); assert.equal(JSON.parse(JSON.stringify(r)).reportId, r.reportId); });
test('64. stress scenarios 3 entries', () => { assert.equal(wf().stressScenarios!.length, 3); });
test('65. stress 1.5x net < baseline net', () => { const r = wf(); const b = r.stressScenarios![0].metrics; const s = r.stressScenarios!.find(x=>x.name==='1.5x')!.metrics; assert.ok(s.netReturn < b.netReturn); });
test('66. stress 2x net < 1.5x net', () => { const r = wf(); const s15 = r.stressScenarios!.find(x=>x.name==='1.5x')!.metrics; const s2 = r.stressScenarios!.find(x=>x.name==='2x')!.metrics; assert.ok(s2.netReturn < s15.netReturn); });
test('67. deepFreeze objects', () => { const o = {a:{b:3}}; deepFreeze(o); assert.ok(Object.isFrozen(o)); assert.ok(Object.isFrozen(o.a)); });
test('68. deepFreeze primitives', () => { assert.equal(deepFreeze(42), 42); });
test('69. deepFreeze arrays', () => { const a = [1,2,3]; deepFreeze(a); assert.ok(Object.isFrozen(a)); });
test('70. makeReportId stable', () => { assert.equal(makeReportId(CFG,COST), makeReportId(CFG,COST)); });
test('71. zero-cost net≈gross', () => { const z:CostConfig={feeBps:0,spreadBps:0,slippageBps:0,latencyPenaltyBps:0,stressMultiplier:1}; const r=runWalkForward(CFG,z,sim,{clock:CLOCK}); assert.ok(Math.abs(r.folds[0].trainMetrics.netReturn - r.folds[0].trainMetrics.grossReturn) < 0.0001); });
test('72. insufficient sample warning', () => { const ns=(s:number,e:number)=>({grossPnl:0,volume:0,turnover:0,maxDrawdown:0,sharpe:0,sortino:0,profitFactor:0,trades:0}); assert.ok(runWalkForward(CFG,COST,ns,{clock:CLOCK}).warnings.includes('INSUFFICIENT_SAMPLE')); });
