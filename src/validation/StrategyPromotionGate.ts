// Stage 4A5: fail-closed, side-effect-free strategy promotion decision.

import { createHash } from 'node:crypto';
import type { PerformanceMetrics, StrategyParameters, ValidationReport } from './ValidationTypes';
import { canonicalParamsSnapshot, deepFreeze } from './ValidationTypes';

export const PROMOTION_CONTRACT_VERSION = '4A5-R1' as const;
export const REQUIRED_VALIDATION_CONTRACT_VERSION = '4A4-R8' as const;

export const PROMOTION_REASONS = {
  VALIDATION_CONTRACT_MISMATCH: 'VALIDATION_CONTRACT_MISMATCH',
  SELECTION_MODE_MISMATCH: 'SELECTION_MODE_MISMATCH',
  REPORT_ID_MISSING: 'REPORT_ID_MISSING',
  INSUFFICIENT_DEVELOPMENT_FOLDS: 'INSUFFICIENT_DEVELOPMENT_FOLDS',
  DEPLOYMENT_FOLD_COUNT_INVALID: 'DEPLOYMENT_FOLD_COUNT_INVALID',
  DEPLOYMENT_PROVENANCE_INVALID: 'DEPLOYMENT_PROVENANCE_INVALID',
  DEPLOYMENT_PARAMETERS_MISSING: 'DEPLOYMENT_PARAMETERS_MISSING',
  DEPLOYMENT_CANDIDATE_MISSING: 'DEPLOYMENT_CANDIDATE_MISSING',
  SELECTED_PARAMETERS_ALIAS_MISMATCH: 'SELECTED_PARAMETERS_ALIAS_MISMATCH',
  FOLD_TEST_METRICS_MISSING: 'FOLD_TEST_METRICS_MISSING',
  FINAL_HOLDOUT_RANGE_INVALID: 'FINAL_HOLDOUT_RANGE_INVALID',
  FINAL_HOLDOUT_EXACT_ONCE_REQUIRED: 'FINAL_HOLDOUT_EXACT_ONCE_REQUIRED',
  FINAL_HOLDOUT_METRICS_MISSING: 'FINAL_HOLDOUT_METRICS_MISSING',
  NON_FINITE_FINAL_HOLDOUT_METRICS: 'NON_FINITE_FINAL_HOLDOUT_METRICS',
  TOO_MANY_WARNINGS: 'TOO_MANY_WARNINGS',
  TOO_MANY_LIMITATIONS: 'TOO_MANY_LIMITATIONS',
  FINAL_HOLDOUT_TRADES_BELOW_MINIMUM: 'FINAL_HOLDOUT_TRADES_BELOW_MINIMUM',
  FINAL_HOLDOUT_NET_RETURN_BELOW_MINIMUM: 'FINAL_HOLDOUT_NET_RETURN_BELOW_MINIMUM',
  FINAL_HOLDOUT_SHARPE_BELOW_MINIMUM: 'FINAL_HOLDOUT_SHARPE_BELOW_MINIMUM',
  FINAL_HOLDOUT_DRAWDOWN_ABOVE_MAXIMUM: 'FINAL_HOLDOUT_DRAWDOWN_ABOVE_MAXIMUM',
} as const;

export type PromotionReasonCode = typeof PROMOTION_REASONS[keyof typeof PROMOTION_REASONS];

export interface StrategyPromotionPolicy {
  readonly minDevelopmentFolds: number;
  readonly maxWarnings: number;
  readonly maxLimitations: number;
  readonly minFinalHoldoutTrades: number;
  readonly minFinalHoldoutNetReturn: number;
  readonly minFinalHoldoutSharpe: number;
  readonly maxFinalHoldoutDrawdown: number;
}

export interface PromotionReason {
  readonly code: PromotionReasonCode;
  readonly detail: string;
}

export interface StrategyPromotionDecision {
  readonly promotionContractVersion: typeof PROMOTION_CONTRACT_VERSION;
  readonly decisionId: string;
  readonly reportId: string;
  readonly status: 'promote' | 'reject';
  readonly reasons: readonly PromotionReason[];
  readonly deploymentCandidateId?: string;
  readonly deploymentParameters?: StrategyParameters;
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`INVALID_PROMOTION_POLICY:${name}`);
}

function validatePolicy(policy: StrategyPromotionPolicy): void {
  requireNonNegativeInteger('minDevelopmentFolds', policy.minDevelopmentFolds);
  requireNonNegativeInteger('maxWarnings', policy.maxWarnings);
  requireNonNegativeInteger('maxLimitations', policy.maxLimitations);
  requireNonNegativeInteger('minFinalHoldoutTrades', policy.minFinalHoldoutTrades);
  for (const [name, value] of [
    ['minFinalHoldoutNetReturn', policy.minFinalHoldoutNetReturn],
    ['minFinalHoldoutSharpe', policy.minFinalHoldoutSharpe],
    ['maxFinalHoldoutDrawdown', policy.maxFinalHoldoutDrawdown],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`INVALID_PROMOTION_POLICY:${name}`);
  }
  if (policy.maxFinalHoldoutDrawdown < 0) {
    throw new Error('INVALID_PROMOTION_POLICY:maxFinalHoldoutDrawdown');
  }
}

function canonicalParameters(params: StrategyParameters | undefined): string {
  if (!params) return '';
  return JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
}

function sameParameters(a: StrategyParameters | undefined, b: StrategyParameters | undefined): boolean {
  return canonicalParameters(a) === canonicalParameters(b);
}

function metricsAreFinite(metrics: PerformanceMetrics): boolean {
  return [
    metrics.grossReturn, metrics.netReturn, metrics.maxDrawdown, metrics.sharpeRatio,
    metrics.sortinoRatio, metrics.profitFactor, metrics.tradeCount, metrics.turnover,
    metrics.costBreakdown.grossReturn, metrics.costBreakdown.fees,
    metrics.costBreakdown.spreadCost, metrics.costBreakdown.slippageCost,
    metrics.costBreakdown.latencyCost, metrics.costBreakdown.netReturn,
  ].every(Number.isFinite);
}

function makeDecisionId(reportId: string, policy: StrategyPromotionPolicy, reasons: readonly PromotionReason[]): string {
  const normalizedPolicy = {
    minDevelopmentFolds: policy.minDevelopmentFolds,
    maxWarnings: policy.maxWarnings,
    maxLimitations: policy.maxLimitations,
    minFinalHoldoutTrades: policy.minFinalHoldoutTrades,
    minFinalHoldoutNetReturn: policy.minFinalHoldoutNetReturn,
    minFinalHoldoutSharpe: policy.minFinalHoldoutSharpe,
    maxFinalHoldoutDrawdown: policy.maxFinalHoldoutDrawdown,
  };
  const payload = JSON.stringify({
    promotionContractVersion: PROMOTION_CONTRACT_VERSION,
    reportId,
    policy: normalizedPolicy,
    reasons,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Evaluate whether a validated strategy is eligible for promotion.
 *
 * This function has no execution, persistence, network, or configuration side effects.
 * Malformed policy is a caller error and throws. Report or performance failures return
 * an immutable rejection with ordered reason codes.
 */
export function evaluateStrategyPromotion(
  report: ValidationReport,
  policy: StrategyPromotionPolicy,
): StrategyPromotionDecision {
  validatePolicy(policy);
  const reasons: PromotionReason[] = [];
  const reject = (code: PromotionReasonCode, detail: string): void => { reasons.push({ code, detail }); };

  if (report.contractVersion !== REQUIRED_VALIDATION_CONTRACT_VERSION ||
      report.validationContractVersion !== REQUIRED_VALIDATION_CONTRACT_VERSION) {
    reject(PROMOTION_REASONS.VALIDATION_CONTRACT_MISMATCH,
      `required=${REQUIRED_VALIDATION_CONTRACT_VERSION}`);
  }
  if (report.selectionMode !== 'causal-per-fold') {
    reject(PROMOTION_REASONS.SELECTION_MODE_MISMATCH, 'required=causal-per-fold');
  }
  if (typeof report.reportId !== 'string' || report.reportId.length === 0) {
    reject(PROMOTION_REASONS.REPORT_ID_MISSING, 'reportId must be non-empty');
  }
  if (report.folds.length < policy.minDevelopmentFolds) {
    reject(PROMOTION_REASONS.INSUFFICIENT_DEVELOPMENT_FOLDS,
      `actual=${report.folds.length},required=${policy.minDevelopmentFolds}`);
  }

  const deploymentFolds = report.folds.filter(fold => fold.usedForDeployment);
  if (deploymentFolds.length !== 1) {
    reject(PROMOTION_REASONS.DEPLOYMENT_FOLD_COUNT_INVALID, `actual=${deploymentFolds.length},required=1`);
  }
  const deploymentFold = deploymentFolds[0];
  if (!report.deploymentParameters) {
    reject(PROMOTION_REASONS.DEPLOYMENT_PARAMETERS_MISSING, 'deploymentParameters missing');
  }
  if (!report.deploymentCandidateId) {
    reject(PROMOTION_REASONS.DEPLOYMENT_CANDIDATE_MISSING, 'deploymentCandidateId missing');
  }
  if (!sameParameters(report.selectedParameters, report.deploymentParameters)) {
    reject(PROMOTION_REASONS.SELECTED_PARAMETERS_ALIAS_MISMATCH,
      'selectedParameters must equal deploymentParameters');
  }
  if (deploymentFold && (
    deploymentFold.fold !== report.selectedFold ||
    deploymentFold.selected !== true ||
    deploymentFold.selectedCandidateId !== report.deploymentCandidateId ||
    !sameParameters(deploymentFold.selectedParameters, report.deploymentParameters)
  )) {
    reject(PROMOTION_REASONS.DEPLOYMENT_PROVENANCE_INVALID,
      'deployment fold, candidate, and parameters must match report deployment fields');
  }
  if (report.folds.some(fold => fold.selectedParameters && !fold.testMetrics)) {
    reject(PROMOTION_REASONS.FOLD_TEST_METRICS_MISSING,
      'every fold with selected parameters must contain testMetrics');
  }

  const range = report.finalHoldoutRange;
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
      !Number.isInteger(range.count) || range.start < 0 || range.end < range.start ||
      range.count !== range.end - range.start + 1 || range.end >= report.config.totalBars) {
    reject(PROMOTION_REASONS.FINAL_HOLDOUT_RANGE_INVALID, 'finalHoldoutRange is not a valid inclusive range');
  }
  if (report.finalHoldoutEvaluationCount !== 1) {
    reject(PROMOTION_REASONS.FINAL_HOLDOUT_EXACT_ONCE_REQUIRED,
      `actual=${report.finalHoldoutEvaluationCount},required=1`);
  }

  const metrics = report.finalHoldoutMetrics;
  if (!metrics) {
    reject(PROMOTION_REASONS.FINAL_HOLDOUT_METRICS_MISSING, 'finalHoldoutMetrics missing');
  } else if (!metricsAreFinite(metrics)) {
    reject(PROMOTION_REASONS.NON_FINITE_FINAL_HOLDOUT_METRICS, 'all holdout metrics must be finite');
  } else {
    if (metrics.tradeCount < policy.minFinalHoldoutTrades) {
      reject(PROMOTION_REASONS.FINAL_HOLDOUT_TRADES_BELOW_MINIMUM,
        `actual=${metrics.tradeCount},required=${policy.minFinalHoldoutTrades}`);
    }
    if (metrics.netReturn < policy.minFinalHoldoutNetReturn) {
      reject(PROMOTION_REASONS.FINAL_HOLDOUT_NET_RETURN_BELOW_MINIMUM,
        `actual=${metrics.netReturn},required=${policy.minFinalHoldoutNetReturn}`);
    }
    if (metrics.sharpeRatio < policy.minFinalHoldoutSharpe) {
      reject(PROMOTION_REASONS.FINAL_HOLDOUT_SHARPE_BELOW_MINIMUM,
        `actual=${metrics.sharpeRatio},required=${policy.minFinalHoldoutSharpe}`);
    }
    if (metrics.maxDrawdown > policy.maxFinalHoldoutDrawdown) {
      reject(PROMOTION_REASONS.FINAL_HOLDOUT_DRAWDOWN_ABOVE_MAXIMUM,
        `actual=${metrics.maxDrawdown},required<=${policy.maxFinalHoldoutDrawdown}`);
    }
  }

  if (report.warnings.length > policy.maxWarnings) {
    reject(PROMOTION_REASONS.TOO_MANY_WARNINGS,
      `actual=${report.warnings.length},allowed=${policy.maxWarnings}`);
  }
  if (report.limitations.length > policy.maxLimitations) {
    reject(PROMOTION_REASONS.TOO_MANY_LIMITATIONS,
      `actual=${report.limitations.length},allowed=${policy.maxLimitations}`);
  }

  const decisionId = makeDecisionId(report.reportId, policy, reasons);
  const decision: StrategyPromotionDecision = {
    promotionContractVersion: PROMOTION_CONTRACT_VERSION,
    decisionId,
    reportId: report.reportId,
    status: reasons.length === 0 ? 'promote' : 'reject',
    reasons,
    deploymentCandidateId: report.deploymentCandidateId,
    deploymentParameters: report.deploymentParameters
      ? canonicalParamsSnapshot({ ...report.deploymentParameters })
      : undefined,
  };
  return deepFreeze(decision);
}
