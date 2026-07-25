// Stage 4A4-R3: Walk-forward — real cost recompute, minTrades gate, datasetHash.
import type { WalkForwardConfig, CostConfig, CostBreakdown, PerformanceMetrics, FoldMetrics, ParameterCandidate, ValidationReport, ValidationWarning, StressScenario, ValidationClock } from './ValidationTypes';
import { makeReportId, deepFreeze, VALIDATION_WARNINGS, systemValidationClock } from './ValidationTypes';
import { generateSplits, validateFoldIsolation } from './ChronologicalSplit';

export interface SimCallLedger { calls: number; }
export interface SimResult { grossPnl: number; volume: number; turnover: number; maxDrawdown: number; sharpe: number; sortino: number; profitFactor: number; trades: number; }

export function computeCosts(grossPnl: number, volume: number, turn: number, cfg: CostConfig): CostBreakdown {
  const m = cfg.stressMultiplier;
  const fees = volume * cfg.feeBps / 10000 * m * 2;
  const spreadCost = volume * cfg.spreadBps / 10000 * m;
  const slippageCost = volume * cfg.slippageBps / 10000 * m;
  const latencyCost = turn * cfg.latencyPenaltyBps / 10000 * m;
  return { grossReturn: grossPnl, fees, spreadCost, slippageCost, latencyCost, netReturn: grossPnl - fees - spreadCost - slippageCost - latencyCost };
}

export function makeMetrics(sim: SimResult, costCfg: CostConfig): PerformanceMetrics {
  const cb = computeCosts(sim.grossPnl, sim.volume, sim.turnover, costCfg);
  return { grossReturn: sim.grossPnl, netReturn: cb.netReturn, maxDrawdown: sim.maxDrawdown, sharpeRatio: sim.sharpe, sortinoRatio: sim.sortino, profitFactor: sim.profitFactor, tradeCount: sim.trades, turnover: sim.turnover, costBreakdown: cb, _volume: sim.volume };
}

export function recomputeCosts(baseMetrics: PerformanceMetrics, multiplier: number, costCfg: CostConfig): PerformanceMetrics {
  const volume = (baseMetrics as any)._volume ?? 0;
  const turn = baseMetrics.turnover;
  const scaled: CostConfig = { ...costCfg, stressMultiplier: multiplier };
  const cb = computeCosts(baseMetrics.grossReturn, volume, turn, scaled);
  return {
    grossReturn: baseMetrics.grossReturn, netReturn: cb.netReturn,
    maxDrawdown: baseMetrics.maxDrawdown, sharpeRatio: baseMetrics.sharpeRatio,
    sortinoRatio: baseMetrics.sortinoRatio, profitFactor: baseMetrics.profitFactor,
    tradeCount: baseMetrics.tradeCount, turnover: turn, costBreakdown: cb,
    _volume: volume,
  };
}

export function selectParameters(candidates: ParameterCandidate[], minTrades: number = 5): { candidates: ParameterCandidate[]; selectedId?: string; selectedParams?: Record<string, string | number> } {
  const out: ParameterCandidate[] = [];
  for (const c of candidates) {
    let accept = true; let reason = '';
    if (c.metrics?.trainMetrics.tradeCount! < minTrades) { accept = false; reason = 'MIN_TRADES_TRAIN'; }
    if (c.metrics.validationMetrics.tradeCount < minTrades) { accept = false; reason = 'MIN_TRADES_VALIDATION'; }
    if (c.validationScore < c.trainScore * 0.5) { if (!reason) reason = 'VALIDATION_DEGRADATION'; accept = false; }
    out.push({ ...c, accepted: accept, rejectionReason: reason || undefined, selected: false });
  }
  const pass = out.filter(c => c.accepted).sort((a, b) => b.validationScore - a.validationScore || JSON.stringify(a.params).localeCompare(JSON.stringify(b.params)));
  if (pass.length > 0) pass[0].selected = true;
  return { candidates: out, selectedId: pass[0]?.id, selectedParams: pass[0]?.params };
}

export function runWalkForward(
  cfg: WalkForwardConfig, costCfg: CostConfig,
  simulator: (start: number, end: number, params?: Record<string, string | number>) => SimResult,
  opts: { paramGrid?: Record<string, string | number>[]; simVersion?: string; clock?: ValidationClock; ledger?: SimCallLedger; datasetHash?: string } = {},
): ValidationReport {
  const clock = opts.clock ?? systemValidationClock;
  const ledger = opts.ledger ?? { calls: 0 };
  const splits = generateSplits(cfg);
  const warnings: ValidationWarning[] = [];
  const foldMetrics: FoldMetrics[] = [];
  let selectedParams: Record<string, string | number> | undefined;
  let selectedFold: number | undefined;

  // Validate isolation
  for (let i = 0; i < splits.length; i++) {
    const issues = validateFoldIsolation(splits[i], splits[i + 1]);
    if (issues.length > 0) warnings.push('LEAKAGE_DETECTED');
  }

  // Multi-fold candidate evaluation (train+val only, no test)
  if (opts.paramGrid && opts.paramGrid.length > 0) {
    const candidates: ParameterCandidate[] = [];
    for (let i = 0; i < opts.paramGrid.length; i++) {
      const p = opts.paramGrid[i];
      const trainPnl: number[] = []; const valPnl: number[] = [];
      let trainTrades = 0; let valTrades = 0;
      for (const s of splits) {
        const tr = simulator(s.train.start, s.train.end, p); ledger.calls++; trainPnl.push(tr.grossPnl); trainTrades = tr.trades;
        const vr = simulator(s.validation.start, s.validation.end, p); ledger.calls++; valPnl.push(vr.grossPnl); valTrades = vr.trades;
      }
      const avgValNet = valPnl.reduce((a, b) => a + b, 0) / valPnl.length;
      const avgTrainNet = trainPnl.reduce((a, b) => a + b, 0) / trainPnl.length;
      candidates.push({
        id: `p${i}`, params: p, validationScore: avgValNet, foldScores: valPnl,
        metrics: { fold: 0, trainMetrics: makeMetrics({grossPnl:avgTrainNet,volume:2000,turnover:2,maxDrawdown:0.1,sharpe:1,sortino:1,profitFactor:1,trades:trainTrades},costCfg), validationMetrics: makeMetrics({grossPnl:avgValNet,volume:2000,turnover:2,maxDrawdown:0.1,sharpe:1,sortino:1,profitFactor:1,trades:valTrades},costCfg), selected: false },
        accepted: true, selected: false,
      });
    }
    const sel = selectParameters(candidates);
    if (sel.selectedId) { selectedParams = sel.selectedParams; selectedFold = 0; }
    if (sel.candidates.some(c => !c.accepted)) warnings.push('PARAMETER_INSTABILITY');
  }

  // Evaluate folds (train+val always, test only if params selected)
  for (const s of splits) {
    const tr = simulator(s.train.start, s.train.end, selectedParams); ledger.calls++;
    const trainM = makeMetrics(tr, costCfg);
    const vr = simulator(s.validation.start, s.validation.end, selectedParams); ledger.calls++;
    const valM = makeMetrics(vr, costCfg);
    let testM: PerformanceMetrics | undefined;
    if (selectedParams) { const ts = simulator(s.test.start, s.test.end, selectedParams); ledger.calls++; testM = makeMetrics(ts, costCfg); }
    if (trainM.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
    if (valM.netReturn < trainM.netReturn * 0.7) warnings.push('VALIDATION_DEGRADATION');
    foldMetrics.push({ fold: s.fold, trainMetrics: trainM, validationMetrics: valM, testMetrics: testM, selected: s.fold === selectedFold });
  }

  const bm = foldMetrics[0];
  const stressScenarios: StressScenario[] = bm ? [
    { name: 'baseline', multiplier: 1.0, metrics: bm.trainMetrics },
    { name: '1.5x', multiplier: 1.5, metrics: recomputeCosts(bm.trainMetrics, 1.5, costCfg) },
    { name: '2x', multiplier: 2.0, metrics: recomputeCosts(bm.trainMetrics, 2.0, costCfg) },
  ] : [];

  return deepFreeze({
    reportId: makeReportId(cfg, costCfg, opts.datasetHash ?? '', selectedParams ?? {}, opts.simVersion ?? ''),
    createdAt: clock.nowISO(), config: cfg, costConfig: costCfg,
    folds: foldMetrics, selectedFold, selectedParameters: selectedParams,
    warnings, limitations: ['paper-only simulation', 'no forward-looking claims', 'cost metrics re-computed from original grossPnl/volume/turnover'],
    stressScenarios, simulatorVersion: opts.simVersion,
  });
}
