// Stage 4A4-R8: Causal-per-fold selection, FinalHoldout, deployment contract, deep freeze, deterministic clock.
import { createHash } from 'node:crypto';

// ── Warnings ──────────────────────────────────────────────────
export const VALIDATION_WARNINGS = {
  VALIDATION_DEGRADATION: 'VALIDATION_DEGRADATION', TEST_DEGRADATION: 'TEST_DEGRADATION',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE', PARAMETER_INSTABILITY: 'PARAMETER_INSTABILITY',
  EXCESSIVE_TURNOVER: 'EXCESSIVE_TURNOVER', SELECTION_BIAS_RISK: 'SELECTION_BIAS_RISK',
  COST_SENSITIVITY: 'COST_SENSITIVITY', LEAKAGE_DETECTED: 'LEAKAGE_DETECTED',
  HOLDOUT_INSUFFICIENT_BARS: 'HOLDOUT_INSUFFICIENT_BARS', HOLDOUT_ALLOCATION_SHRUNK: 'HOLDOUT_ALLOCATION_SHRUNK',
} as const;
export type ValidationWarning = typeof VALIDATION_WARNINGS[keyof typeof VALIDATION_WARNINGS];

// ── Selection mode ────────────────────────────────────────────
export type SelectionMode = 'global' | 'causal-per-fold';

// ── Chronological split ───────────────────────────────────────
export interface ChronologicalSplit {
  readonly fold: number;
  readonly train: Segment; readonly validation: Segment; readonly test: Segment;
  readonly purgeBars: number; readonly embargoBars: number;
  readonly featureLookbackBars: number; readonly labelHorizonBars: number;
}
export interface Segment { readonly start: number; readonly end: number; readonly count: number; }

export interface WalkForwardConfig {
  readonly totalBars: number; readonly trainBars: number; readonly validationBars: number;
  readonly testBars: number; readonly purgeBars: number; readonly embargoBars: number;
  readonly mode: 'rolling' | 'expanding';
  readonly selectionMode?: SelectionMode;
  readonly featureLookbackBars?: number; readonly labelHorizonBars?: number;
  readonly minFoldBars?: number;
  readonly finalHoldoutRatio?: number; readonly finalHoldoutMinBars?: number;
}

// ── Final Holdout ─────────────────────────────────────────────
export interface FinalHoldoutConfig {
  readonly start: number; readonly end: number; readonly count: number;
  readonly ratio: number; readonly minBars: number;
  readonly gapBars: number; // max(purge, embargo, labelHorizon)
  readonly developmentEndExclusive: number; // bar index where development folds stop
}

// ── Clock ─────────────────────────────────────────────────────
export interface ValidationClock { nowISO(): string; nowMs(): number; }
export const systemValidationClock: ValidationClock = { nowISO: () => new Date().toISOString(), nowMs: () => Date.now() };

// ── Cost model ────────────────────────────────────────────────
export interface CostConfig { readonly feeBps: number; readonly spreadBps: number; readonly slippageBps: number; readonly latencyPenaltyBps: number; readonly stressMultiplier: number; }
export interface CostBreakdown { readonly grossReturn: number; readonly fees: number; readonly spreadCost: number; readonly slippageCost: number; readonly latencyCost: number; readonly netReturn: number; }

// ── Metrics ───────────────────────────────────────────────────
export interface CandidateResult {
  readonly candidateId: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly validationScore: number;
  readonly trainScore: number;
  readonly accepted: boolean;
  readonly rejectionReason?: string;
}

export interface FoldMetrics {
  fold: number;
  trainMetrics: PerformanceMetrics;
  validationMetrics: PerformanceMetrics;
  testMetrics?: PerformanceMetrics;
  /** @deprecated Use usedForDeployment instead. True when this fold supplied deployment parameters. */
  selected: boolean;
  /** Parameters selected by this fold (causal-per-fold mode). */
  selectedParameters?: Readonly<Record<string, string | number>>;
  /** Candidate ID selected by this fold. */
  selectedCandidateId?: string;
  /** All candidates evaluated by this fold (causal-per-fold mode). */
  candidateResults?: readonly CandidateResult[];
  /** True when this fold's selected parameters are used as deployment parameters. */
  usedForDeployment: boolean;
  rejectionReason?: string;
}

export interface PerformanceMetrics {
  readonly grossReturn: number; readonly netReturn: number; readonly maxDrawdown: number;
  readonly sharpeRatio: number; readonly sortinoRatio: number; readonly profitFactor: number;
  readonly tradeCount: number; readonly turnover: number; readonly costBreakdown: CostBreakdown;
  readonly _volume?: number; // internal: original volume for recomputation
}

// ── Report ────────────────────────────────────────────────────
export interface ValidationReport {
  readonly reportId: string; readonly createdAt: string;
  readonly contractVersion: string;
  readonly config: WalkForwardConfig; readonly costConfig: CostConfig;
  readonly selectionMode: SelectionMode;
  readonly folds: readonly FoldMetrics[]; readonly selectedFold?: number;
  /** @deprecated Use deploymentParameters instead. Deep-equals deploymentParameters. */
  readonly selectedParameters?: Readonly<Record<string, string | number>>;
  readonly deploymentParameters?: Readonly<Record<string, string | number>>;
  readonly deploymentCandidateId?: string;
  readonly warnings: readonly ValidationWarning[];
  readonly limitations: readonly string[];
  readonly stressScenarios?: readonly StressScenario[];
  readonly simulatorVersion?: string;
  readonly finalHoldout?: FinalHoldoutMetrics;
}

export interface FinalHoldoutMetrics {
  readonly config: FinalHoldoutConfig;
  readonly metrics?: PerformanceMetrics;
  readonly evaluationCount: number; // 0 if no paramGrid, 1 otherwise
}

export interface StressScenario { readonly name: string; readonly multiplier: number; readonly metrics: PerformanceMetrics; }

export function makeReportId(
  cfg: WalkForwardConfig, cost: CostConfig,
  opts: {
    datasetHash?: string; selected?: Record<string, string | number>;
    simVersion?: string; contractVersion?: string;
    holdoutConfig?: FinalHoldoutConfig;
    deploymentParams?: Record<string, string | number>;
  } = {},
): string {
  const hc = opts.holdoutConfig ? { start: opts.holdoutConfig.start, end: opts.holdoutConfig.end, count: opts.holdoutConfig.count } : {};
  return createHash('sha256').update(JSON.stringify({
    cfg, cost, datasetHash: opts.datasetHash ?? '', selected: opts.selected ?? {},
    simVersion: opts.simVersion ?? '', contractVersion: opts.contractVersion ?? '4A4-R8',
    holdout: hc, deployment: opts.deploymentParams ?? {},
  })).digest('hex').slice(0, 16);
}

// ── Parameter selection ───────────────────────────────────────
export interface ParameterCandidate {
  readonly id: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly validationScore: number;
  readonly trainScore: number;
  readonly foldScores: readonly number[];
  readonly metrics: FoldMetrics;
  readonly minTrainTrades: number;
  readonly minValidationTrades: number;
  accepted: boolean;
  rejectionReason?: string;
  selected: boolean;
}
export interface ParameterSelectionResult {
  readonly candidates: readonly ParameterCandidate[];
  readonly selectedId?: string; readonly selectedParams?: Readonly<Record<string, string | number>>;
}

// ── Deep freeze ───────────────────────────────────────────────
export function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj); Object.values(obj).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  }
  return obj;
}
