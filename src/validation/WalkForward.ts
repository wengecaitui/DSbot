// Stage 4A4-R8: Walk-forward — causal-per-fold selection, FinalHoldout, deployment contract, phase ledger.
import type { WalkForwardConfig, CostConfig, CostBreakdown, PerformanceMetrics, FoldMetrics, ParameterCandidate, ValidationReport, ValidationWarning, StressScenario, ValidationClock, FinalHoldoutConfig, FinalHoldoutMetrics, CandidateResult, SelectionMode } from './ValidationTypes';
import { makeReportId, deepFreeze, VALIDATION_WARNINGS, systemValidationClock } from './ValidationTypes';
import { generateSplits, validateFoldIsolation } from './ChronologicalSplit';
import { allocateFinalHoldout } from './FinalHoldout';

export interface SimResult { grossPnl: number; volume: number; turnover: number; maxDrawdown: number; sharpe: number; sortino: number; profitFactor: number; trades: number; }

export interface PhaseCall { phase: 'train' | 'validation' | 'test' | 'final-holdout'; fold: number; candidateId?: string; start: number; end: number; }
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

// ── Per-fold candidate evaluation (causal-per-fold mode) ────────
function evaluateFoldCandidates(
  foldIdx: number, splits: { train: { start: number; end: number }; validation: { start: number; end: number } },
  params: Record<string, string | number>,
  simulator: (start: number, end: number, params?: Record<string, string | number>) => SimResult,
  costCfg: CostConfig, minTrades: number, ledger: SimCallLedger,
): { candidate: ParameterCandidate; trainMetrics: PerformanceMetrics; valMetrics: PerformanceMetrics } | null {
  const cid = JSON.stringify(params);
  ledger.calls++; ledger.log.push({ phase: 'train', fold: foldIdx, candidateId: cid, start: splits.train.start, end: splits.train.end });
  const tr = simulator(splits.train.start, splits.train.end, params);
  const trainM = makeMetrics(tr, costCfg);
  ledger.calls++; ledger.log.push({ phase: 'validation', fold: foldIdx, candidateId: cid, start: splits.validation.start, end: splits.validation.end });
  const vr = simulator(splits.validation.start, splits.validation.end, params);
  const valM = makeMetrics(vr, costCfg);

  let accept = true; let reason = '';
  if (tr.trades < minTrades) { accept = false; reason = 'MIN_TRADES_TRAIN'; }
  if (vr.trades < minTrades) { accept = false; reason = 'MIN_TRADES_VALIDATION'; }
  if (valM.netReturn < trainM.netReturn * 0.5) { if (!reason) reason = 'VALIDATION_DEGRADATION'; accept = false; }

  return {
    candidate: { id: cid, params, validationScore: valM.netReturn, trainScore: trainM.netReturn, foldScores: [valM.netReturn], metrics: { fold: foldIdx, trainMetrics: trainM, validationMetrics: valM, selected: false, usedForDeployment: false }, minTrainTrades: tr.trades, minValidationTrades: vr.trades, accepted: accept, rejectionReason: reason || undefined, selected: false },
    trainMetrics: trainM, valMetrics: valM,
  };
}

export function runWalkForward(
  cfg: WalkForwardConfig, costCfg: CostConfig,
  simulator: (start: number, end: number, params?: Record<string, string | number>) => SimResult,
  opts: { paramGrid?: Record<string, string | number>[]; simVersion?: string; clock?: ValidationClock; ledger?: SimCallLedger; datasetHash?: string } = {},
): ValidationReport {
  const clock = opts.clock ?? systemValidationClock;
  const ledger = opts.ledger ?? { calls: 0, log: [] };
  const mode: SelectionMode = cfg.selectionMode ?? 'global';
  const contractVersion = '4A4-R8';

  // ── Final Holdout allocation ─────────────────────────────────
  let finalHoldoutConfig: FinalHoldoutConfig | undefined;
  if (cfg.finalHoldoutRatio !== undefined || cfg.finalHoldoutMinBars !== undefined) {
    finalHoldoutConfig = allocateFinalHoldout(cfg);
  }

  // ── Fold generation (constrained by holdout if present) ──────
  const devBars = finalHoldoutConfig ? finalHoldoutConfig.developmentEndExclusive : cfg.totalBars;
  const devCfg = { ...cfg, totalBars: devBars };
  const splits = generateSplits(devCfg);
  if (splits.length === 0) {
    // If no development folds exist but holdout was requested, that's a config error
    throw new Error(finalHoldoutConfig ? 'HOLDOUT_INSUFFICIENT_DEVELOPMENT' : 'SPLIT_INSUFFICIENT_DATA');
  }

  const warnings: ValidationWarning[] = [];
  const foldMetrics: FoldMetrics[] = [];

  // Validate isolation
  for (let i = 0; i < splits.length; i++) {
    const issues = validateFoldIsolation(splits[i], splits[i + 1]);
    if (issues.length > 0) warnings.push('LEAKAGE_DETECTED');
  }

  let deploymentParams: Record<string, string | number> | undefined;
  let deploymentCandidateId: string | undefined;
  let selectedFoldIndex: number | undefined;

  // ── Mode dispatch ────────────────────────────────────────────
  if (mode === 'causal-per-fold' && opts.paramGrid && opts.paramGrid.length > 0) {
    // Causal-per-fold: each fold independently selects from its own train+validation
    for (const s of splits) {
      const results: CandidateResult[] = [];
      let bestCandidate: ParameterCandidate | undefined;
      let bestTrainMetrics: PerformanceMetrics | undefined;
      let bestValMetrics: PerformanceMetrics | undefined;

      for (let ci = 0; ci < opts.paramGrid.length; ci++) {
        const p = opts.paramGrid[ci];
        const ev = evaluateFoldCandidates(s.fold, s, p, simulator, costCfg, 5, ledger);
        if (!ev) continue;
        const { candidate, trainMetrics, valMetrics } = ev;
        results.push({ candidateId: candidate.id, params: candidate.params, validationScore: candidate.validationScore, trainScore: candidate.trainScore, accepted: candidate.accepted, rejectionReason: candidate.rejectionReason });

        if (!bestCandidate || (candidate.accepted && candidate.validationScore > (bestCandidate.validationScore ?? -Infinity))) {
          bestCandidate = candidate;
          bestTrainMetrics = trainMetrics;
          bestValMetrics = valMetrics;
        }
      }

      // Select best for this fold
      const foldParams = bestCandidate?.accepted ? bestCandidate.params : undefined;
      const foldCandidateId = bestCandidate?.accepted ? bestCandidate.id : undefined;
      if (bestCandidate && foldParams) bestCandidate.selected = true;

      // Run test with fold's own selection
      let testM: PerformanceMetrics | undefined;
      if (foldParams) {
        ledger.calls++; ledger.log.push({ phase: 'test', fold: s.fold, start: s.test.start, end: s.test.end });
        const ts = simulator(s.test.start, s.test.end, foldParams);
        testM = makeMetrics(ts, costCfg);
      }

      // Deployment params = last valid selection
      if (foldParams) {
        deploymentParams = foldParams;
        deploymentCandidateId = foldCandidateId;
        selectedFoldIndex = s.fold;
      }

      const foldM: FoldMetrics = {
        fold: s.fold,
        trainMetrics: bestTrainMetrics ?? makeMetrics(simulator(s.train.start, s.train.end, {}), costCfg),
        validationMetrics: bestValMetrics ?? makeMetrics(simulator(s.validation.start, s.validation.end, {}), costCfg),
        testMetrics: testM,
        selected: foldParams !== undefined,
        selectedParameters: foldParams,
        selectedCandidateId: foldCandidateId,
        candidateResults: results,
        usedForDeployment: foldParams !== undefined && foldParams === deploymentParams,
      };

      if (bestTrainMetrics && bestTrainMetrics.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
      if (bestValMetrics && bestTrainMetrics && bestValMetrics.netReturn < bestTrainMetrics.netReturn * 0.7) warnings.push('VALIDATION_DEGRADATION');
      if (results.some(r => !r.accepted)) warnings.push('PARAMETER_INSTABILITY');

      foldMetrics.push(foldM);
    }
  } else if (mode === 'global' && opts.paramGrid && opts.paramGrid.length > 0) {
    // Global selection (backward-compatible): evaluate all candidates across all folds
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
        metrics: { fold: 0, trainMetrics: lastTrainMetrics!, validationMetrics: lastValMetrics!, selected: false, usedForDeployment: false },
        minTrainTrades, minValidationTrades: minValTrades,
        accepted: true, selected: false,
      });
    }
    const sel = selectParameters(fullCandidates);
    if (sel.selectedId) { deploymentParams = sel.selectedParams; deploymentCandidateId = sel.selectedId; selectedFoldIndex = 0; }
    if (sel.candidates.some(c => !c.accepted)) warnings.push('PARAMETER_INSTABILITY');

    // Evaluate folds with global selection
    for (const s of splits) {
      const tr = simulator(s.train.start, s.train.end, deploymentParams); ledger.calls++; ledger.log.push({ phase: 'train', fold: s.fold, start: s.train.start, end: s.train.end });
      const trainM = makeMetrics(tr, costCfg);
      const vr = simulator(s.validation.start, s.validation.end, deploymentParams); ledger.calls++; ledger.log.push({ phase: 'validation', fold: s.fold, start: s.validation.start, end: s.validation.end });
      const valM = makeMetrics(vr, costCfg);
      let testM: PerformanceMetrics | undefined;
      if (deploymentParams) {
        const ts = simulator(s.test.start, s.test.end, deploymentParams); ledger.calls++; ledger.log.push({ phase: 'test', fold: s.fold, start: s.test.start, end: s.test.end });
        testM = makeMetrics(ts, costCfg);
      }
      if (trainM.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
      if (valM.netReturn < trainM.netReturn * 0.7) warnings.push('VALIDATION_DEGRADATION');
      foldMetrics.push({
        fold: s.fold, trainMetrics: trainM, validationMetrics: valM, testMetrics: testM,
        selected: s.fold === selectedFoldIndex,
        usedForDeployment: s.fold === selectedFoldIndex,
      });
    }
  } else {
    // No paramGrid: evaluate with no selection
    for (const s of splits) {
      const tr = simulator(s.train.start, s.train.end); ledger.calls++; ledger.log.push({ phase: 'train', fold: s.fold, start: s.train.start, end: s.train.end });
      const trainM = makeMetrics(tr, costCfg);
      const vr = simulator(s.validation.start, s.validation.end); ledger.calls++; ledger.log.push({ phase: 'validation', fold: s.fold, start: s.validation.start, end: s.validation.end });
      const valM = makeMetrics(vr, costCfg);
      if (trainM.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
      if (valM.netReturn < trainM.netReturn * 0.7) warnings.push('VALIDATION_DEGRADATION');
      foldMetrics.push({
        fold: s.fold, trainMetrics: trainM, validationMetrics: valM, testMetrics: undefined,
        selected: false, usedForDeployment: false,
      });
    }
  }

  // ── Final Holdout evaluation ─────────────────────────────────
  let finalHoldoutMetrics: FinalHoldoutMetrics | undefined;
  if (finalHoldoutConfig && deploymentParams) {
    ledger.calls++; ledger.log.push({ phase: 'final-holdout', fold: -1, start: finalHoldoutConfig.start, end: finalHoldoutConfig.end });
    const fhSim = simulator(finalHoldoutConfig.start, finalHoldoutConfig.end, deploymentParams);
    finalHoldoutMetrics = { config: finalHoldoutConfig, metrics: makeMetrics(fhSim, costCfg), evaluationCount: 1 };
  } else if (finalHoldoutConfig) {
    finalHoldoutMetrics = { config: finalHoldoutConfig, metrics: undefined, evaluationCount: 0 };
  }

  // ── Stress scenarios ─────────────────────────────────────────
  const bm = foldMetrics[0];
  const stressScenarios: StressScenario[] = bm ? [
    { name: 'baseline', multiplier: 1.0, metrics: bm.trainMetrics },
    { name: '1.5x', multiplier: 1.5, metrics: recomputeCosts(bm.trainMetrics, 1.5, costCfg) },
    { name: '2x', multiplier: 2.0, metrics: recomputeCosts(bm.trainMetrics, 2.0, costCfg) },
  ] : [];

  // ── Report identity ──────────────────────────────────────────
  const reportId = makeReportId(cfg, costCfg, {
    datasetHash: opts.datasetHash ?? '',
    selected: deploymentParams ?? {},
    simVersion: opts.simVersion ?? '',
    contractVersion,
    holdoutConfig: finalHoldoutConfig,
    deploymentParams: deploymentParams ?? {},
  });

  return deepFreeze({
    reportId,
    createdAt: clock.nowISO(),
    contractVersion,
    config: cfg,
    costConfig: costCfg,
    selectionMode: mode,
    folds: foldMetrics,
    selectedFold: selectedFoldIndex,
    selectedParameters: deploymentParams, // deprecated alias
    deploymentParameters: deploymentParams,
    deploymentCandidateId,
    warnings,
    limitations: ['paper-only simulation', 'no forward-looking claims'],
    stressScenarios,
    simulatorVersion: opts.simVersion,
    finalHoldout: finalHoldoutMetrics,
  });
}
