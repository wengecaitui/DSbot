/**
 * Phase 7C V1 — read-only Trading & Research Workbench contract.
 *
 * This module is deliberately a projection boundary, not a web server and not
 * an execution service. It accepts snapshots produced by existing authorities,
 * applies presentation-only stable ordering, and returns a defensive immutable
 * copy. It never derives trading permission or recalculates economic values.
 */

import type { RuntimeAccountingSnapshot } from '../accounting/runtime-accounting-types';
import type { TradeLifecycle } from '../accounting/trade-lifecycle-types';
import type { MarketSnapshot } from '../data/MarketSnapshot';
import type { CoordinatorSnapshot } from '../hermes/types';
import type { OmsOrderSnapshot } from '../oms/oms-types';
import type { PositionPlan } from '../position/position-plan-types';
import type { ReconciliationReport } from '../reconciliation/reconciliation-types';
import type { RecoveryResult } from '../recovery/RecoveryManager';
import type { ObservableAgentEvent } from './contracts';
import type { ProjectControlCenterSnapshot } from './project-control-center';
import type { PositionResolution } from '../types/position-state';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export const WORKBENCH_V1_ROUTES = deepFreeze([
  { id: 'overview', path: '/overview', tabs: [] },
  { id: 'market', path: '/market', tabs: ['state', 'regime'] },
  { id: 'trading', path: '/trading', tabs: ['positions', 'orders', 'accounting'] },
  { id: 'research', path: '/research', tabs: ['signals', 'strategies', 'backtest', 'regime'] },
  { id: 'policy', path: '/policy', tabs: ['policy', 'interpretation'] },
  { id: 'safety', path: '/safety', tabs: ['risk', 'recovery', 'reconciliation'] },
  { id: 'operations', path: '/operations', tabs: ['hermes', 'events', 'control-center'] },
  { id: 'data', path: '/data', tabs: ['data-hub'] },
  { id: 'settings', path: '/settings', tabs: [] },
] as const);

export const WORKBENCH_V1_READ_RESOURCES = deepFreeze([
  { resource: 'overview', snapshot: 'WorkbenchOverviewSnapshot', update: 'request-response' },
  { resource: 'runtime', snapshot: 'RuntimeOverviewSnapshot', update: 'periodic-refresh' },
  { resource: 'market', snapshot: 'MarketOverviewSnapshot', update: 'periodic-refresh' },
  { resource: 'trading', snapshot: 'TradingOverviewSnapshot', update: 'request-response' },
  { resource: 'account', snapshot: 'AccountOverviewSnapshot', update: 'request-response' },
  { resource: 'safety', snapshot: 'SafetyOverviewSnapshot', update: 'periodic-refresh' },
  { resource: 'research', snapshot: 'ResearchOverviewSnapshot', update: 'request-response' },
  { resource: 'operations', snapshot: 'OperationsOverviewSnapshot', update: 'event-stream' },
  { resource: 'research-job', snapshot: 'ReadOnlyResearchJobStatus', update: 'long-running-job-status' },
] as const);

export const WORKBENCH_V1_BOUNDARIES = deepFreeze({
  readOnly: true,
  allowedHttpMethods: ['GET'],
  tradingControlCapabilities: [],
  dashboardIsTruthSource: false,
  dashboardGrantsApproval: false,
  tradingEnvironmentActivated: false,
  liveReadyIsMutable: false,
  controlCenterDomain: 'operations',
  controlCenterIncludedInTradingOverview: false,
  researchAuthoritativeForExecution: false,
  externalResearchDataAuthoritativeForExecution: false,
} as const);

export const WORKBENCH_V1_AUTHORITY_MAP = deepFreeze([
  { fact: 'market', authority: 'KernelMarketStateStore' },
  { fact: 'positions', authority: 'KernelPositionStateStore' },
  { fact: 'orders', authority: 'OmsOrderStore' },
  { fact: 'protective-plans', authority: 'PositionPlanStore' },
  { fact: 'accounting', authority: 'RuntimeAccounting' },
  { fact: 'trade-lifecycle', authority: 'TradeLifecycle' },
  { fact: 'recovery', authority: 'RecoveryManager' },
  { fact: 'reconciliation', authority: 'ReconciliationReport' },
  { fact: 'live-ready', authority: 'ProductionSpine safety gate' },
  { fact: 'hermes', authority: 'HandshakeCoordinator' },
] as const);

export type SnapshotAvailability = 'AVAILABLE' | 'INCOMPLETE' | 'UNAVAILABLE' | 'UNKNOWN';
export type SnapshotFreshness = 'FRESH' | 'STALE' | 'UNKNOWN';

export interface SnapshotProvenance {
  /** Backend capture time. null means the source did not establish one. */
  readonly capturedAt: number | null;
  readonly source: string;
  readonly sourceSequence: number | null;
  readonly sourceVersion: number | null;
  readonly lastUpdatedAt: number | null;
}

export type ReadOnlySnapshot<T> =
  | {
      readonly availability: 'AVAILABLE' | 'INCOMPLETE';
      readonly freshness: SnapshotFreshness;
      readonly provenance: SnapshotProvenance;
      readonly data: T;
      readonly reason?: string;
    }
  | {
      readonly availability: 'UNAVAILABLE' | 'UNKNOWN';
      readonly freshness: 'UNKNOWN';
      readonly provenance: SnapshotProvenance;
      readonly data: null;
      readonly reason: string;
    };

export type RuntimeHealth = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
export type TradingEnvironment = 'replay' | 'shadow' | 'paper' | 'testnet' | 'live' | 'unknown';

export interface RuntimeOverviewSnapshot {
  readonly health: RuntimeHealth;
  readonly environment: TradingEnvironment;
  readonly mode: string | null;
  readonly hermes: CoordinatorSnapshot | null;
}

export interface MarketRegimeEvidence {
  readonly label: string;
  readonly evidenceId: string;
  readonly producedBy: 'deterministic';
  readonly authoritativeForExecution: false;
}

export interface MarketOverviewSnapshot {
  readonly instruments: readonly MarketSnapshot[];
  readonly regime: MarketRegimeEvidence | null;
}

export interface PositionOverviewRecord {
  readonly exchange: string;
  readonly symbol: string;
  /** Preserves missing != flat. */
  readonly resolution: PositionResolution;
}

export interface TradingOverviewSnapshot {
  readonly positions: readonly PositionOverviewRecord[];
  /** Preserves the canonical OMS status, including SUBMISSION_UNKNOWN. */
  readonly orders: readonly OmsOrderSnapshot[];
  readonly protectivePlans: readonly PositionPlan[];
}

export interface AccountOverviewSnapshot {
  /** Passed through from the canonical RuntimeAccounting projection. */
  readonly accounting: RuntimeAccountingSnapshot | null;
  /** Passed through from the canonical TradeLifecycle projection. */
  readonly tradeLifecycle: TradeLifecycle | null;
}

export interface LiveReadinessDisplay {
  readonly status: 'READY' | 'NOT_READY' | 'UNKNOWN';
  readonly authority: 'ProductionSpine safety gate';
  readonly mutableFromWorkbench: false;
  readonly blockers: readonly string[];
}

export interface KillSwitchDisplay {
  readonly status: 'TRIGGERED' | 'CLEAR' | 'UNKNOWN';
  readonly authority: string;
  readonly reason: string | null;
  readonly mutableFromWorkbench: false;
}

export interface SafetyOverviewSnapshot {
  readonly recovery: RecoveryResult | null;
  readonly reconciliation: ReconciliationReport | null;
  readonly liveReady: LiveReadinessDisplay;
  readonly killSwitch: KillSwitchDisplay;
  readonly riskBlockers: readonly string[];
}

export type ResearchEvidenceKind =
  | 'signal'
  | 'strategy'
  | 'factor'
  | 'market-regime'
  | 'ai-interpretation';

export interface ResearchEvidenceSummary {
  readonly evidenceId: string;
  readonly kind: ResearchEvidenceKind;
  readonly producedBy: 'deterministic' | 'ai';
  readonly sourceEvidenceIds: readonly string[];
  readonly authoritativeForExecution: false;
}

export interface ResearchProviderStatus {
  readonly providerId: string;
  readonly status: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly datasets: readonly string[];
  readonly normalized: boolean;
  readonly authoritativeForExecution: false;
}

export type ResearchJobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export interface ReadOnlyResearchJobStatus {
  readonly jobId: string;
  readonly state: ResearchJobState;
  readonly progress: number | null;
  readonly updatedAt: number | null;
  readonly canCancelFromWorkbenchV1: false;
}

export interface ResearchOverviewSnapshot {
  readonly providers: readonly ResearchProviderStatus[];
  readonly evidence: readonly ResearchEvidenceSummary[];
  readonly jobs: readonly ReadOnlyResearchJobStatus[];
  readonly backtestWorkspace: {
    readonly modes: readonly ['factor', 'strategy', 'optimizer', 'walk-forward'];
    readonly antiOverfitSplit: readonly ['TRAIN', 'VALIDATION', 'LOCKED_TEST'];
    readonly optimizationMayReadValidation: false;
    readonly optimizationMayReadLockedTest: false;
  };
}

export interface ActivityOverviewSnapshot {
  readonly events: readonly ObservableAgentEvent[];
}

/** Operations is intentionally separate from the trading homepage. */
export interface OperationsOverviewSnapshot {
  readonly hermes: CoordinatorSnapshot | null;
  readonly recentEvents: readonly ObservableAgentEvent[];
  readonly projectControlCenter: ProjectControlCenterSnapshot | null;
  readonly controlCenterDomain: 'operations';
}

/** Small shell-level evidence set that remains visible across business routes. */
export interface PersistentTerminalStatusSnapshot {
  readonly environment: TradingEnvironment;
  readonly marketFreshness: SnapshotFreshness;
  readonly recovery: RecoveryResult['mode'] | 'unknown';
  readonly reconciliation: ReconciliationReport['outcome'] | 'UNKNOWN';
  readonly liveReady: LiveReadinessDisplay['status'];
  readonly killSwitch: KillSwitchDisplay['status'];
  readonly hermes: CoordinatorSnapshot['health'] | 'unknown';
}

export interface WorkbenchOverviewInput {
  /** Explicit backend capture time; the projector never reads a clock. */
  readonly capturedAt: number;
  readonly runtime: ReadOnlySnapshot<RuntimeOverviewSnapshot>;
  readonly market: ReadOnlySnapshot<MarketOverviewSnapshot>;
  readonly trading: ReadOnlySnapshot<TradingOverviewSnapshot>;
  readonly account: ReadOnlySnapshot<AccountOverviewSnapshot>;
  readonly safety: ReadOnlySnapshot<SafetyOverviewSnapshot>;
  readonly research: ReadOnlySnapshot<ResearchOverviewSnapshot>;
  readonly activity: ReadOnlySnapshot<ActivityOverviewSnapshot>;
}

export interface WorkbenchOverviewSnapshot extends WorkbenchOverviewInput {
  readonly schemaVersion: '1.0';
  readonly kind: 'dsbot.workbench.overview';
  readonly capabilities: {
    readonly canRead: true;
    readonly canTrade: false;
    readonly canMutateRuntime: false;
    readonly canGrantApproval: false;
    readonly canSetLiveReady: false;
  };
}

function assertTimestamp(value: number | null, field: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${field} must be null or a finite non-negative number`);
  }
}

function validateEnvelope<T>(name: string, envelope: ReadOnlySnapshot<T>): void {
  if (!envelope.provenance.source.trim()) throw new Error(`${name}.provenance.source is required`);
  assertTimestamp(envelope.provenance.capturedAt, `${name}.provenance.capturedAt`);
  assertTimestamp(envelope.provenance.lastUpdatedAt, `${name}.provenance.lastUpdatedAt`);
  assertTimestamp(envelope.provenance.sourceSequence, `${name}.provenance.sourceSequence`);
  assertTimestamp(envelope.provenance.sourceVersion, `${name}.provenance.sourceVersion`);
  if ((envelope.availability === 'UNKNOWN' || envelope.availability === 'UNAVAILABLE') && envelope.data !== null) {
    throw new Error(`${name} unavailable/unknown snapshots must carry data: null`);
  }
  if ((envelope.availability === 'AVAILABLE' || envelope.availability === 'INCOMPLETE') && envelope.data === null) {
    throw new Error(`${name} available/incomplete snapshots must carry data`);
  }
}

function sortDomainArrays(input: WorkbenchOverviewInput): void {
  if (input.market.data) {
    (input.market.data.instruments as MarketSnapshot[]).sort((a, b) =>
      `${a.exchange}:${a.symbol}`.localeCompare(`${b.exchange}:${b.symbol}`));
  }
  if (input.trading.data) {
    (input.trading.data.positions as PositionOverviewRecord[]).sort((a, b) =>
      `${a.exchange}:${a.symbol}`.localeCompare(`${b.exchange}:${b.symbol}`));
    (input.trading.data.orders as OmsOrderSnapshot[]).sort((a, b) => a.orderId.localeCompare(b.orderId));
    (input.trading.data.protectivePlans as PositionPlan[]).sort((a, b) => a.planId.localeCompare(b.planId));
  }
  if (input.research.data) {
    (input.research.data.providers as ResearchProviderStatus[]).sort((a, b) => a.providerId.localeCompare(b.providerId));
    (input.research.data.evidence as ResearchEvidenceSummary[]).sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
    (input.research.data.jobs as ReadOnlyResearchJobStatus[]).sort((a, b) => a.jobId.localeCompare(b.jobId));
  }
  if (input.activity.data) {
    (input.activity.data.events as ObservableAgentEvent[]).sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId));
  }
}

/**
 * Build the top-level V1 read model from already-authoritative facts.
 *
 * The only transformations are defensive cloning, deterministic presentation
 * ordering, validation of provenance/unknown semantics, and deep freezing.
 */
export function createWorkbenchOverviewSnapshot(
  source: WorkbenchOverviewInput,
): WorkbenchOverviewSnapshot {
  assertTimestamp(source.capturedAt, 'capturedAt');
  for (const [name, envelope] of Object.entries(source)) {
    if (name === 'capturedAt') continue;
    validateEnvelope(name, envelope as ReadOnlySnapshot<unknown>);
  }

  const copied = clone(source);
  sortDomainArrays(copied);
  return deepFreeze({
    schemaVersion: '1.0',
    kind: 'dsbot.workbench.overview',
    capabilities: {
      canRead: true,
      canTrade: false,
      canMutateRuntime: false,
      canGrantApproval: false,
      canSetLiveReady: false,
    },
    ...copied,
  });
}
