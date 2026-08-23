import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  FORBIDDEN_OPERATIONS_BRIDGE_CAPABILITIES,
  HERMES_AUTHORITY,
  OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW,
  OPERATIONS_EVIDENCE_AUTHORITY_MAP,
  OPERATIONS_EVIDENCE_CANONICAL_EVENT,
  OPERATIONS_EVIDENCE_EVENT_AGGREGATION,
  OPERATIONS_EVIDENCE_FAILURE_SEMANTICS,
  OPERATIONS_EVIDENCE_LIFECYCLE,
  OPERATIONS_EVIDENCE_PLANE,
  OPERATIONS_EVIDENCE_READ_BRIDGE_ACCEPTANCE_CRITERIA,
  OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT,
  OPERATIONS_EVIDENCE_REDACTION,
  OPERATIONS_EVIDENCE_SOURCE_CLASSIFICATIONS,
  OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY,
  PROJECT_CONTROL_CENTER_BOUNDARY,
  assertOperationsEvidenceReadBridgeContract,
  type OperationsEvidenceReadBridgeContract,
} from '../../src/observability/OperationsEvidenceReadBridgeContract';
import * as contractModule from '../../src/observability/OperationsEvidenceReadBridgeContract';

function weakened(
  patch: Partial<Record<keyof OperationsEvidenceReadBridgeContract, unknown>>,
): OperationsEvidenceReadBridgeContract {
  return { ...OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT, ...patch } as OperationsEvidenceReadBridgeContract;
}

function authority(fact: string) {
  const entry = OPERATIONS_EVIDENCE_AUTHORITY_MAP.find((item) => item.fact === fact);
  assert.ok(entry, `authority map missing fact: ${fact}`);
  return entry!;
}

describe('Phase 8B Operations Evidence Read Bridge contract', () => {
  it('is an observational read-only evidence plane with no trading authority', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.readOnly, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.isEvidencePlane, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.isControlPlane, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.tradingAuthority, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.canObserve, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.canAuthorize, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.canExecute, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_PLANE.canMutateTrading, false);
  });

  it('keeps Project Control Center an Operations-only fail-closed engineering domain', () => {
    assert.strictEqual(PROJECT_CONTROL_CENTER_BOUNDARY.domain, 'operations');
    assert.strictEqual(PROJECT_CONTROL_CENTER_BOUNDARY.readOnlyDashboard, true);
    assert.strictEqual(PROJECT_CONTROL_CENTER_BOUNDARY.dashboardGrantsApproval, false);
    assert.strictEqual(PROJECT_CONTROL_CENTER_BOUNDARY.tradingEnvironmentActivated, false);
    assert.strictEqual(PROJECT_CONTROL_CENTER_BOUNDARY.ciPassAuthorizesLive, false);
    assert.strictEqual(PROJECT_CONTROL_CENTER_BOUNDARY.prMergedPromotesStrategy, false);
    assert.strictEqual(PROJECT_CONTROL_CENTER_BOUNDARY.dashboardReadyAuthorizesLiveReady, false);
  });

  it('distinguishes external Hermes runtime evidence from HandshakeCoordinator authority', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT.externalHermesRuntimeIsHandshakeCoordinator, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT.externalHermesRuntimeAuthority, 'OBSERVED_SOURCE_ONLY');
    assert.strictEqual(OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT.handshakeCoordinatorAuthority, 'HandshakeCoordinator');
    assert.strictEqual(HERMES_AUTHORITY.externalRuntime, 'OBSERVED_SOURCE_ONLY');
    assert.strictEqual(HERMES_AUTHORITY.handshakeCoordinator, 'HandshakeCoordinator');
    assert.notStrictEqual(HERMES_AUTHORITY.externalRuntime, HERMES_AUTHORITY.handshakeCoordinator);
  });

  it('freezes the authority map without reassigning any trading fact', () => {
    for (const tradingFact of ['market', 'position', 'order', 'accounting', 'recovery', 'reconciliation', 'LIVE_READY']) {
      assert.strictEqual(authority(tradingFact).tradingAuthority, true, `${tradingFact} must remain trading authority`);
    }
    assert.strictEqual(authority('LIVE_READY').authority, 'ProductionSpine safety gate');
    assert.strictEqual(authority('recovery').authority, 'RecoveryManager / owner spine evidence');
    assert.strictEqual(authority('reconciliation').authority, 'ReconciliationReport / owner spine');
    for (const observedFact of [
      'external Hermes process/log/runtime evidence',
      'git branch/head/worktree/PR/CI evidence',
      'ObservableAgentEvent',
    ]) {
      assert.strictEqual(authority(observedFact).tradingAuthority, false, `${observedFact} is observational only`);
    }
  });

  it('cannot grant LIVE_READY, modify recovery/reconciliation, or submit/retry/cancel/close orders', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureGrantsLiveReady, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureTriggersRecovery, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureTriggersReconciliation, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureSubmitsOrders, false);
    for (const forbidden of ['submitOrder', 'retryOrder', 'cancelOrder', 'closePosition', 'reconcile', 'activateLive', 'setLiveReady']) {
      assert.ok(FORBIDDEN_OPERATIONS_BRIDGE_CAPABILITIES.includes(forbidden), `${forbidden} must be forbidden`);
    }
    assert.strictEqual(OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW.bridgeToLiveReadyMutation, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW.bridgeToRecoveryMutation, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW.bridgeToReconciliationMutation, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW.bridgeToOmsMutation, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW.bridgeToRiskMutation, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW.workbenchToCommandExecution, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_ALLOWED_DATA_FLOW.workbenchToSourceControl, false);
  });

  it('exports no control-capability name from the bridge contract module', () => {
    const runtimeExports = Object.keys(contractModule).sort();
    for (const capability of FORBIDDEN_OPERATIONS_BRIDGE_CAPABILITIES) {
      assert.ok(!runtimeExports.includes(capability), `bridge contract must not export ${capability}`);
    }
    // Read-only evidence factory names are permitted; mutation/command aliases are not.
    assert.ok(!runtimeExports.some((name) => /^(start|stop|restart|run|write|delete|git|merge|submit|retry|cancel|close|reconcile|activate|set|grant|mutate|kill)/.test(name)));
  });

  it('preserves the GET-only Workbench boundary with no mutation or control endpoints', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY.readOnly, true);
    assert.deepStrictEqual(OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY.allowedHttpMethods, ['GET']);
    assert.strictEqual(OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY.mutationMethodsAdded, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY.controlEndpointsAdded, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY.unknownIsHealthy, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY.unavailableIsEmpty, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_WORKBENCH_BOUNDARY.missingIsZero, false);
  });

  it('never converts missing source evidence into healthy or zero', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureConvertsToHealthy, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.missingProcessEvidenceConvertsToHealthy, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.missingEventsConvertToZeroRisk, false);
    assert.deepStrictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.allowedDegradedAvailability, ['UNAVAILABLE', 'INCOMPLETE', 'STALE', 'UNKNOWN']);
  });

  it('requires normalization/redaction before secret-bearing raw evidence publication', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_REDACTION.mayObserveExistenceOrStatus, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_REDACTION.mayNotPublishSecretValue, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_REDACTION.rawEvidenceRequiresNormalizationBeforePublication, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT.mayPublishSecretValue, false);
    for (const secret of ['exchange API secrets', 'HERMES_BRIDGE_TOKEN', 'private keys', 'wallet secrets']) {
      assert.ok(OPERATIONS_EVIDENCE_REDACTION.forbiddenSecretKinds.includes(secret), `${secret} must be forbidden from publication`);
    }
  });

  it('keeps ObservableAgentEvent as the canonical activity event envelope', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_CANONICAL_EVENT, 'ObservableAgentEvent');
    assert.strictEqual(OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT.canonicalActivityEvent, 'ObservableAgentEvent');
    const source = readFileSync(new URL('../../src/observability/contracts.ts', import.meta.url), 'utf8');
    for (const field of ['schemaVersion', 'eventId', 'runId', 'timestamp', 'actor', 'source', 'action', 'riskClass', 'evidenceLevel', 'commandDigest', 'redactions']) {
      assert.match(source, new RegExp(field), `ObservableAgentEvent must preserve ${field}`);
    }
  });

  it('owns exactly one bridge per AppGateway lifecycle and is not a second runtime', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.owner, 'AppGateway');
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.bridgesPerAppGateway, 1);
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.isSecondRuntime, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.ownsTradingState, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.startupIdempotent, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.shutdownIdempotent, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.noOrphanPollingTimers, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_LIFECYCLE.noDuplicateAdapterSubscriptions, true);
  });

  it('isolates source failure from trading authority', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureMutatesTradingAuthority, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureMutatesProductionRuntimeOwner, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureStartsOrStopsTrading, false);
    assert.strictEqual(OPERATIONS_EVIDENCE_FAILURE_SEMANTICS.sourceFailureRevokesFactualLiveReady, false);
    for (const classification of OPERATIONS_EVIDENCE_SOURCE_CLASSIFICATIONS) {
      assert.strictEqual(classification.tradingAuthority, false, `${classification.source} must be observational`);
    }
  });

  it('freezes deterministic bounded event aggregation semantics', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_EVENT_AGGREGATION.boundedRecentRetention, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_EVENT_AGGREGATION.stableOrdering, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_EVENT_AGGREGATION.explicitEventIdentity, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_EVENT_AGGREGATION.noDuplicatePublicationOnUnchangedState, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_EVENT_AGGREGATION.sourceProvenanceRetained, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_EVENT_AGGREGATION.noFabricatedTimestamps, true);
    assert.strictEqual(OPERATIONS_EVIDENCE_EVENT_AGGREGATION.reconnectDoesNotConvertOldEvidenceToCurrent, true);
  });

  it('accepts the frozen contract and rejects every weakened variant', () => {
    assert.doesNotThrow(() => assertOperationsEvidenceReadBridgeContract(OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT));

    for (const patch of [
      { delivery: 'IMPLEMENTATION' },
      { plane: 'CONTROL_PLANE' },
      { isControlPlane: true },
      { readOnly: false },
      { tradingAuthority: true },
      { canObserve: false },
      { canAuthorize: true },
      { canExecute: true },
      { canMutateTrading: true },
      { externalHermesRuntimeIsHandshakeCoordinator: true },
      { externalHermesRuntimeAuthority: 'HandshakeCoordinator' },
      { handshakeCoordinatorAuthority: 'OBSERVED_SOURCE_ONLY' },
      { projectControlCenterDomain: 'trading' },
      { projectControlCenterReadOnlyDashboard: false },
      { projectControlCenterGrantsApproval: true },
      { canonicalActivityEvent: 'HermesRuntimeEvidence' },
      { rawEvidenceRequiresNormalizationBeforePublication: false },
      { mayPublishSecretValue: true },
      { sourceFailureConvertsToHealthy: true },
      { sourceFailureGrantsLiveReady: true },
      { sourceFailureMutatesTradingAuthority: true },
      { workbenchAllowedHttpMethods: ['GET', 'POST'] },
      { bridgesPerAppGateway: 2 },
      { bridgeIsSecondRuntime: true },
      { bridgeOwnsTradingState: true },
      { bridgeForbiddenCapabilities: [] },
    ] as Partial<OperationsEvidenceReadBridgeContract>[]) {
      assert.throws(
        () => assertOperationsEvidenceReadBridgeContract(weakened(patch)),
        /PHASE_8B_CONTRACT_VIOLATION/,
      );
    }
  });

  it('documents implementation acceptance criteria without claiming implementation', () => {
    assert.strictEqual(OPERATIONS_EVIDENCE_READ_BRIDGE_CONTRACT.delivery, 'CONTRACT_ONLY');
    assert.ok(OPERATIONS_EVIDENCE_READ_BRIDGE_ACCEPTANCE_CRITERIA.length >= 8);
    assert.ok(OPERATIONS_EVIDENCE_READ_BRIDGE_ACCEPTANCE_CRITERIA.every((criterion) => criterion.trim().length > 0));
  });
});
