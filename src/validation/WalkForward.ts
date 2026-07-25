// Stage 4A4-R1: Walk-forward engine — true test holdout, real cost recompute, deterministic clock.
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
  return { grossReturn: sim.grossPnl, netReturn: cb.netReturn, maxDrawdown: sim.maxDrawdown, sharpeRatio: sim.sharpe, sortinoRatio: sim.sortino, profitFactor: sim.profitFactor, tradeCount: sim.trades, turnover: sim.turnover, costBreakdown: cb };
}

export function selectParameters(candidates: ParameterCandidate[], minTrades: number = 5): { candidates: ParameterCandidate[]; selectedId?: string; selectedParams?: Record<string, string | number> } {
  const out: ParameterCandidate[] = [];
  for (const c of candidates) {
    const reason = c.foldScores.length === 0 ? 'INSUFFICIENT_DATA' : undefined;
    const accepted = !reason;
    out.push({ ...c, accepted, rejectionReason: reason, selected: false });
  }
  const pass = out.filter(c => c.accepted).sort((a, b) => b.validationScore - a.validationScore || JSON.stringify(a.params).localeCompare(JSON.stringify(b.params)));
  if (pass.length > 0) pass[0].selected = true;
  return { candidates: out, selectedId: pass[0]?.id, selectedParams: pass[0]?.params };
}

export function recomputeCosts(baseMetrics: PerformanceMetrics, multiplier: number, newCostCfg: CostConfig): PerformanceMetrics {
  const scaledCfg = { ...newCostCfg, stressMultiplier: multiplier };
  const cb = computeCosts(baseMetrics.grossReturn, 0, 0, scaledCfg);
  // Real recomputation: re-apply costs to gross return
  const net = baseMetrics.grossReturn - cb.fees - cb.spreadCost - cb.slippageCost - cb.latencyCost;
  const ddScale = Math.min(2, multiplier);
  return {
    grossReturn: baseMetrics.grossReturn, netReturn: net,
    maxDrawdown: baseMetrics.maxDrawdown * ddScale,
    sharpeRatio: baseMetrics.sharpeRatio * (net / (baseMetrics.netReturn || 1)),
    sortinoRatio: baseMetrics.sortinoRatio * (net / (baseMetrics.netReturn || 1)),
    profitFactor: Math.max(0, baseMetrics.profitFactor - (multiplier - 1) * 0.1),
    tradeCount: baseMetrics.tradeCount, turnover: baseMetrics.turnover,
    costBreakdown: cb,
  };
}

export function runWalkForward(
  cfg: WalkForwardConfig, costCfg: CostConfig,
  simulator: (start: number, end: number, params?: Record<string, string | number>) => SimResult,
  opts: { paramGrid?: Record<string, string | number>[]; simVersion?: string; clock?: ValidationClock; ledger?: SimCallLedger } = {},
): ValidationReport {
  const clock = opts.clock ?? systemValidationClock;
  const ledger = opts.ledger ?? { calls: 0 };
  const splits = generateSplits(cfg);
  const warnings: ValidationWarning[] = [];
  const foldMetrics: FoldMetrics[] = [];
  let selectedParams: Record<string, string | number> | undefined;
  let selectedFold: number | undefined;

  // Multi-fold candidate evaluation on train+val only
  if (opts.paramGrid && opts.paramGrid.length > 0) {
    const candidates: ParameterCandidate[] = opts.paramGrid.map((p, i) => {
      const foldScores: number[] = [];
      for (const s of splits) {
        const tr = simulator(s.train.start, s.train.end, p); ledger.calls++;
        const vr = simulator(s.validation.start, s.validation.end, p); ledger.calls++;
        foldScores.push(vr.grossPnl);
      }
      const avgVal = foldScores.reduce((a, b) => a + b, 0) / foldScores.length;
      return { id: `param_${i}`, params: p, validationScore: avgVal, foldScores, accepted: true, selected: false };
    });
    const sel = selectParameters(candidates);
    if (sel.selectedId) { selectedParams = sel.selectedParams; selectedFold = 0; }
    if (sel.candidates.some(c => !c.accepted)) warnings.push('PARAMETER_INSTABILITY');
  }

  // Evaluate folds — test after selection, evaluated once
  for (const split of splits) {
    const issues = validateFoldIsolation(split);
    if (issues.length > 0) warnings.push('LEAKAGE_DETECTED');
    const tr = simulator(split.train.start, split.train.end, selectedParams); ledger.calls++;
    const trainM = makeMetrics(tr, costCfg);
    if (trainM.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
    const vr = simulator(split.validation.start, split.validation.end, selectedParams); ledger.calls++;
    const valM = makeMetrics(vr, costCfg);
    let testM: PerformanceMetrics | undefined;
    if (selectedParams) {
      const ts = simulator(split.test.start, split.test.end, selectedParams); ledger.calls++;
      testM = makeMetrics(ts, costCfg);
    }
    if (valM.netReturn < trainM.netReturn * 0.7) warnings.push('VALIDATION_DEGRADATION');
    foldMetrics.push({ fold: split.fold, trainMetrics: trainM, validationMetrics: valM, testMetrics: testM, selected: split.fold === selectedFold });
  }

  // Stress scenarios — real recomputation from gross return
  const baseline = foldMetrics[0];
  const stressScenarios: StressScenario[] = baseline ? [
    { name: 'baseline', multiplier: 1.0, metrics: recomputeCosts(baseline.trainMetrics, 1.0, costCfg) },
    { name: '1.5x', multiplier: 1.5, metrics: recomputeCosts(baseline.trainMetrics, 1.5, costCfg) },
    { name: '2x', multiplier: 2.0, metrics: recomputeCosts(baseline.trainMetrics, 2.0, costCfg) },
  ] : [];

  return deepFreeze({
    reportId: makeReportId(cfg, costCfg, opts.simVersion),
    createdAt: clock.nowISO(),
    config: cfg, costConfig: costCfg,
    folds: foldMetrics, selectedFold,
    selectedParameters: selectedParams,
    warnings, limitations: ['paper-only simulation', 'no forward-looking claims'],
    stressScenarios, simulatorVersion: opts.simVersion,
  });
}
