// Stage 4A4-R1: Validation types with feature lookback, label horizon, deep freeze, deterministic clock.
import { createHash } from 'node:crypto';

// ── Warnings ──────────────────────────────────────────────────
export const VALIDATION_WARNINGS = {
  VALIDATION_DEGRADATION: 'VALIDATION_DEGRADATION', TEST_DEGRADATION: 'TEST_DEGRADATION',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE', PARAMETER_INSTABILITY: 'PARAMETER_INSTABILITY',
  EXCESSIVE_TURNOVER: 'EXCESSIVE_TURNOVER', SELECTION_BIAS_RISK: 'SELECTION_BIAS_RISK',
  COST_SENSITIVITY: 'COST_SENSITIVITY', LEAKAGE_DETECTED: 'LEAKAGE_DETECTED',
} as const;
export type ValidationWarning = typeof VALIDATION_WARNINGS[keyof typeof VALIDATION_WARNINGS];

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
  readonly featureLookbackBars?: number; readonly labelHorizonBars?: number;
  readonly minFoldBars?: number;
}

// ── Clock ─────────────────────────────────────────────────────
export interface ValidationClock { nowISO(): string; nowMs(): number; }
export const systemValidationClock: ValidationClock = { nowISO: () => new Date().toISOString(), nowMs: () => Date.now() };

// ── Cost model ────────────────────────────────────────────────
export interface CostConfig { readonly feeBps: number; readonly spreadBps: number; readonly slippageBps: number; readonly latencyPenaltyBps: number; readonly stressMultiplier: number; }
export interface CostBreakdown { readonly grossReturn: number; readonly fees: number; readonly spreadCost: number; readonly slippageCost: number; readonly latencyCost: number; readonly netReturn: number; }

// ── Metrics ───────────────────────────────────────────────────
export interface FoldMetrics { fold: number; trainMetrics: PerformanceMetrics; validationMetrics: PerformanceMetrics; testMetrics?: PerformanceMetrics; selected: boolean; rejectionReason?: string; }
export interface PerformanceMetrics {
  readonly grossReturn: number; readonly netReturn: number; readonly maxDrawdown: number;
  readonly sharpeRatio: number; readonly sortinoRatio: number; readonly profitFactor: number;
  readonly tradeCount: number; readonly turnover: number; readonly costBreakdown: CostBreakdown;
  readonly _volume?: number; // internal: original volume for recomputation
}

// ── Report ────────────────────────────────────────────────────
export interface ValidationReport {
  readonly reportId: string; readonly createdAt: string;
  readonly config: WalkForwardConfig; readonly costConfig: CostConfig;
  readonly folds: readonly FoldMetrics[]; readonly selectedFold?: number;
  readonly selectedParameters?: Readonly<Record<string, string | number>>;
  readonly warnings: readonly ValidationWarning[];
  readonly limitations: readonly string[];
  readonly stressScenarios?: readonly StressScenario[];
  readonly simulatorVersion?: string;
}
export interface StressScenario { readonly name: string; readonly multiplier: number; readonly metrics: PerformanceMetrics; }

export function makeReportId(cfg: WalkForwardConfig, cost: CostConfig, datasetHash?: string, selected?: Record<string, string | number>, simVersion?: string): string {
  return createHash('sha256').update(JSON.stringify({ cfg, cost, datasetHash: datasetHash ?? '', selected: selected ?? {}, simVersion: simVersion ?? '' })).digest('hex').slice(0, 16);
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
