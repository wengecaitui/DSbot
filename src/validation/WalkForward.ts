// Stage 4A4-R8: Walk-forward — causal-per-fold selection (R8 only), mandatory FinalHoldout, deployment contract, phase ledger.

import type {
  WalkForwardConfig, CostConfig, CostBreakdown, PerformanceMetrics, FoldMetrics,
  ParameterCandidate, ValidationReport, ValidationWarning, StressScenario,
  ValidationClock, CandidateResult, StrategyParameters,
} from './ValidationTypes';
import { makeReportId, deepFreeze, systemValidationClock, canonicalParamsSnapshot, paramsMutableCopy } from './ValidationTypes';
import { generateSplits, assertFoldIsolation } from './ChronologicalSplit';
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

/**
 * Select best candidate from a list — accepts/rejects each, then ranks only accepted
 * candidates by validationScore (descending), tie-breaking on params JSON.
 *
 * This is the ONLY deterministic selection method used in R8. There is no manual
 * bestCandidate tracking that could strand on a rejected high-score candidate.
 */
export function selectParameters(candidates: ParameterCandidate[], minTrades: number = 5): ParameterSelectionResult {
  const out: ParameterCandidate[] = [];
  for (const c of candidates) {
    let accept = true; let reason = '';
    if (c.minTrainTrades < minTrades) { accept = false; reason = 'MIN_TRADES_TRAIN'; }
    if (c.minValidationTrades < minTrades) { accept = false; reason = 'MIN_TRADES_VALIDATION'; }
    if (c.validationScore < c.trainScore * 0.5) { if (!reason) reason = 'VALIDATION_DEGRADATION'; accept = false; }
    out.push({ ...c, accepted: accept, rejectionReason: reason || undefined, selected: false });
  }
  // Only accepted candidates compete for selection
  const pass = out.filter(c => c.accepted).sort((a, b) => b.validationScore - a.validationScore || JSON.stringify(a.params).localeCompare(JSON.stringify(b.params)));
  if (pass.length > 0) pass[0].selected = true;
  return { candidates: out, selectedId: pass[0]?.id, selectedParams: pass[0]?.params };
}

// Re-export for external consumers
export type ParameterSelectionResult = { candidates: ParameterCandidate[]; selectedId?: string; selectedParams?: Record<string, string | number> };

// ── Per-fold candidate evaluation (causal-per-fold mode) ────────
function evaluateFoldCandidates(
  foldIdx: number, splits: { train: { start: number; end: number }; validation: { start: number; end: number } },
  params: StrategyParameters,
  simulator: (start: number, end: number, params?: Record<string, string | number>) => SimResult,
  costCfg: CostConfig, minTrades: number, ledger: SimCallLedger,
): { candidate: ParameterCandidate; trainMetrics: PerformanceMetrics; valMetrics: PerformanceMetrics } | null {
  // params is the canonical snapshot — no simulator ever receives this reference.
  const cid = JSON.stringify(params);
  ledger.calls++; ledger.log.push({ phase: 'train', fold: foldIdx, candidateId: cid, start: splits.train.start, end: splits.train.end });
  const tr = simulator(splits.train.start, splits.train.end, paramsMutableCopy(params));
  const trainM = makeMetrics(tr, costCfg);
  ledger.calls++; ledger.log.push({ phase: 'validation', fold: foldIdx, candidateId: cid, start: splits.validation.start, end: splits.validation.end });
  const vr = simulator(splits.validation.start, splits.validation.end, paramsMutableCopy(params));
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
  const contractVersion = '4A4-R8';

  // ── Final Holdout allocation (always-on, normalized defaults) ──
  const finalHoldoutConfig = allocateFinalHoldout(cfg);

  // ── Selection mode — only 'causal-per-fold' (R8), fail-closed on invalid ──
  if (cfg.selectionMode !== undefined && cfg.selectionMode !== 'causal-per-fold') {
    throw new Error(`INVALID_SELECTION_MODE: only 'causal-per-fold' is supported, got '${cfg.selectionMode}'`);
  }
  const selectionMode: 'causal-per-fold' = 'causal-per-fold';

  // ── Fold generation (constrained by holdout) ──────────────────
  const devBars = finalHoldoutConfig.developmentEndExclusive;
  const devCfg = { ...cfg, totalBars: devBars };
  const splits = generateSplits(devCfg);
  if (splits.length === 0) {
    throw new Error('HOLDOUT_INSUFFICIENT_DEVELOPMENT');
  }

  const warnings: ValidationWarning[] = [];

  // ── Validate fold isolation — structural violations throw ─────
  assertFoldIsolation(splits);

  const foldMetrics: FoldMetrics[] = [];

  // Accumulate per-fold selections. Only the last valid selection fold
  // becomes the deployment fold. usedForDeployment is set after the loop.
  interface FoldSelection {
    foldIdx: number;
    params: StrategyParameters;
    candidateId: string;
    trainMetrics: PerformanceMetrics;
    valMetrics: PerformanceMetrics;
  }
  const validSelections: FoldSelection[] = [];

  // ── Causal-per-fold (R8 only mode) ────────────────────────────
  if (opts.paramGrid && opts.paramGrid.length > 0) {
    // Snapshot every paramGrid entry before any fold evaluation.
    // No caller object is modified or frozen.
    const canonicalGrid: StrategyParameters[] = opts.paramGrid.map(p => canonicalParamsSnapshot(p));

    for (const s of splits) {
      const results: CandidateResult[] = [];
      const allCandidates: ParameterCandidate[] = [];

      for (const canonP of canonicalGrid) {
        const ev = evaluateFoldCandidates(s.fold, s, canonP, simulator, costCfg, 5, ledger);
        if (!ev) continue;
        const { candidate, trainMetrics, valMetrics } = ev;
        results.push({ candidateId: candidate.id, params: candidate.params, validationScore: candidate.validationScore, trainScore: candidate.trainScore, accepted: candidate.accepted, rejectionReason: candidate.rejectionReason });
        allCandidates.push(candidate);
      }

      // Use selectParameters for accepted-only deterministic ranking
      const sel = selectParameters(allCandidates);
      const foldParams = sel.selectedParams;
      const foldCandidateId = sel.selectedId;

      // Run test with fold's own selection (only if accepted)
      let testM: PerformanceMetrics | undefined;
      if (foldParams) {
        ledger.calls++; ledger.log.push({ phase: 'test', fold: s.fold, start: s.test.start, end: s.test.end });
        const ts = simulator(s.test.start, s.test.end, paramsMutableCopy(foldParams));
        testM = makeMetrics(ts, costCfg);
      }

      // Record this fold's selection for deployment resolution.
      // Invariant: the selected candidate was already evaluated through the ledger —
      // its metrics MUST be available. Fallback simulator calls are forbidden.
      if (foldParams && foldCandidateId) {
        const found = allCandidates.find(c => c.id === foldCandidateId);
        if (!found) throw new Error(`CANDIDATE_NOT_FOUND: fold=${s.fold} id=${foldCandidateId}`);
        if (!found.metrics?.trainMetrics || !found.metrics?.validationMetrics) {
          throw new Error(`CANDIDATE_METRICS_MISSING: fold=${s.fold} id=${foldCandidateId}`);
        }
        validSelections.push({
          foldIdx: s.fold, params: foldParams, candidateId: foldCandidateId,
          trainMetrics: found.metrics.trainMetrics,
          valMetrics: found.metrics.validationMetrics,
        });
      }

      // Use already-evaluated candidate's recorded metrics for audit display.
      // If no candidate was accepted, fall back to the first evaluated candidate
      // (which was already recorded in the ledger). Never call simulator again.
      const selectedCandidate = allCandidates.find(c => c.id === foldCandidateId);
      const auditCandidate = selectedCandidate ?? allCandidates[0];
      const bestTrainMetrics = auditCandidate?.metrics?.trainMetrics;
      const bestValMetrics = auditCandidate?.metrics?.validationMetrics;

      const foldM: FoldMetrics = {
        fold: s.fold,
        trainMetrics: bestTrainMetrics ?? (() => { throw new Error(`FOLD_METRICS_MISSING: fold=${s.fold}`); })(),
        validationMetrics: bestValMetrics ?? (() => { throw new Error(`FOLD_METRICS_MISSING: fold=${s.fold}`); })(),
        testMetrics: testM,
        selected: false,
        selectedParameters: foldParams,
        selectedCandidateId: foldCandidateId,
        candidateResults: results,
        // usedForDeployment set AFTER the loop — only the final valid selection gets true
        usedForDeployment: false,
      };

      if (bestTrainMetrics && bestTrainMetrics.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
      if (bestValMetrics && bestTrainMetrics && bestValMetrics.netReturn < bestTrainMetrics.netReturn * 0.7) warnings.push('VALIDATION_DEGRADATION');
      if (results.some(r => !r.accepted)) warnings.push('PARAMETER_INSTABILITY');

      foldMetrics.push(foldM);
    }
  } else {
    // No paramGrid: evaluate with no selection
    for (const s of splits) {
      ledger.calls++; ledger.log.push({ phase: 'train', fold: s.fold, start: s.train.start, end: s.train.end });
      const tr = simulator(s.train.start, s.train.end);
      const trainM = makeMetrics(tr, costCfg);
      ledger.calls++; ledger.log.push({ phase: 'validation', fold: s.fold, start: s.validation.start, end: s.validation.end });
      const vr = simulator(s.validation.start, s.validation.end);
      const valM = makeMetrics(vr, costCfg);
      if (trainM.tradeCount < 5) warnings.push('INSUFFICIENT_SAMPLE');
      if (valM.netReturn < trainM.netReturn * 0.7) warnings.push('VALIDATION_DEGRADATION');
      foldMetrics.push({
        fold: s.fold, trainMetrics: trainM, validationMetrics: valM, testMetrics: undefined,
        selected: false, usedForDeployment: false,
      });
    }
  }

  // ── Deployment resolution: only the FINAL valid selection fold ──
  let deploymentParams: StrategyParameters | undefined;
  let deploymentCandidateId: string | undefined;
  let selectedFoldIndex: number | undefined;

  if (validSelections.length > 0) {
    const lastSel = validSelections[validSelections.length - 1];
    deploymentParams = lastSel.params;
    deploymentCandidateId = lastSel.candidateId;
    selectedFoldIndex = lastSel.foldIdx;
  }

  // ── Rebuild foldMetrics immutably: only the deployment fold gets
  // selected=true and usedForDeployment=true. All earlier folds retain
  // selectedParameters/id/results but have both flags set to false.
  const finalFoldMetrics = foldMetrics.map(fm =>
    fm.fold === selectedFoldIndex
      ? { ...fm, selected: true, usedForDeployment: true }
      : fm,
  );

  // Assertions: exactly one fold usedForDeployment
  const deployFoldCount = finalFoldMetrics.filter(f => f.usedForDeployment).length;
  if (validSelections.length > 0 && deployFoldCount !== 1) {
    throw new Error(`DEPLOYMENT_COUNT_MISMATCH: expected exactly 1 usedForDeployment, got ${deployFoldCount}`);
  }
  if (validSelections.length > 0 && selectedFoldIndex !== validSelections[validSelections.length - 1].foldIdx) {
    throw new Error('DEPLOYMENT_FOLD_NOT_LAST: deployment must be the final valid selection fold');
  }

  // ── Final Holdout evaluation (exactly one attempt, no retry) ──
  let finalHoldoutMetrics: PerformanceMetrics | undefined;

  if (deploymentParams) {
    ledger.calls++; ledger.log.push({ phase: 'final-holdout', fold: -1, start: finalHoldoutConfig.start, end: finalHoldoutConfig.end });
    const fhSim = simulator(finalHoldoutConfig.start, finalHoldoutConfig.end, paramsMutableCopy(deploymentParams));
    finalHoldoutMetrics = makeMetrics(fhSim, costCfg);
  }

  const finalHoldoutEvaluationCount = deploymentParams ? 1 : 0;

  // ── Stress scenarios ─────────────────────────────────────────
  const bm = finalFoldMetrics[0];
  const stressScenarios: StressScenario[] = bm ? [
    { name: 'baseline', multiplier: 1.0, metrics: bm.trainMetrics },
    { name: '1.5x', multiplier: 1.5, metrics: recomputeCosts(bm.trainMetrics, 1.5, costCfg) },
    { name: '2x', multiplier: 2.0, metrics: recomputeCosts(bm.trainMetrics, 2.0, costCfg) },
  ] : [];

  // ── Report identity (normalized defaults) ────────────────────
  const effectiveHoldout = {
    start: finalHoldoutConfig.start,
    end: finalHoldoutConfig.end,
    count: finalHoldoutConfig.count,
  };
  const reportId = makeReportId(cfg, costCfg, effectiveHoldout, {
    datasetHash: opts.datasetHash ?? '',
    selected: deploymentParams ?? {},
    simVersion: opts.simVersion ?? '',
    contractVersion,
    deploymentParams: deploymentParams ?? {},
  });

  return deepFreeze({
    reportId,
    createdAt: clock.nowISO(),
    validationContractVersion: contractVersion,
    contractVersion,
    selectionMode,
    config: cfg,
    costConfig: costCfg,
    folds: finalFoldMetrics,
    selectedFold: selectedFoldIndex,
    selectedParameters: deploymentParams,
    deploymentParameters: deploymentParams,
    deploymentCandidateId,
    warnings,
    limitations: ['paper-only simulation', 'no forward-looking claims'],
    stressScenarios,
    simulatorVersion: opts.simVersion,
    finalHoldoutRange: {
      start: finalHoldoutConfig.start,
      end: finalHoldoutConfig.end,
      count: finalHoldoutConfig.count,
    },
    finalHoldoutMetrics,
    finalHoldoutEvaluationCount,
  });
}
