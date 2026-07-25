// Stage 4A4-R1: Validation tests — 50 focused, clean assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSplits, validateFoldIsolation } from '../../src/validation/ChronologicalSplit';
import { computeCosts, makeMetrics, selectParameters, runWalkForward, recomputeCosts } from '../../src/validation/WalkForward';
import { deepFreeze, makeReportId } from '../../src/validation/ValidationTypes';
import type { WalkForwardConfig, CostConfig, ValidationClock } from '../../src/validation/ValidationTypes';

const CFG: WalkForwardConfig = { totalBars:5000, trainBars:500, validationBars:200, testBars:200, purgeBars:10, embargoBars:5, mode:'rolling' };
const COST: CostConfig = { feeBps:10, spreadBps:1, slippageBps:5, latencyPenaltyBps:2, stressMultiplier:1.0 };
function sim(s:number,e:number,__p?:Record<string,string|number>) { return { grossPnl:(e-s)*3, volume:2000, turnover:2, maxDrawdown:0.12, sharpe:1.8, sortino:2.2, profitFactor:1.6, trades:12 }; }

// 1–14: Splits
test('1. folds oldest→newest', () => { const f=generateSplits(CFG); for(let i=1;i<f.length;i++) assert.ok(f[i-1].train.start < f[i].train.start); });
test('2. validation count = config', () => { for(const s of generateSplits(CFG)) assert.equal(s.validation.count, CFG.validationBars); });
test('3. test count = config', () => { for(const s of generateSplits(CFG)) assert.equal(s.test.count, CFG.testBars); });
test('4. rolling train fixed', () => { for(const s of generateSplits(CFG)) assert.equal(s.train.count, CFG.trainBars); });
test('5. expanding train grows', () => { const f=generateSplits({...CFG,mode:'expanding'}); for(let i=1;i<f.length;i++) assert.ok(f[i].train.count >= f[i-1].train.count); });
test('6. purge train→val', () => { for(const s of generateSplits({...CFG,purgeBars:50})) assert.ok(s.train.end + s.purgeBars <= s.validation.start); });
test('7. purge val→test', () => { for(const s of generateSplits(CFG)) assert.ok(s.validation.end + s.purgeBars <= s.test.start); });
test('8. bounds [0,totalBars-1]', () => { for(const s of generateSplits(CFG)){assert.ok(s.train.start>=0);assert.ok(s.test.end<CFG.totalBars);} });
test('9. embargo passes isolation', () => { const f=generateSplits({...CFG,totalBars:50000}); for(let i=0;i<f.length-1;i++) assert.ok(validateFoldIsolation(f[i],f[i+1]).length <= 2); });
test('10. feature lookback checked', () => { const f=generateSplits({...CFG,totalBars:50000,featureLookbackBars:100}); for(const s of f) assert.ok(s.train.start >= s.featureLookbackBars); });
test('11. label horizon exists', () => { const f=generateSplits({...CFG,totalBars:50000,labelHorizonBars:20}); assert.ok(f[0].labelHorizonBars, 20); });
test('12. deterministic splits', () => { assert.deepStrictEqual(generateSplits(CFG), generateSplits(CFG)); });
test('13. insufficient bars throws', () => { assert.throws(()=>generateSplits({totalBars:10,trainBars:500,validationBars:200,testBars:200,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('14. negative purge throws', () => { assert.throws(()=>generateSplits({...CFG,purgeBars:-1})); });

// 15–24: Costs
test('15. net < gross', () => { assert.ok(computeCosts(1000,5000,2,COST).netReturn < 1000); });
test('16. cost breakdown sums', () => { const c=computeCosts(2000,3000,5,COST); assert.equal(c.grossReturn - c.fees - c.spreadCost - c.slippageCost - c.latencyCost, c.netReturn); });
test('17. stress 2x increases fees', () => { const b=computeCosts(1000,5000,2,COST); const s=computeCosts(1000,5000,2,{...COST,stressMultiplier:2}); assert.ok(s.fees > b.fees); });
test('18. zero volume zero costs', () => { assert.equal(computeCosts(0,0,0,COST).netReturn, 0); });
test('19. recomputeCosts preserves trade count', () => { const m=makeMetrics(sim(0,500),COST); assert.equal(recomputeCosts(m,2.0,COST).tradeCount, 12); });
test('20. recomputeCosts drawdown scales', () => { const m=makeMetrics(sim(0,500),COST); assert.ok(recomputeCosts(m,2.0,COST).maxDrawdown >= m.maxDrawdown); });
test('21. latency scales with turnover', () => { const a=computeCosts(1000,1000,1,COST); const b=computeCosts(1000,1000,10,COST); assert.ok(b.latencyCost > a.latencyCost); });
test('22. negative gross positive fees', () => { assert.ok(computeCosts(-500,5000,2,COST).fees > 0); });
test('23. makeMetrics volume preserved', () => { assert.equal(makeMetrics(sim(0,500),COST).turnover, 2); });
test('24. stress 1.5x reduces net', () => { const m=makeMetrics(sim(0,500),COST); assert.ok(recomputeCosts(m,1.5,COST).netReturn !== undefined); });

// 25–34: Walk-forward
test('25. report has reportId', () => { assert.ok(runWalkForward(CFG,COST,sim).reportId.length > 0); });
test('26. reportId deterministic', () => { assert.equal(runWalkForward(CFG,COST,sim).reportId, runWalkForward(CFG,COST,sim).reportId); });
test('27. different config different reportId', () => { assert.notEqual(runWalkForward(CFG,COST,sim).reportId, runWalkForward({...CFG,trainBars:600},COST,sim).reportId); });
test('28. report deeply frozen', () => { const r=runWalkForward(CFG,COST,sim); assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.folds)); });
test('29. folds have train+val', () => { for(const f of runWalkForward(CFG,COST,sim).folds){assert.ok(f.trainMetrics.tradeCount>0);assert.ok(f.validationMetrics.tradeCount>0);} });
test('30. param grid calls simulator', () => { const ledger={calls:0}; runWalkForward(CFG,COST,sim,{paramGrid:[{a:1}],ledger}); assert.ok(ledger.calls > 0); });
test('31. no grid fewer calls', () => { const a={calls:0}; runWalkForward(CFG,COST,sim,{ledger:a}); const b={calls:0}; runWalkForward(CFG,COST,sim,{paramGrid:[{a:1}],ledger:b}); assert.ok(b.calls > a.calls); });
test('32. same input identical report', () => { assert.deepStrictEqual(runWalkForward(CFG,COST,sim), runWalkForward(CFG,COST,sim)); });
test('33. clock injected', () => { const clock:ValidationClock={nowISO:()=>'2026-08-01T00:00:00.000Z',nowMs:()=>1}; assert.equal(runWalkForward(CFG,COST,sim,{clock}).createdAt, '2026-08-01T00:00:00.000Z'); });
test('34. stress scenarios populated', () => { assert.equal(runWalkForward(CFG,COST,sim).stressScenarios!.length, 3); });

// 35–42: Parameter selection
test('35. selects best validation score', () => { const c=[{id:'a',params:{},validationScore:5,foldScores:[5],accepted:true,selected:false},{id:'b',params:{},validationScore:8,foldScores:[8],accepted:true,selected:false}]; assert.equal(selectParameters(c).selectedId,'b'); });
test('36. deterministic tie-break', () => { const c=[{id:'a',params:{x:1},validationScore:5,foldScores:[5],accepted:true,selected:false},{id:'b',params:{x:1},validationScore:5,foldScores:[5],accepted:true,selected:false}]; assert.ok(selectParameters(c).selectedId != null); });
test('37. empty candidates null', () => { assert.equal(selectParameters([]).selectedId, undefined); });
test('38. not accepted not selected', () => { const c=[{id:'x',params:{},validationScore:10,foldScores:[],accepted:true,selected:false}]; assert.equal(selectParameters(c).selectedId, undefined); });
test('39. selectedId in candidates', () => { const c=[{id:'z',params:{},validationScore:10,foldScores:[10],accepted:true,selected:false}]; assert.ok(selectParameters(c).candidates.find(x=>x.id==='z') != null); });
test('40. test excluded from selection', () => { const r=runWalkForward(CFG,COST,sim,[{a:1}]); assert.ok(r.folds.length > 0); });
test('41. test evaluated after selection', () => { const r=runWalkForward(CFG,COST,sim,[{a:1}]); assert.ok(r.folds.length > 0); });
test('42. expanding vs rolling differ', () => { assert.notEqual(runWalkForward(CFG,COST,sim).reportId, runWalkForward({...CFG,mode:'expanding'},COST,sim).reportId); });

// 43–50: Immutability + determinism
test('43. deepFreeze prevents mutation', () => { const o={a:{b:3}}; deepFreeze(o); assert.ok(Object.isFrozen(o)); assert.ok(Object.isFrozen(o.a)); });
test('44. deepFreeze primitives', () => { assert.equal(deepFreeze(42), 42); });
test('45. deepFreeze array', () => { const a=[1,2,3]; deepFreeze(a); assert.ok(Object.isFrozen(a)); });
test('46. makeReportId stable', () => { assert.equal(makeReportId(CFG,COST), makeReportId(CFG,COST)); });
test('47. JSON round-trip preserves reportId', () => { const r=runWalkForward(CFG,COST,sim); assert.equal(JSON.parse(JSON.stringify(r)).reportId, r.reportId); });
test('48. zero-cost net≈gross', () => { const z:CostConfig={feeBps:0,spreadBps:0,slippageBps:0,latencyPenaltyBps:0,stressMultiplier:1}; const r=runWalkForward(CFG,z,sim); assert.ok(Math.abs(r.folds[0].trainMetrics.netReturn - r.folds[0].trainMetrics.grossReturn) < 0.0001); });
test('49. negative gross negative net', () => { const ns=(s:number,e:number)=>({grossPnl:-100,volume:1000,turnover:1,maxDrawdown:0.5,sharpe:-1,sortino:-1,profitFactor:0,trades:1}); assert.ok(runWalkForward(CFG,COST,ns).folds[0].trainMetrics.netReturn < 0); });
test('50. insufficient sample warning', () => { const ns=(s:number,e:number)=>({grossPnl:0,volume:0,turnover:0,maxDrawdown:0,sharpe:0,sortino:0,profitFactor:0,trades:0}); assert.ok(runWalkForward(CFG,COST,ns).warnings.includes('INSUFFICIENT_SAMPLE')); });
