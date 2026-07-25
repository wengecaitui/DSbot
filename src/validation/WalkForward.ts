// Stage 4A4-R4: Walk-forward — real multi-fold aggregation, per-fold minTrades, phase ledger.
import type { WalkForwardConfig, CostConfig, CostBreakdown, PerformanceMetrics, FoldMetrics, ParameterCandidate, ValidationReport, ValidationWarning, StressScenario, ValidationClock } from './ValidationTypes';
import { makeReportId, deepFreeze, VALIDATION_WARNINGS, systemValidationClock } from './ValidationTypes';
import { generateSplits, validateFoldIsolation } from './ChronologicalSplit';

export interface SimResult { grossPnl: number; volume: number; turnover: number; maxDrawdown: number; sharpe: number; sortino: number; profitFactor: number; trades: number; }

export interface PhaseCall { phase: 'train' | 'validation' | 'test'; fold: number; candidateId?: string; start: number; end: number; }
export interface SimCallLedger { calls: number; log: PhaseCall[]; }

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
  const v = (baseMetrics as any)._volume ?? 0; const t = baseMetrics.turnover;
  const c = computeCosts(baseMetrics.grossReturn, v, t, { ...costCfg, stressMultiplier: multiplier });
  return { grossReturn: baseMetrics.grossReturn, netReturn: c.netReturn, maxDrawdown: baseMetrics.maxDrawdown, sharpeRatio: baseMetrics.sharpeRatio, sortinoRatio: baseMetrics.sortinoRatio, profitFactor: baseMetrics.profitFactor, tradeCount: baseMetrics.tradeCount, turnover: t, costBreakdown: c, _volume: v };
}

export function selectParameters(candidates: ParameterCandidate[], minTrades: number = 5): { candidates: ParameterCandidate[]; selectedId?: string; selectedParams?: Record<string, string | number> } {
  const out: ParameterCandidate[] = [];
  for (const c of candidates) {
    let accept = true; let reason = '';
    if (c.minTrainTrades < minTrades) { accept = false; reason = 'MIN_TRADES_TRAIN'; }
    if (c.minValidationTrades < minTrades) { accept = false; reason = 'MIN_TRADES_VALIDATION'; }
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
  const ledger = opts.ledger ?? { calls: 0, log: [] };
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

  // Multi-fold candidate evaluation — real netReturn per fold
  if (opts.paramGrid && opts.paramGrid.length > 0) {
    const fullCandidates: ParameterCandidate[] = [];
    for (let ci = 0; ci < opts.paramGrid.length; ci++) {
      const p = opts.paramGrid[ci];
      const valNets: number[] = [];
      let minTrainTrades = Infinity; let minValTrades = Infinity;
      let trainTotalNet = 0; let valTotalNet = 0;
      let lastTrainMetrics: PerformanceMetrics | undefined;
      let lastValMetrics: PerformanceMetrics | undefined;
      for (const s of splits) {
        const tr = simulator(s.train.start, s.train.end, p); ledger.calls++; ledger.log.push({ phase: 'train', fold: s.fold, candidateId: `p${ci}`, start: s.train.start, end: s.train.end });
        const trainM = makeMetrics(tr, costCfg);
        const vr = simulator(s.validation.start, s.validation.end, p); ledger.calls++; ledger.log.push({ phase: 'validation', fold: s.fold, candidateId: `p${ci}`, start: s.validation.start, end: s.validation.end });
        const valM = makeMetrics(vr, costCfg);
        valNets.push(valM.netReturn); minTrainTrades = Math.min(minTrainTrades, tr.trades); minValTrades = Math.min(minValTrades, vr.trades);
        trainTotalNet += trainM.netReturn; valTotalNet += valM.netReturn;
        lastTrainMetrics = trainM; lastValMetrics = valM;
      }
      const avgValNet = valTotalNet / splits.length;
      fullCandidates.push({
        id: `p${ci}`, params: p, validationScore: avgValNet, trainScore: trainTotalNet / splits.length,
        foldScores: valNets,
        metrics: { fold: 0, trainMetrics: lastTrainMetrics!, validationMetrics: lastValMetrics!, selected: false },
        minTrainTrades, minValidationTrades: minValTrades,
        accepted: true, selected: false,
      });
    }
    const sel = selectParameters(fullCandidates);
    if (sel.selectedId) { selectedParams = sel.selectedParams; selectedFold = 0; }
    if (sel.candidates.some(c => !c.accepted)) warnings.push('PARAMETER_INSTABILITY');
  }

  // Evaluate folds — test exact-once after selection
  for (const s of splits) {
    const tr = simulator(s.train.start, s.train.end, selectedParams); ledger.calls++; ledger.log.push({ phase: 'train', fold: s.fold, start: s.train.start, end: s.train.end });
    const trainM = makeMetrics(tr, costCfg);
    const vr = simulator(s.validation.start, s.validation.end, selectedParams); ledger.calls++; ledger.log.push({ phase: 'validation', fold: s.fold, start: s.validation.start, end: s.validation.end });
    const valM = makeMetrics(vr, costCfg);
    let testM: PerformanceMetrics | undefined;
    if (selectedParams) {
      const ts = simulator(s.test.start, s.test.end, selectedParams); ledger.calls++; ledger.log.push({ phase: 'test', fold: s.fold, start: s.test.start, end: s.test.end });
      testM = makeMetrics(ts, costCfg);
    }
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
    warnings, limitations: ['paper-only simulation', 'no forward-looking claims'],
    stressScenarios, simulatorVersion: opts.simVersion,
  });
}
