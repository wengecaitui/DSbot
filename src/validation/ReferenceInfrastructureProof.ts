// Stage 4A8: deterministic, non-production proof of the validation/provenance infrastructure.

import { createHash } from 'node:crypto';
import { createPromotionDecisionArtifact, verifyPromotionDecisionArtifact, type PromotionDecisionArtifact } from './PromotionDecisionArtifactStore';
import type { StrategyPromotionPolicy } from './StrategyPromotionGate';
import type { CostConfig, ValidationClock, WalkForwardConfig } from './ValidationTypes';
import { deepFreeze } from './ValidationTypes';
import { runWalkForward, type SimCallLedger, type SimResult } from './WalkForward';

export const REFERENCE_PROOF_CONTRACT_VERSION = '4A8-R1' as const;
export const REFERENCE_PROOF_CLASSIFICATION = [
  'REFERENCE INFRASTRUCTURE PROOF ONLY',
  'NOT A REAL STRATEGY BACKTEST',
  'NOT APPROVED FOR PAPER, TESTNET OR LIVE',
] as const;
export const REFERENCE_SIMULATOR_ID = 'cloddsbot-deterministic-reference-simulator' as const;
export const REFERENCE_SIMULATOR_VERSION = '1.0.0' as const;

export interface ReferenceDatasetDescriptor {
  readonly generator: 'cloddsbot-reference-lcg-v1';
  readonly seed: number;
  readonly bars: number;
  readonly startTime: string;
  readonly intervalMs: number;
  readonly initialClose: number;
}

export interface ReferenceBar {
  readonly index: number;
  readonly timestamp: string;
  readonly close: number;
}

export interface ReferenceProofConfiguration {
  readonly walkForward: WalkForwardConfig;
  readonly cost: CostConfig;
  readonly parameterGrid: readonly Readonly<Record<string, string | number>>[];
  readonly promotionPolicy: StrategyPromotionPolicy;
  readonly clockISO: string;
}

export interface ReferenceInfrastructureProof {
  readonly proofContractVersion: typeof REFERENCE_PROOF_CONTRACT_VERSION;
  readonly classification: typeof REFERENCE_PROOF_CLASSIFICATION;
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly workflow: string;
  };
  readonly dataset: {
    readonly descriptor: ReferenceDatasetDescriptor;
    readonly sha256: string;
  };
  readonly configuration: {
    readonly value: ReferenceProofConfiguration;
    readonly sha256: string;
  };
  readonly simulator: {
    readonly id: typeof REFERENCE_SIMULATOR_ID;
    readonly version: typeof REFERENCE_SIMULATOR_VERSION;
    readonly sourceSha256: string;
  };
  readonly ledger: SimCallLedger;
  readonly promotionArtifact: PromotionDecisionArtifact;
  readonly proofId: string;
}

export interface ReferenceProofBuildInput {
  readonly repository: string;
  readonly sourceCommit: string;
  readonly workflow: string;
  readonly simulatorSourceSha256: string;
}

export interface ReferenceProofVerificationOptions {
  readonly expectedRepository?: string;
  readonly expectedSourceCommit?: string;
  readonly expectedWorkflow?: string;
  readonly expectedSimulatorSourceSha256?: string;
}

const DATASET: ReferenceDatasetDescriptor = {
  generator: 'cloddsbot-reference-lcg-v1',
  seed: 0x4a8,
  bars: 5_000,
  startTime: '2020-01-01T00:00:00.000Z',
  intervalMs: 60 * 60 * 1000,
  initialClose: 100,
};

const CONFIGURATION: ReferenceProofConfiguration = {
  walkForward: {
    mode: 'rolling', totalBars: DATASET.bars, trainBars: 500, validationBars: 100,
    testBars: 100, purgeBars: 5, embargoBars: 5, featureLookbackBars: 20,
    labelHorizonBars: 5, finalHoldoutRatio: 0.15, selectionMode: 'causal-per-fold',
  },
  cost: {
    feeBps: 1, spreadBps: 1, slippageBps: 1, latencyPenaltyBps: 0,
    stressMultiplier: 1,
  },
  parameterGrid: [
    { lookbackBars: 8, directionThresholdBps: 1 },
    { lookbackBars: 16, directionThresholdBps: 2 },
    { lookbackBars: 24, directionThresholdBps: 3 },
  ],
  promotionPolicy: {
    minDevelopmentFolds: 1,
    maxWarnings: 20,
    maxLimitations: 10,
    minFinalHoldoutTrades: 5,
    minFinalHoldoutNetReturn: -1_000_000,
    minFinalHoldoutSharpe: -100,
    maxFinalHoldoutDrawdown: 1,
  },
  clockISO: '2020-01-01T00:00:00.000Z',
};

function invalid(reason: string): never {
  throw new Error(`REFERENCE_PROOF_INVALID:${reason}`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return invalid('UNSUPPORTED_VALUE');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertSha256(name: string, value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(name);
}

function assertIdentity(input: ReferenceProofBuildInput): void {
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) invalid('SOURCE_COMMIT');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) invalid('REPOSITORY');
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(input.workflow)) invalid('WORKFLOW');
  assertSha256('SIMULATOR_SOURCE_SHA256', input.simulatorSourceSha256);
}

/** Generate the complete immutable synthetic dataset from its public descriptor. */
export function generateReferenceDataset(descriptor: ReferenceDatasetDescriptor = DATASET): readonly ReferenceBar[] {
  if (descriptor.generator !== 'cloddsbot-reference-lcg-v1' || !Number.isInteger(descriptor.seed) ||
      !Number.isInteger(descriptor.bars) || descriptor.bars < 1_000 || !Number.isInteger(descriptor.intervalMs) ||
      descriptor.intervalMs < 1 || !Number.isFinite(descriptor.initialClose) || descriptor.initialClose <= 0) {
    invalid('DATASET_DESCRIPTOR');
  }
  const start = Date.parse(descriptor.startTime);
  if (!Number.isFinite(start) || new Date(start).toISOString() !== descriptor.startTime) invalid('DATASET_START_TIME');
  let state = descriptor.seed >>> 0;
  let close = descriptor.initialClose;
  const bars: ReferenceBar[] = [];
  for (let index = 0; index < descriptor.bars; index++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const noise = (state / 0x100000000 - 0.5) * 0.8;
    const cycle = Math.sin(index / 17) * 0.18;
    const drift = index % 240 < 120 ? 0.035 : -0.02;
    close = Math.max(1, close * (1 + (noise + cycle + drift) / 100));
    bars.push({
      index,
      timestamp: new Date(start + index * descriptor.intervalMs).toISOString(),
      close: Number(close.toFixed(8)),
    });
  }
  return deepFreeze(bars);
}

/**
 * Deterministic non-production simulator. It intentionally emits non-zero reference trades.
 * It exists only to exercise causal folds, holdout, costs, gate, artifact and provenance wiring.
 */
export function createReferenceSimulator(dataset: readonly ReferenceBar[]) {
  return (start: number, end: number, params: Record<string, string | number> = {}): SimResult => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= dataset.length || end < start) {
      return invalid('SIMULATION_RANGE');
    }
    const lookback = Number(params.lookbackBars ?? 8);
    const thresholdBps = Number(params.directionThresholdBps ?? 1);
    if (!Number.isInteger(lookback) || lookback < 1 || !Number.isFinite(thresholdBps) || thresholdBps < 0) {
      return invalid('SIMULATION_PARAMETERS');
    }
    const returns: number[] = [];
    for (let index = Math.max(start + lookback, start + 1); index < end; index += 4) {
      const current = dataset[index].close;
      const prior = dataset[index - lookback].close;
      const next = dataset[index + 1].close;
      const momentumBps = ((current - prior) / prior) * 10_000;
      const direction = momentumBps >= thresholdBps ? 1 : -1;
      returns.push(direction * ((next - current) / current));
    }
    if (returns.length < 5) invalid('INSUFFICIENT_REFERENCE_TRADES');
    const grossPnl = returns.reduce((sum, value) => sum + value, 0) / returns.length * 10_000 + 100;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
    const deviation = Math.sqrt(variance);
    const downside = returns.filter(value => value < 0);
    const downsideDeviation = Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, downside.length));
    const wins = returns.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
    const losses = Math.abs(returns.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    for (const value of returns) {
      equity *= 1 + value;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
    return {
      grossPnl,
      volume: 1_000,
      turnover: returns.length,
      maxDrawdown,
      sharpe: deviation > 0 ? mean / deviation * Math.sqrt(252) : 0,
      sortino: downsideDeviation > 0 ? mean / downsideDeviation * Math.sqrt(252) : 0,
      profitFactor: losses > 0 ? wins / losses : 0,
      trades: returns.length,
    };
  };
}

function proofPayload(proof: Omit<ReferenceInfrastructureProof, 'proofId'>): object {
  return proof;
}

function runChain(dataset: readonly ReferenceBar[], configuration: ReferenceProofConfiguration, datasetHash: string) {
  const ledger: SimCallLedger = { calls: 0, log: [] };
  const clock: ValidationClock = { nowISO: () => configuration.clockISO, nowMs: () => Date.parse(configuration.clockISO) };
  const report = runWalkForward(
    configuration.walkForward,
    configuration.cost,
    createReferenceSimulator(dataset),
    {
      paramGrid: configuration.parameterGrid.map(params => ({ ...params })),
      datasetHash,
      simVersion: REFERENCE_SIMULATOR_VERSION,
      clock,
      ledger,
    },
  );
  const promotionArtifact = createPromotionDecisionArtifact(report, configuration.promotionPolicy);
  return { ledger, promotionArtifact };
}

/** Build the exact JSON subject later signed by GitHub's OIDC-backed attestation action. */
export function createReferenceInfrastructureProof(input: ReferenceProofBuildInput): ReferenceInfrastructureProof {
  assertIdentity(input);
  const descriptor = clone(DATASET);
  const dataset = generateReferenceDataset(descriptor);
  const datasetHash = sha256(dataset);
  const configuration = clone(CONFIGURATION);
  const configurationHash = sha256(configuration);
  const { ledger, promotionArtifact } = runChain(dataset, configuration, datasetHash);
  if (promotionArtifact.decision.status !== 'promote') invalid('REFERENCE_GATE_REJECTED');
  if (promotionArtifact.report.finalHoldoutMetrics?.tradeCount === 0) invalid('ZERO_REFERENCE_TRADES');
  const payload: Omit<ReferenceInfrastructureProof, 'proofId'> = {
    proofContractVersion: REFERENCE_PROOF_CONTRACT_VERSION,
    classification: REFERENCE_PROOF_CLASSIFICATION,
    source: { repository: input.repository, commit: input.sourceCommit, workflow: input.workflow },
    dataset: { descriptor, sha256: datasetHash },
    configuration: { value: configuration, sha256: configurationHash },
    simulator: { id: REFERENCE_SIMULATOR_ID, version: REFERENCE_SIMULATOR_VERSION, sourceSha256: input.simulatorSourceSha256 },
    ledger,
    promotionArtifact,
  };
  return deepFreeze({ ...payload, proofId: sha256(proofPayload(payload)) });
}

/** Rebuild every Stage 4A4-A6 value and reject any altered binding or output. */
export function verifyReferenceInfrastructureProof(
  value: unknown,
  options: ReferenceProofVerificationOptions = {},
): ReferenceInfrastructureProof {
  if (!value || typeof value !== 'object') invalid('NOT_OBJECT');
  const proof = clone(value) as ReferenceInfrastructureProof;
  if (proof.proofContractVersion !== REFERENCE_PROOF_CONTRACT_VERSION) invalid('CONTRACT_VERSION');
  if (canonicalJson(proof.classification) !== canonicalJson(REFERENCE_PROOF_CLASSIFICATION)) invalid('CLASSIFICATION');
  assertIdentity({
    repository: proof.source?.repository,
    sourceCommit: proof.source?.commit,
    workflow: proof.source?.workflow,
    simulatorSourceSha256: proof.simulator?.sourceSha256,
  });
  if (options.expectedRepository && proof.source.repository !== options.expectedRepository) invalid('REPOSITORY_BINDING');
  if (options.expectedSourceCommit && proof.source.commit !== options.expectedSourceCommit) invalid('SOURCE_COMMIT_BINDING');
  if (options.expectedWorkflow && proof.source.workflow !== options.expectedWorkflow) invalid('WORKFLOW_BINDING');
  if (options.expectedSimulatorSourceSha256 && proof.simulator.sourceSha256 !== options.expectedSimulatorSourceSha256) {
    invalid('SIMULATOR_SOURCE_BINDING');
  }
  if (proof.simulator.id !== REFERENCE_SIMULATOR_ID || proof.simulator.version !== REFERENCE_SIMULATOR_VERSION) {
    invalid('SIMULATOR_IDENTITY');
  }
  const dataset = generateReferenceDataset(proof.dataset.descriptor);
  if (sha256(dataset) !== proof.dataset.sha256) invalid('DATASET_DIGEST');
  if (sha256(proof.configuration.value) !== proof.configuration.sha256) invalid('CONFIGURATION_DIGEST');
  let verifiedArtifact: PromotionDecisionArtifact;
  try {
    verifiedArtifact = verifyPromotionDecisionArtifact(proof.promotionArtifact);
  } catch {
    return invalid('PROMOTION_ARTIFACT');
  }
  const rerun = runChain(dataset, proof.configuration.value, proof.dataset.sha256);
  if (canonicalJson(rerun.ledger) !== canonicalJson(proof.ledger)) invalid('LEDGER_RECOMPUTATION');
  if (canonicalJson(rerun.promotionArtifact) !== canonicalJson(verifiedArtifact)) invalid('CHAIN_RECOMPUTATION');
  const { proofId: suppliedProofId, ...payload } = proof;
  assertSha256('PROOF_ID', suppliedProofId);
  if (sha256(proofPayload(payload)) !== suppliedProofId) invalid('PROOF_DIGEST');
  return deepFreeze(proof);
}
