import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWalkForward, type SimResult } from '../../src/validation/WalkForward';
import type { CostConfig, ValidationReport, WalkForwardConfig } from '../../src/validation/ValidationTypes';
import {
  evaluateStrategyPromotion,
  PROMOTION_REASONS,
  type StrategyPromotionPolicy,
} from '../../src/validation/StrategyPromotionGate';

const CONFIG: WalkForwardConfig = {
  mode: 'rolling',
  totalBars: 5_000,
  trainBars: 500,
  validationBars: 100,
  testBars: 100,
  purgeBars: 5,
  embargoBars: 5,
  featureLookbackBars: 20,
  labelHorizonBars: 5,
};

const COST: CostConfig = {
  feeBps: 1,
  spreadBps: 1,
  slippageBps: 1,
  latencyPenaltyBps: 0,
  stressMultiplier: 1,
};

const POLICY: StrategyPromotionPolicy = {
  minDevelopmentFolds: 1,
  maxWarnings: 10,
  maxLimitations: 10,
  minFinalHoldoutTrades: 10,
  minFinalHoldoutNetReturn: -1_000_000,
  minFinalHoldoutSharpe: 1,
  maxFinalHoldoutDrawdown: 0.2,
};

function simulator(): SimResult {
  return {
    grossPnl: 1_000,
    volume: 10_000,
    turnover: 2,
    maxDrawdown: 0.1,
    sharpe: 1.5,
    sortino: 2,
    profitFactor: 1.4,
    trades: 20,
  };
}

function makeReport(): ValidationReport {
  return runWalkForward(CONFIG, COST, simulator, {
    paramGrid: [{ lookback: 20 }, { lookback: 40 }],
    clock: { nowISO: () => '2026-07-26T00:00:00.000Z', nowMs: () => 1 },
  });
}

function reasonCodes(report: ValidationReport, policy: StrategyPromotionPolicy = POLICY): readonly string[] {
  return evaluateStrategyPromotion(report, policy).reasons.map(reason => reason.code);
}

test('1. valid R8 report passes the explicit promotion policy', () => {
  const decision = evaluateStrategyPromotion(makeReport(), POLICY);
  assert.equal(decision.status, 'promote');
  assert.deepStrictEqual(decision.reasons, []);
  assert.ok(decision.deploymentCandidateId);
  assert.ok(decision.deploymentParameters);
});

test('2. malformed promotion policy throws fail-closed', () => {
  assert.throws(
    () => evaluateStrategyPromotion(makeReport(), { ...POLICY, minDevelopmentFolds: -1 }),
    /INVALID_PROMOTION_POLICY:minDevelopmentFolds/,
  );
  assert.throws(
    () => evaluateStrategyPromotion(makeReport(), { ...POLICY, maxFinalHoldoutDrawdown: Number.NaN }),
    /INVALID_PROMOTION_POLICY:maxFinalHoldoutDrawdown/,
  );
});

test('3. validation contract mismatch rejects', () => {
  const report = { ...makeReport(), contractVersion: 'stale-contract' };
  assert.ok(reasonCodes(report).includes(PROMOTION_REASONS.VALIDATION_CONTRACT_MISMATCH));
});

test('3b. missing report identity rejects', () => {
  const report: ValidationReport = { ...makeReport(), reportId: '' };
  assert.deepStrictEqual(reasonCodes(report), [PROMOTION_REASONS.REPORT_ID_MISSING]);
});

test('3c. explicit minimum development-fold count is enforced', () => {
  const report = makeReport();
  const codes = reasonCodes(report, { ...POLICY, minDevelopmentFolds: report.folds.length + 1 });
  assert.deepStrictEqual(codes, [PROMOTION_REASONS.INSUFFICIENT_DEVELOPMENT_FOLDS]);
});

test('3d. exactly one deployment fold is required', () => {
  const source = makeReport();
  const report: ValidationReport = {
    ...source,
    folds: source.folds.map(fold => ({ ...fold, selected: false, usedForDeployment: false })),
  };
  assert.deepStrictEqual(reasonCodes(report), [PROMOTION_REASONS.DEPLOYMENT_FOLD_COUNT_INVALID]);
});

test('4. missing deployment fields reject', () => {
  const report: ValidationReport = {
    ...makeReport(),
    deploymentParameters: undefined,
    deploymentCandidateId: undefined,
  };
  const codes = reasonCodes(report);
  assert.ok(codes.includes(PROMOTION_REASONS.DEPLOYMENT_PARAMETERS_MISSING));
  assert.ok(codes.includes(PROMOTION_REASONS.DEPLOYMENT_CANDIDATE_MISSING));
});

test('5. deployment fold provenance mismatch rejects', () => {
  const source = makeReport();
  const report: ValidationReport = { ...source, selectedFold: -999 };
  assert.ok(reasonCodes(report).includes(PROMOTION_REASONS.DEPLOYMENT_PROVENANCE_INVALID));
});

test('6. selectedParameters alias mismatch rejects', () => {
  const report: ValidationReport = { ...makeReport(), selectedParameters: { different: 1 } };
  assert.ok(reasonCodes(report).includes(PROMOTION_REASONS.SELECTED_PARAMETERS_ALIAS_MISMATCH));
});

test('7. selected fold without test metrics rejects', () => {
  const source = makeReport();
  const report: ValidationReport = {
    ...source,
    folds: source.folds.map((fold, index) => index === 0
      ? { ...fold, testMetrics: undefined }
      : fold),
  };
  assert.ok(reasonCodes(report).includes(PROMOTION_REASONS.FOLD_TEST_METRICS_MISSING));
});

test('8. malformed final holdout range rejects', () => {
  const source = makeReport();
  const report: ValidationReport = {
    ...source,
    finalHoldoutRange: source.finalHoldoutRange
      ? { ...source.finalHoldoutRange, count: source.finalHoldoutRange.count + 1 }
      : undefined,
  };
  assert.ok(reasonCodes(report).includes(PROMOTION_REASONS.FINAL_HOLDOUT_RANGE_INVALID));
});

test('9. final holdout must be evaluated exactly once', () => {
  const report: ValidationReport = { ...makeReport(), finalHoldoutEvaluationCount: 0 };
  assert.ok(reasonCodes(report).includes(PROMOTION_REASONS.FINAL_HOLDOUT_EXACT_ONCE_REQUIRED));
});

test('10. missing and non-finite final holdout metrics reject', () => {
  const missing: ValidationReport = { ...makeReport(), finalHoldoutMetrics: undefined };
  assert.ok(reasonCodes(missing).includes(PROMOTION_REASONS.FINAL_HOLDOUT_METRICS_MISSING));

  const source = makeReport();
  assert.ok(source.finalHoldoutMetrics);
  const nonFinite: ValidationReport = {
    ...source,
    finalHoldoutMetrics: { ...source.finalHoldoutMetrics, netReturn: Number.NaN },
  };
  assert.ok(reasonCodes(nonFinite).includes(PROMOTION_REASONS.NON_FINITE_FINAL_HOLDOUT_METRICS));
});

test('11. every explicit performance threshold is enforced', () => {
  const report = makeReport();
  const policy: StrategyPromotionPolicy = {
    ...POLICY,
    minFinalHoldoutTrades: 21,
    minFinalHoldoutNetReturn: 1_000_000,
    minFinalHoldoutSharpe: 2,
    maxFinalHoldoutDrawdown: 0.05,
  };
  const codes = reasonCodes(report, policy);
  assert.ok(codes.includes(PROMOTION_REASONS.FINAL_HOLDOUT_TRADES_BELOW_MINIMUM));
  assert.ok(codes.includes(PROMOTION_REASONS.FINAL_HOLDOUT_NET_RETURN_BELOW_MINIMUM));
  assert.ok(codes.includes(PROMOTION_REASONS.FINAL_HOLDOUT_SHARPE_BELOW_MINIMUM));
  assert.ok(codes.includes(PROMOTION_REASONS.FINAL_HOLDOUT_DRAWDOWN_ABOVE_MAXIMUM));
});

test('12. warning and limitation budgets are explicit gates', () => {
  const report: ValidationReport = {
    ...makeReport(),
    warnings: ['COST_SENSITIVITY'],
    limitations: ['known limitation'],
  };
  const codes = reasonCodes(report, { ...POLICY, maxWarnings: 0, maxLimitations: 0 });
  assert.deepStrictEqual(codes, [PROMOTION_REASONS.TOO_MANY_WARNINGS, PROMOTION_REASONS.TOO_MANY_LIMITATIONS]);
});

test('13. decision identity is deterministic and policy-sensitive', () => {
  const report = makeReport();
  const a = evaluateStrategyPromotion(report, POLICY);
  const b = evaluateStrategyPromotion(report, POLICY);
  const c = evaluateStrategyPromotion(report, { ...POLICY, maxWarnings: POLICY.maxWarnings + 1 });
  const reorderedPolicy: StrategyPromotionPolicy = {
    maxFinalHoldoutDrawdown: POLICY.maxFinalHoldoutDrawdown,
    minFinalHoldoutSharpe: POLICY.minFinalHoldoutSharpe,
    minFinalHoldoutNetReturn: POLICY.minFinalHoldoutNetReturn,
    minFinalHoldoutTrades: POLICY.minFinalHoldoutTrades,
    maxLimitations: POLICY.maxLimitations,
    maxWarnings: POLICY.maxWarnings,
    minDevelopmentFolds: POLICY.minDevelopmentFolds,
  };
  const d = evaluateStrategyPromotion(report, reorderedPolicy);
  assert.equal(a.decisionId, b.decisionId);
  assert.equal(a.decisionId, d.decisionId);
  assert.notEqual(a.decisionId, c.decisionId);
});

test('14. decision and stored parameters are frozen without freezing caller parameters', () => {
  const source = makeReport();
  const callerParams: Record<string, string | number> = { lookback: 20 };
  const deploymentFoldIndex = source.folds.findIndex(fold => fold.usedForDeployment);
  assert.ok(deploymentFoldIndex >= 0);
  const report: ValidationReport = {
    ...source,
    deploymentParameters: callerParams,
    selectedParameters: { ...callerParams },
    folds: source.folds.map((fold, index) => index === deploymentFoldIndex
      ? { ...fold, selectedParameters: { ...callerParams } }
      : fold),
  };
  const decision = evaluateStrategyPromotion(report, POLICY);
  assert.equal(decision.status, 'promote');
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.reasons), true);
  assert.equal(Object.isFrozen(decision.deploymentParameters), true);
  assert.equal(Object.isFrozen(callerParams), false);
});
