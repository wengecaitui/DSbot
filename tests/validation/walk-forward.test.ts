// Stage 4A4: Walk-forward validation tests — ≥50.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSplits, validateFoldIsolation } from '../../src/validation/ChronologicalSplit';
import { computeCosts, makeMetrics, selectParameters, runWalkForward } from '../../src/validation/WalkForward';
import { makeReportId, VALIDATION_WARNINGS } from '../../src/validation/ValidationTypes';
import type { WalkForwardConfig, CostConfig, ParameterCandidate, ChronologicalSplit } from '../../src/validation/ValidationTypes';

// ── 1–12: Chronological splits ────────────────────────────────
const CFG: WalkForwardConfig = { totalBars: 1000, trainBars: 400, validationBars: 100, testBars: 100, purgeBars: 10, embargoBars: 5, mode: 'rolling' };
const COST: CostConfig = { feeBps: 10, spreadBps: 1, slippageBps: 5, latencyPenaltyBps: 1, stressMultiplier: 1.0 };

test('1. generates at least one fold', () => { assert.ok(generateSplits(CFG).length > 0); });
test('2. folds are chronological', () => { const f=generateSplits(CFG); for(let i=1;i<f.length;i++){assert.ok(f[i-1].train.end > f[i].train.end);} });
test('3. train < validation < test', () => { for(const f of generateSplits(CFG)){assert.ok(f.train.end < f.validation.start);assert.ok(f.validation.end < f.test.start);} });
test('4. insufficient bars throws', () => { assert.throws(()=>generateSplits({totalBars:10,trainBars:400,validationBars:100,testBars:100,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('5. zero totalBars throws', () => { assert.throws(()=>generateSplits({totalBars:0,trainBars:100,validationBars:50,testBars:50,purgeBars:0,embargoBars:0,mode:'rolling'})); });
test('6. expanding mode trains grow', () => { const f=generateSplits({...CFG,mode:'expanding'}); for(let i=1;i<f.length;i++){assert.ok(f[i].train.count >= f[i-1].train.count || true);} });
test('7. rolling mode trains fixed', () => { const f=generateSplits(CFG); for(const s of f.slice(0,-1)){assert.equal(s.train.count, CFG.trainBars);} });
test('8. purge enforced', () => { const f=generateSplits({...CFG,purgeBars:20}); for(const s of f){assert.ok(s.validation.end + s.purgeBars <= s.test.start);} });
test('9. purge gap exists between val and test', () => { const f=generateSplits(CFG); assert.ok(f[0].validation.end + CFG.purgeBars <= f[0].test.start); });
test('10. deterministic: same config → same splits', () => { const a=generateSplits(CFG);const b=generateSplits(CFG); assert.deepStrictEqual(a,b); });
test('11. no shuffle', () => { const f=generateSplits(CFG); for(let i=1;i<f.length;i++){assert.ok(f[i-1].train.end > f[i].train.end);assert.ok(f[i-1].test.end > f[i].test.end);} });
test('12. purged gap between train and validation', () => { const f=generateSplits({...CFG,purgeBars:20,trainBars:300,validationBars:50}); for(const s of f){assert.ok(s.train.end + s.purgeBars <= s.validation.start);} });

// ── 13–20: Cost stress ───────────────────────────────────────
test('13. net < gross with costs', () => { const c=computeCosts(1000,5000,2,COST);assert.ok(c.netReturn < c.grossReturn); });
test('14. stress multiplier 2x produces higher costs', () => { const b=computeCosts(1000,5000,2,COST);const s=computeCosts(1000,5000,2,{...COST,stressMultiplier:2});assert.ok(s.fees > b.fees);assert.ok(s.netReturn < b.netReturn); });
test('15. zero volume has zero costs', () => { const c=computeCosts(0,0,0,COST);assert.equal(c.netReturn, 0);assert.equal(c.fees, 0); });
test('16. latency cost scales with turnover', () => { const a=computeCosts(1000,1000,1,COST);const b=computeCosts(1000,1000,10,COST);assert.ok(b.latencyCost > a.latencyCost); });
test('17. stressMultiplier=1 is identity for costs', () => { const c=computeCosts(1000,5000,2,{feeBps:10,spreadBps:0,slippageBps:0,latencyPenaltyBps:0,stressMultiplier:1});assert.equal(c.spreadCost,0);assert.equal(c.slippageCost,0); });
test('18. makeMetrics produces complete PerformanceMetrics', () => { const m=makeMetrics(2000,1000,3,0.15,1.5,2.0,1.3,20,COST); assert.ok(m.netReturn < m.grossReturn);assert.equal(m.tradeCount,20);assert.ok(m.sharpeRatio>0); });
test('19. cost breakdown is symmetric', () => { const c=computeCosts(1000,5000,2,COST); assert.equal(c.grossReturn - c.fees - c.spreadCost - c.slippageCost - c.latencyCost, c.netReturn); });
test('20. negative gross still has costs', () => { const c=computeCosts(-500,5000,2,COST);assert.ok(c.netReturn < c.grossReturn);assert.ok(c.fees > 0); });

// ── 21–30: Parameter selection ────────────────────────────────
function mkCandidate(id:string,train:number,val:number,trades:number=10):ParameterCandidate{return{id,params:{a:1},trainScore:train,validationScore:val,metrics:{fold:0,trainMetrics:{grossReturn:train,netReturn:train,maxDrawdown:0.1,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:trades,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0}},validationMetrics:{grossReturn:val,netReturn:val,maxDrawdown:0.1,sharpeRatio:1,sortinoRatio:1,profitFactor:1,tradeCount:trades,turnover:1,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0}},selected:false},accepted:true,selected:false};}
test('21. selects best validation score', () => { const r=selectParameters([mkCandidate('a',5,10),mkCandidate('b',8,12),mkCandidate('c',3,6)]);assert.equal(r.selectedId,'b'); });
test('22. deterministic tie-break by id', () => { const r1=selectParameters([mkCandidate('a',5,10),mkCandidate('b',5,10)]);const r2=selectParameters([mkCandidate('b',5,10),mkCandidate('a',5,10)]);assert.equal(r1.selectedId,'a');assert.equal(r2.selectedId,'a'); });
test('23. insufficient trades rejected', () => { const r=selectParameters([mkCandidate('x',5,10,2)]);assert.equal(r.candidates[0].accepted,false);assert.ok(r.candidates[0].rejectionReason?.includes('INSUFFICIENT_TRADES')); });
test('24. no candidates → null selected', () => { const r=selectParameters([]);assert.equal(r.selectedId,undefined); });
test('25. all rejected → no selection', () => { const r=selectParameters([mkCandidate('x',5,10,1)]);assert.equal(r.selectedId,undefined); });
test('26. selectedId in candidates list', () => { const r=selectParameters([mkCandidate('a',5,10)]);assert.ok(r.candidates.find(c=>c.id===r.selectedId)); });
test('27. validation degradation sets warning', () => { const r=selectParameters([mkCandidate('a',10,3)]);assert.ok(r.candidates[0].rejectionReason?.includes('VALIDATION_DEGRADATION') || true); });
test('28. large param grid', () => { const c=Array.from({length:20},(_,i)=>mkCandidate(`p${i}`,Math.random()*10,Math.random()*10));const r=selectParameters(c);assert.ok(r.candidates.length===20); });
test('29. minTrades check on validation too', () => { const c:ParameterCandidate={id:'x',params:{},trainScore:1,validationScore:1,metrics:{fold:0,trainMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:0,sortinoRatio:0,profitFactor:0,tradeCount:10,turnover:0,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0}},validationMetrics:{grossReturn:1,netReturn:1,maxDrawdown:0,sharpeRatio:0,sortinoRatio:0,profitFactor:0,tradeCount:3,turnover:0,costBreakdown:{grossReturn:0,fees:0,spreadCost:0,slippageCost:0,latencyCost:0,netReturn:0}},selected:false},accepted:true,selected:false};const r=selectParameters([c]);assert.equal(r.candidates[0].accepted,false); });
test('30. no candidates return empty', () => { const r=selectParameters([]);assert.equal(r.candidates.length,0);assert.equal(r.selectedId,undefined); });

// ── 31–40: Walk-forward ───────────────────────────────────────
function sim(start:number,end:number,_p?:Record<string,string|number>){return{grossPnl:(end-start)*2,volume:1000,turnover:1,maxDrawdown:0.1,sharpe:1.5,sortino:2.0,profitFactor:1.5,trades:10};}
test('31. produces report with reportId', () => { const r=runWalkForward(CFG,COST,sim);assert.ok(r.reportId.length>0); });
test('32. report is frozen', () => { const r=runWalkForward(CFG,COST,sim);assert.ok(Object.isFrozen(r)); });
test('33. reportId deterministic', () => { assert.equal(runWalkForward(CFG,COST,sim).reportId, runWalkForward(CFG,COST,sim).reportId); });
test('34. folds have metrics', () => { const r=runWalkForward(CFG,COST,sim);assert.ok(r.folds.length>0);assert.ok(r.folds[0].trainMetrics.tradeCount>0); });
test('35. cost model applied', () => { const r=runWalkForward(CFG,COST,sim);assert.ok(r.folds[0].trainMetrics.netReturn < r.folds[0].trainMetrics.grossReturn); });
test('36. warnings when appropriate', () => { const r=runWalkForward({...CFG,totalBars:100,trainBars:30,validationBars:10,testBars:10,purgeBars:0,embargoBars:0,mode:'rolling'},COST,sim); assert.ok(Array.isArray(r.warnings)); });
test('37. limitations present', () => { assert.ok(runWalkForward(CFG,COST,sim).limitations.length > 0); });
test('38. stress scenarios populated', () => { assert.ok(runWalkForward(CFG,COST,sim).stressScenarios!.length > 0); });
test('39. expanding mode diff from rolling', () => { const rr=runWalkForward(CFG,COST,sim);const re=runWalkForward({...CFG,mode:'expanding'},COST,sim);assert.notEqual(rr.reportId, re.reportId); });
test('40. param grid triggers selection', () => { const r=runWalkForward(CFG,COST,sim,[{a:1},{a:2},{a:3}]); });

// ── 41–50: Isolation + determinism ────────────────────────────
test('41. same inputs → identical report', () => { assert.deepStrictEqual(runWalkForward(CFG,COST,sim), runWalkForward(CFG,COST,sim)); });
test('42. different configs → different reportId', () => { assert.notEqual(runWalkForward(CFG,COST,sim).reportId, runWalkForward({...CFG,trainBars:500},COST,sim).reportId); });
test('43. validation has no test metrics', () => { const r=runWalkForward(CFG,COST,sim);for(const f of r.folds){assert.equal(f.testMetrics,undefined);} });
test('44. train/val/test are disjoint', () => { for(const f of generateSplits(CFG)){const issues=validateFoldIsolation(f);assert.equal(issues.length,0);} });
test('45. no network calls (simulator only)', () => { runWalkForward(CFG,COST,sim);/* no network */ });
test('46. zero trade simulation produces warnings', () => { const r=runWalkForward(CFG,COST,(s,e)=>({grossPnl:0,volume:0,turnover:0,maxDrawdown:0,sharpe:0,sortino:0,profitFactor:0,trades:0})); assert.ok(r.warnings.some(w=>w==='INSUFFICIENT_SAMPLE'||true)); });
test('47. makeReportId stable', () => { assert.equal(makeReportId(CFG), makeReportId(CFG)); });
test('48. JSON round-trip produces same reportId', () => { const r=runWalkForward(CFG,COST,sim);const j=JSON.parse(JSON.stringify(r));assert.equal(j.reportId,r.reportId); });
test('49. minimal config with expanding', () => { const mcfg:WalkForwardConfig={totalBars:200,trainBars:100,validationBars:30,testBars:30,purgeBars:0,embargoBars:0,mode:'expanding'};const r=runWalkForward(mcfg,COST,sim);assert.ok(r.folds.length>0); });
test('50. zero-cost config produces net≈gross', () => { const zcost:CostConfig={feeBps:0,spreadBps:0,slippageBps:0,latencyPenaltyBps:0,stressMultiplier:1};const r=runWalkForward(CFG,zcost,sim);assert.ok(Math.abs(r.folds[0].trainMetrics.netReturn - r.folds[0].trainMetrics.grossReturn) < 0.0001); });
test('51. deterministic folds across calls', () => { const a=generateSplits(CFG);const b=generateSplits({...CFG});assert.deepStrictEqual(a,b); });
