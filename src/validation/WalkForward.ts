// Stage 4A4: Cost stress, parameter selection, walk-forward engine.
import type { CostConfig, CostBreakdown, PerformanceMetrics, FoldMetrics, WalkForwardConfig, ChronologicalSplit, ParameterCandidate, ParameterSelectionResult, ValidationReport, ValidationWarning } from './ValidationTypes';
import { makeReportId, VALIDATION_WARNINGS } from './ValidationTypes';
import { generateSplits, validateFoldIsolation } from './ChronologicalSplit';

// ── Cost Stress ───────────────────────────────────────────────
export function computeCosts(grossPnl: number, volume: number, turn: number, cfg: CostConfig): CostBreakdown {
  const m = cfg.stressMultiplier;
  const fees = volume * cfg.feeBps / 10000 * m * 2;
  const spreadCost = volume * cfg.spreadBps / 10000 * m;
  const slippageCost = volume * cfg.slippageBps / 10000 * m;
  const latencyCost = turn * cfg.latencyPenaltyBps / 10000 * m;
  const netReturn = grossPnl - fees - spreadCost - slippageCost - latencyCost;
  return { grossReturn: grossPnl, fees, spreadCost, slippageCost, latencyCost, netReturn };
}

export function makeMetrics(grossPnl: number, volume: number, turn: number, maxDd: number, sharpe: number, sortino: number, pf: number, trades: number, costCfg: CostConfig): PerformanceMetrics {
  return { grossReturn: grossPnl, netReturn: computeCosts(grossPnl, volume, turn, costCfg).netReturn, maxDrawdown: maxDd, sharpeRatio: sharpe, sortinoRatio: sortino, profitFactor: pf, tradeCount: trades, turnover: turn, costBreakdown: computeCosts(grossPnl, volume, turn, costCfg) };
}

// ── Parameter Selection ───────────────────────────────────────
export function selectParameters(candidates: ParameterCandidate[], minTrades: number = 5): ParameterSelectionResult {
  const accepted: ParameterCandidate[] = [];
  const warnings: Set<string> = new Set();
  for (const c of candidates) {
    let accept = true; let reason = '';
    if (c.metrics.trainMetrics.tradeCount < minTrades) { accept = false; reason = 'INSUFFICIENT_TRADES_TRAIN'; }
    if (c.metrics.validationMetrics.tradeCount < minTrades) { accept = false; reason = 'INSUFFICIENT_TRADES_VALIDATION'; }
    if (c.validationScore < c.trainScore * 0.5) { reason = 'VALIDATION_DEGRADATION'; warnings.add(VALIDATION_WARNINGS.VALIDATION_DEGRADATION); }
    accepted.push({ ...c, accepted: accept, rejectionReason: reason || undefined, selected: false });
  }

  // Select best by validation score (deterministic tie-break by id)
  const pass = accepted.filter(c => c.accepted).sort((a, b) => b.validationScore - a.validationScore || a.id.localeCompare(b.id));
  if (pass.length > 0) { pass[0].selected = true; }

  return { candidates: accepted, selectedId: pass[0]?.id, selectedParams: pass[0]?.params };
}

// ── Walk-Forward Engine ───────────────────────────────────────
export interface SimResult { grossPnl: number; volume: number; turnover: number; maxDrawdown: number; sharpe: number; sortino: number; profitFactor: number; trades: number; }

export function runWalkForward(
  cfg: WalkForwardConfig,
  costCfg: CostConfig,
  simulator: (start: number, end: number, params?: Record<string, string | number>) => SimResult,
  paramGrid?: Record<string, string | number>[],
): ValidationReport {
  const splits = generateSplits(cfg);
  const warnings: ValidationWarning[] = [];
  const foldMetrics: FoldMetrics[] = [];

  for (const split of splits) {
    const issues = validateFoldIsolation(split);
    if (issues.length > 0) { warnings.push('LEAKAGE_DETECTED'); }
    // Train
    const trainR = simulator(split.train.start, split.train.end);
    const trainM = makeMetrics(trainR.grossPnl, trainR.volume, trainR.turnover, trainR.maxDrawdown, trainR.sharpe, trainR.sortino, trainR.profitFactor, trainR.trades, costCfg);
    // Validation
    const valR = simulator(split.validation.start, split.validation.end);
    const valM = makeMetrics(valR.grossPnl, valR.volume, valR.turnover, valR.maxDrawdown, valR.sharpe, valR.sortino, valR.profitFactor, valR.trades, costCfg);

    if (trainM.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
    const degradation = valM.netReturn < trainM.netReturn * 0.7;
    if (degradation) warnings.push('VALIDATION_DEGRADATION');

    foldMetrics.push({ fold: split.fold, trainMetrics: trainM, validationMetrics: valM, selected: false });
  }

  // Parameter selection
  let selectedFold: number | undefined;
  let selectedParams: Record<string, string | number> | undefined;
  if (paramGrid && paramGrid.length > 0) {
    const candidates: ParameterCandidate[] = paramGrid.map((p, i) => {
      const mid = splits[0]; // use first fold for param selection
      const tr = simulator(mid.train.start, mid.train.end, p);
      const vr = simulator(mid.validation.start, mid.validation.end, p);
      const tm = makeMetrics(tr.grossPnl, tr.volume, tr.turnover, tr.maxDrawdown, tr.sharpe, tr.sortino, tr.profitFactor, tr.trades, costCfg);
      const vm = makeMetrics(vr.grossPnl, vr.volume, vr.turnover, vr.maxDrawdown, vr.sharpe, vr.sortino, vr.profitFactor, vr.trades, costCfg);
      const fm: FoldMetrics = { fold: 0, trainMetrics: tm, validationMetrics: vm, selected: false };
      return { id: `p${i}`, params: p, trainScore: tm.netReturn, validationScore: vm.netReturn, metrics: fm, accepted: true, selected: false };
    });
    const sel = selectParameters(candidates);
    if (sel.candidates.some(c => !c.accepted)) warnings.push('PARAMETER_INSTABILITY');
    if (sel.selectedId) {
      const sc = sel.candidates.find(c => c.id === sel.selectedId)!;
      selectedFold = sc.metrics.fold; selectedParams = sc.params;
      foldMetrics[selectedFold] = { ...foldMetrics[selectedFold], selected: true };
    }
  }

  // Stress scenarios
  const stressScenarios = [
    { name: 'baseline', multiplier: 1.0, metrics: costCfg.stressMultiplier === 1.0 ? foldMetrics[0]?.trainMetrics : makeMetrics(0, 0, 0, 0, 0, 0, 0, 0, { ...costCfg, stressMultiplier: 1.0 }) },
    { name: '2x stress', multiplier: 2.0, metrics: makeMetrics(foldMetrics[0]?.trainMetrics.grossReturn ?? 0, 0, 1, (foldMetrics[0]?.trainMetrics.maxDrawdown ?? 0) * 2, (foldMetrics[0]?.trainMetrics.sharpeRatio ?? 0) * 0.5, (foldMetrics[0]?.trainMetrics.sortinoRatio ?? 0) * 0.5, (foldMetrics[0]?.trainMetrics.profitFactor ?? 0) * 0.5, foldMetrics[0]?.trainMetrics.tradeCount ?? 0, { ...costCfg, stressMultiplier: 2.0 }) },
  ];

  return Object.freeze({
    reportId: makeReportId(cfg),
    createdAt: new Date().toISOString(),
    config: cfg,
    costConfig: costCfg,
    folds: foldMetrics,
    selectedFold,
    selectedParameters: selectedParams,
    warnings,
    limitations: ['paper-only', 'no forward-looking claims', 'historical simulation only'],
    stressScenarios,
  });
}
