// Stage 4A4: Walk-forward validation types — chronological splits, warnings, immutable reports.
import { createHash } from 'node:crypto';

// ── Warnings ──────────────────────────────────────────────────
export const VALIDATION_WARNINGS = {
  VALIDATION_DEGRADATION:    'VALIDATION_DEGRADATION',
  TEST_DEGRADATION:          'TEST_DEGRADATION',
  INSUFFICIENT_SAMPLE:       'INSUFFICIENT_SAMPLE',
  PARAMETER_INSTABILITY:     'PARAMETER_INSTABILITY',
  EXCESSIVE_TURNOVER:        'EXCESSIVE_TURNOVER',
  SELECTION_BIAS_RISK:       'SELECTION_BIAS_RISK',
  COST_SENSITIVITY:          'COST_SENSITIVITY',
  LEAKAGE_DETECTED:          'LEAKAGE_DETECTED',
} as const;
export type ValidationWarning = typeof VALIDATION_WARNINGS[keyof typeof VALIDATION_WARNINGS];

// ── Chronological split ───────────────────────────────────────
export interface ChronologicalSplit {
  readonly fold: number;
  readonly train: { start: number; end: number; count: number };
  readonly validation: { start: number; end: number; count: number };
  readonly test: { start: number; end: number; count: number };
  readonly purgeBars: number;
  readonly embargoBars: number;
}

export interface WalkForwardConfig {
  /** Total bars available (chronological, oldest → newest). */
  readonly totalBars: number;
  readonly trainBars: number;
  readonly validationBars: number;
  readonly testBars: number;
  readonly purgeBars: number;
  readonly embargoBars: number;
  readonly mode: 'rolling' | 'expanding';
  /** Minimum bars required for any fold (train+val+test+purge+embargo). */
  readonly minFoldBars?: number;
}

// ── Cost model ────────────────────────────────────────────────
export interface CostConfig {
  readonly feeBps: number;
  readonly spreadBps: number;
  readonly slippageBps: number;
  readonly latencyPenaltyBps: number;
  readonly stressMultiplier: number; // ≥1.0
}

export interface CostBreakdown {
  readonly grossReturn: number;
  readonly fees: number;
  readonly spreadCost: number;
  readonly slippageCost: number;
  readonly latencyCost: number;
  readonly netReturn: number;
}

// ── Metrics ───────────────────────────────────────────────────
export interface FoldMetrics {
  fold: number;
  trainMetrics: PerformanceMetrics;
  validationMetrics: PerformanceMetrics;
  testMetrics?: PerformanceMetrics;
  selected: boolean;
  rejectionReason?: string;
}

export interface PerformanceMetrics {
  readonly grossReturn: number;
  readonly netReturn: number;
  readonly maxDrawdown: number;
  readonly sharpeRatio: number;
  readonly sortinoRatio: number;
  readonly profitFactor: number;
  readonly tradeCount: number;
  readonly turnover: number;
  readonly costBreakdown: CostBreakdown;
}

// ── Report ────────────────────────────────────────────────────
export interface ValidationReport {
  readonly reportId: string;
  readonly createdAt: string;
  readonly config: WalkForwardConfig;
  readonly costConfig: CostConfig;
  readonly folds: readonly FoldMetrics[];
  readonly selectedFold?: number;
  readonly selectedParameters?: Readonly<Record<string, string | number>>;
  readonly baselineMetrics?: PerformanceMetrics;
  readonly stressScenarios?: readonly { name: string; multiplier: number; metrics: PerformanceMetrics }[];
  readonly warnings: readonly ValidationWarning[];
  readonly limitations: readonly string[];
}

export function makeReportId(cfg: WalkForwardConfig): string {
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);
}

// ── Parameter selection ───────────────────────────────────────
export interface ParameterCandidate {
  id: string;
  params: Readonly<Record<string, string | number>>;
  trainScore: number;
  validationScore: number;
  metrics: FoldMetrics;
  accepted: boolean;
  rejectionReason?: string;
  selected: boolean;
}

export interface ParameterSelectionResult {
  readonly candidates: readonly ParameterCandidate[];
  readonly selectedId?: string;
  readonly selectedParams?: Readonly<Record<string, string | number>>;
}
