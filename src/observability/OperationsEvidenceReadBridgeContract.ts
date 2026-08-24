/**
 * Phase 8B — Operations Evidence Read Bridge contract.
 *
 * This module freezes the OBSERVATIONAL-ONLY boundary that will later connect
 * already-existing engineering/runtime observability evidence (external Hermes
 * process/log/runtime state, git workspace, filesystem, process/port, Project
 * Control Center, and observable agent events) into the Workbench Operations
 * domain. It is an EVIDENCE PLANE, never a CONTROL PLANE.
 *
 * It defines no runtime wiring, no network I/O, no polling, and no trading
 * side effects. It only freezes:
 *   - plane identity (evidence, not control)
 *   - the authority map (observational evidence vs trading authority)
 *   - the one-way allowed data flow and its forbidden reverse edges
 *   - source classifications
 *   - lifecycle ownership (exactly one bridge per AppGateway, not a second runtime)
 *   - source-failure semantics (degrade to UNKNOWN/UNAVAILABLE, never healthy/zero)
 *   - the secret/redaction boundary
 *   - the read-only Workbench boundary
 *   - implementation acceptance criteria
 *
 * Phase 8B implementation is a separate, later authorized change.
 */

import type { ObservableAgentEvent } from './contracts';
import type { CoordinatorSnapshot } from '../hermes/types';
import type { ProjectControlCenterSnapshot } from './project-control-center';

/**
 * External Hermes runtime evidence — observational engineering facts only.
 *
 * This type is intentionally DISTINCT from `CoordinatorSnapshot`. External
 * Hermes runtime observations (process existence, pid, gateway state file,
 * listening port, health endpoint, logs) may appear in Operations, but they
 * MUST NOT overwrite or masquerade as HandshakeCoordinator health, lifecycle
 * state, or authorization. Do not overload `CoordinatorSnapshot`.
 */
export interface HermesRuntimeEvidence {
  readonly observed: true;
  readonly source: 'OBSERVED_SOURCE_ONLY';
  readonly process?: {
    readonly pid?: number;
    readonly alive?: boolean;
  };
  readonly gateway?: {
    readonly state?: string;
    readonly activeAgents?: number;
    readonly restartRequested?: boolean;
    readonly updatedAt?: string;
  };
  readonly ports?: ReadonlyArray<{
    readonly host: string;
    readonly port: number;
    readonly listening: boolean;
  }>;
  readonly health?: {
    readonly url: string;
    readonly ok: boolean;
    readonly status?: number;
  };
  readonly authoritativeForHandshakeHealth: false;
  readonly authoritativeForLiveReady: false;
  readonly authoritativeForTrading: false;
}

export const OPERATIONS_EVIDENCE_PLANE = Object.freeze({
  readOnly: true,
  isEvidencePlane: true,
  isControlPlane: false,
  tradingAuthority: false,
  canObserve: true,
  canAuthorize: false,
  canExecute: false,
  canMutateTrading: false,
} as const);

export const HERMES_AUTHORITY = Object.freeze({
  handshakeCoordinator: 'HandshakeCoordinator',
  externalRuntime: 'OBSERVED_SOURCE_ONLY',
} as const);

export const PROJECT_CONTROL_CENTER_BOUNDARY = Object.freeze({
  domain: 'operations',
  readOnlyDashboard: true,
  dashboardGrantsApproval: false,
  tradingEnvironmentActivated: false,
  ciPassAuthorizesLive: false,
  prMergedPromotesStrategy: false,
  dashboardReadyAuthorizesLiveReady: false,
} as const);

export interface AuthorityClassification {
  readonly fact: string;
  readonly authority: string;
  readonly domain: string;
  readonly tradingAuthority: boolean;
}

/**
 * Authority classification frozen for Phase 8B.
 *
 * The last six entries (market, position, order, accounting, recovery,
 * reconciliation) plus LIVE_READY are TRADING authority. The Operations
 * Evidence Bridge MUST NOT change their assignment.
 */
export const OPERATIONS_EVIDENCE_AUTHORITY_MAP: readonly AuthorityClassification[] = Object.freeze([
  Object.freeze({
    fact: 'Hermes handshake/coordinator state',
    authority: 'HandshakeCoordinator',
    domain: 'runtime/operations',
    tradingAuthority: false,
  }),
  Object.freeze({
    fact: 'external Hermes process/log/runtime evidence',
    authority: 'OBSERVED_SOURCE_ONLY',
    domain: 'operations',
    tradingAuthority: false,
  }),
  Object.freeze({
    fact: 'git branch/head/worktree/PR/CI evidence',
    authority: 'ProjectControlCenter / inspected repository state',
    domain: 'operations-engineering-evidence',
    tradingAuthority: false,
  }),
  Object.freeze({
    fact: 'ObservableAgentEvent',
    authority: 'observational event record',
    domain: 'operations/activity',
    tradingAuthority: false,
  }),
  Object.freeze({ fact: 'market', authority: 'KernelMarketStateStore', domain: 'trading', tradingAuthority: true }),
  Object.freeze({ fact: 'position', authority: 'KernelPositionStateStore', domain: 'trading', tradingAuthority: true }),
  Object.freeze({ fact: 'order', authority: 'OmsOrderStore', domain: 'trading', tradingAuthority: true }),
  Object.freeze({ fact: 'accounting', authority: 'RuntimeAccounting', domain: 'trading', tradingAuthority: true }),
  Object.freeze({ fact: 'recovery', authority: 'RecoveryManager / owner spine evidence', domain: 'trading', tradingAuthority: true }),
  Object.freeze({ fact: 'reconciliation', authority: 'ReconciliationReport / owner spine', domain: 'trading', tradingAuthority: true }),
  Object.freeze({ fact: 'LIVE_READY', authority: 'ProductionSpine safety gate', domain: 'trading', tradingAuthority: true }),
]);

export const OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW = Object.freeze({
  externalOrReadSourceToWorkbench: true,
  workbenchToSourceControl: false,
  workbenchToCommandExecution: false,
  workbenchToTradingControl: false,
  bridgeToProductionSpineMutation: false,
  bridgeToOmsMutation: false,
  bridgeToRiskMutation: false,
  bridgeToRecoveryMutation: false,
  bridgeToReconciliationMutation: false,
  bridgeToLiveReadyMutation: false,
} as const);

/**
 * Capability names that the bridge contract must never export or expose
 * through the Workbench / Operations surface. No generic command RPC.
 */
export const FORBIDDEN_OPERATIONS_BRIDGE_CAPABILITIES: readonly string[] = Object.freeze([
  'startAgent',
  'stopAgent',
  'restartHermes',
  'runCommand',
  'writeFile',
  'deleteFile',
  'gitCommit',
  'gitPush',
  'mergePR',
  'submitOrder',
  'retryOrder',
  'cancelOrder',
  'closePosition',
  'reconcile',
  'activateLive',
  'setLiveReady',
  'grantApproval',
  'mutateRisk',
  'mutateRuntime',
  'startProcess',
  'killProcess',
]);

export interface SourceClassification {
  readonly source: string;
  readonly kind: 'OBSERVED_PROCESS_STATE' | 'OBSERVED_LOG' | 'OBSERVED_REPOSITORY_STATE' | 'OBSERVED_FILESYSTEM_STATE' | 'OBSERVED_AGENT_ACTIVITY';
  readonly tradingAuthority: false;
}

export const OPERATIONS_EVIDENCE_SOURCE_CLASSIFICATIONS: readonly SourceClassification[] = Object.freeze([
  Object.freeze({ source: 'hermes-runtime', kind: 'OBSERVED_PROCESS_STATE', tradingAuthority: false }),
  Object.freeze({ source: 'hermes-log', kind: 'OBSERVED_LOG', tradingAuthority: false }),
  Object.freeze({ source: 'git', kind: 'OBSERVED_REPOSITORY_STATE', tradingAuthority: false }),
  Object.freeze({ source: 'filesystem', kind: 'OBSERVED_FILESYSTEM_STATE', tradingAuthority: false }),
  Object.freeze({ source: 'process', kind: 'OBSERVED_PROCESS_STATE', tradingAuthority: false }),
  Object.freeze({ source: 'activity', kind: 'OBSERVED_AGENT_ACTIVITY', tradingAuthority: false }),
]);

export const OPERATIONS_EVIDENCE_FAILURE_SEMANTICS = Object.freeze({
  sourceFailureConvertsToHealthy: false,
  missingProcessEvidenceConvertsToHealthy: false,
  missingEventsConvertToZeroRisk: false,
  sourceFailureGrantsLiveReady: false,
  sourceFailureRevokesFactualLiveReady: false,
  sourceFailureMutatesTradingAuthority: false,
  sourceFailureMutatesProductionRuntimeOwner: false,
  sourceFailureSubmitsOrders: false,
  sourceFailureTriggersRecovery: false,
  sourceFailureTriggersReconciliation: false,
  sourceFailureStartsOrStopsTrading: false,
  allowedDegradedAvailability: ['UNAVAILABLE', 'INCOMPLETE', 'STALE', 'UNKNOWN'],
} as const);

export const OPERATIONS_EVIDENCE_REDACTION = Object.freeze({
  mayObserveExistenceOrStatus: true,
  mayNotPublishSecretValue: true,
  rawEvidenceRequiresNormalizationBeforePublication: true,
  forbiddenSecretKinds: Object.freeze([
    'exchange API secrets',
    'private keys',
    'HERMES_BRIDGE_TOKEN',
    'OpenAI/Anthropic API keys',
    'database credentials',
    'wallet secrets',
    'authentication headers',
    'cookies',
  ]),
} as const);

export const OPERATIONS_EVIDENCE_LIFECYCLE = Object.freeze({
  owner: 'AppGateway',
  bridgesPerAppGateway: 1,
  isSecondRuntime: false,
  ownsTradingState: false,
  startupIdempotent: true,
  shutdownIdempotent: true,
  bounded: true,
  noOrphanPollingTimers: true,
  noDuplicateAdapterSubscriptions: true,
} as const);

export const OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY = Object.freeze({
  readOnly: true,
  allowedHttpMethods: Object.freeze(['GET']),
  mutationMethodsAdded: false,
  controlEndpointsAdded: false,
  unknownIsHealthy: false,
  unavailableIsEmpty: false,
  missingIsZero: false,
} as const);

export const OPERATIONS_EVIDENCE_CANONICAL_EVENT = 'ObservableAgentEvent' as const;

export const OPERATIONS_EVIDENCE_EVENT_AGGREGATION = Object.freeze({
  boundedRecentRetention: true,
  stableOrdering: true,
  explicitEventIdentity: true,
  noDuplicatePublicationOnUnchangedState: true,
  sourceProvenanceRetained: true,
  noFabricatedTimestamps: true,
  reconnectDoesNotConvertOldEvidenceToCurrent: true,
} as const);

export const OPERATIONS_EVIDENCE_READ_BRIDGE_ACCEPTANCE_CRITERIA: readonly string[] = Object.freeze([
  'one Operations Evidence Bridge owned by AppGateway; never a second runtime',
  'bridge is observational-only; no trading authority, no order mutation',
  'external Hermes runtime evidence never overwrites HandshakeCoordinator authority',
  'source failure degrades to UNKNOWN/UNAVAILABLE/INCOMPLETE, never healthy/zero',
  'raw evidence passes through normalization/redaction before publication',
  'ObservableAgentEvent remains the canonical activity event envelope',
  'Workbench /api/workbench/v1 stays GET-only; no mutation or control endpoints',
  'Project Control Center remains Operations engineering evidence with fail-closed approvals',
]);

export interface OperationsEvidenceReadBridgeContract {
  readonly phase: '8B';
  readonly delivery: 'CONTRACT_ONLY';
  readonly plane: 'EVIDENCE_PLANE';
  readonly readOnly: true;
  readonly isControlPlane: false;
  readonly tradingAuthority: false;
  readonly canObserve: true;
  readonly canAuthorize: false;
  readonly canExecute: false;
  readonly canMutateTrading: false;
  readonly externalHermesRuntimeIsHandshakeCoordinator: false;
  readonly externalHermesRuntimeAuthority: 'OBSERVED_SOURCE_ONLY';
  readonly handshakeCoordinatorAuthority: 'HandshakeCoordinator';
  readonly projectControlCenterDomain: 'operations';
  readonly projectControlCenterReadOnlyDashboard: true;
  readonly projectControlCenterGrantsApproval: false;
  readonly projectControlCenterTradingEnvironmentActivated: false;
  readonly canonicalActivityEvent: 'ObservableAgentEvent';
  readonly rawEvidenceRequiresNormalizationBeforePublication: true;
  readonly mayPublishSecretValue: false;
  readonly sourceFailureConvertsToHealthy: false;
  readonly sourceFailureGrantsLiveReady: false;
  readonly sourceFailureMutatesTradingAuthority: false;
  readonly workbenchAllowedHttpMethods: readonly ['GET'];
  readonly bridgesPerAppGateway: 1;
  readonly bridgeIsSecondRuntime: false;
  readonly bridgeOwnsTradingState: false;
  readonly bridgeForbiddenCapabilities: readonly string[];
}

export const OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT: OperationsEvidenceReadBridgeContract = Object.freeze({
  phase: '8B',
  delivery: 'CONTRACT_ONLY',
  plane: 'EVIDENCE_PLANE',
  readOnly: true,
  isControlPlane: false,
  tradingAuthority: false,
  canObserve: true,
  canAuthorize: false,
  canExecute: false,
  canMutateTrading: false,
  externalHermesRuntimeIsHandshakeCoordinator: false,
  externalHermesRuntimeAuthority: 'OBSERVED_SOURCE_ONLY',
  handshakeCoordinatorAuthority: 'HandshakeCoordinator',
  projectControlCenterDomain: 'operations',
  projectControlCenterReadOnlyDashboard: true,
  projectControlCenterGrantsApproval: false,
  projectControlCenterTradingEnvironmentActivated: false,
  canonicalActivityEvent: 'ObservableAgentEvent',
  rawEvidenceRequiresNormalizationBeforePublication: true,
  mayPublishSecretValue: false,
  sourceFailureConvertsToHealthy: false,
  sourceFailureGrantsLiveReady: false,
  sourceFailureMutatesTradingAuthority: false,
  workbenchAllowedHttpMethods: Object.freeze(['GET'] as const),
  bridgesPerAppGateway: 1,
  bridgeIsSecondRuntime: false,
  bridgeOwnsTradingState: false,
  bridgeForbiddenCapabilities: FORBIDDEN_OPERATIONS_BRIDGE_CAPABILITIES,
});

/** Fail closed if a future composition plan weakens any Phase 8B invariant. */
export function assertOperationsEvidenceReadBridgeContract(
  value: OperationsEvidenceReadBridgeContract,
): void {
  const violations: string[] = [];
  if (value.phase !== '8B') violations.push('Phase 8B contract phase must be 8B');
  if (value.delivery !== 'CONTRACT_ONLY') violations.push('Phase 8B cannot claim implementation delivery');
  if (value.plane !== 'EVIDENCE_PLANE' || value.isControlPlane !== false) {
    violations.push('Phase 8B bridge must be an evidence plane, not a control plane');
  }
  if (!value.readOnly || value.tradingAuthority || !value.canObserve) {
    violations.push('Phase 8B bridge is read-only observational evidence with no trading authority');
  }
  if (value.canAuthorize || value.canExecute || value.canMutateTrading) {
    violations.push('Phase 8B bridge cannot authorize, execute, or mutate trading');
  }
  if (value.externalHermesRuntimeIsHandshakeCoordinator !== false) {
    violations.push('external Hermes runtime evidence cannot masquerade as HandshakeCoordinator');
  }
  if (value.externalHermesRuntimeAuthority !== 'OBSERVED_SOURCE_ONLY') {
    violations.push('external Hermes runtime evidence authority must be OBSERVED_SOURCE_ONLY');
  }
  if (value.handshakeCoordinatorAuthority !== 'HandshakeCoordinator') {
    violations.push('HandshakeCoordinator remains the sole handshake authority');
  }
  if (value.projectControlCenterDomain !== 'operations') {
    violations.push('Project Control Center must remain Operations evidence');
  }
  if (
    !value.projectControlCenterReadOnlyDashboard
    || value.projectControlCenterGrantsApproval
    || value.projectControlCenterTradingEnvironmentActivated
  ) {
    violations.push('Project Control Center must remain read-only, fail-closed on approval, and trading-environment-inactive');
  }
  if (value.canonicalActivityEvent !== 'ObservableAgentEvent') {
    violations.push('ObservableAgentEvent must remain the canonical activity event envelope');
  }
  if (!value.rawEvidenceRequiresNormalizationBeforePublication || value.mayPublishSecretValue) {
    violations.push('raw evidence must be normalized/redacted before publication');
  }
  if (value.sourceFailureConvertsToHealthy || value.sourceFailureGrantsLiveReady || value.sourceFailureMutatesTradingAuthority) {
    violations.push('source failure must degrade to unknown/unavailable, never healthy or trading authority');
  }
  if (value.workbenchAllowedHttpMethods.length !== 1 || value.workbenchAllowedHttpMethods[0] !== 'GET') {
    violations.push('Workbench must remain GET-only');
  }
  if (value.bridgesPerAppGateway !== 1 || value.bridgeIsSecondRuntime || value.bridgeOwnsTradingState) {
    violations.push('exactly one bridge per AppGateway; it is not a second runtime and owns no trading state');
  }
  const missingForbidden = FORBIDDEN_OPERATIONS_BRIDGE_CAPABILITIES.filter(
    (capability) => value.bridgeForbiddenCapabilities.includes(capability) === false,
  );
  if (value.bridgeForbiddenCapabilities.length === 0 || missingForbidden.length > 0) {
    violations.push(`bridge must forbid all control capabilities (missing: ${missingForbidden.join(', ') || 'none listed'})`);
  }
  if (violations.length > 0) throw new Error(`PHASE_8B_CONTRACT_VIOLATION: ${violations.join('; ')}`);
}

/** Type-level guard references retained for the authority boundary documentation. */
export type OperationsEvidenceCoordinatorSnapshot = CoordinatorSnapshot;
export type OperationsEvidenceProjectControlCenterSnapshot = ProjectControlCenterSnapshot;
export type OperationsEvidenceCanonicalEvent = ObservableAgentEvent;
